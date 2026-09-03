import { URL, URLSearchParams } from 'node:url';
import { TextDecoder } from 'node:util';

export const MAX_SCANNABLE_BYTES = 2 * 1024 * 1024;
export const MAX_RETAINED_RESULTS = 32;
const MAX_DATABASE_URL_LENGTH = 8 * 1024;
const MAX_DATABASE_URL_CANDIDATES = 1024;
const MAX_DATABASE_URL_CANDIDATE_BYTES = 8 * 1024 * 1024;
const MAX_DATABASE_URL_TEXT_CONTEXTS = 1024;

const ARCHIVE_SUFFIXES = Object.freeze([
  '.tar.gz',
  '.zip',
  '.tar',
  '.tgz',
  '.gz',
  '.bz2',
  '.xz',
  '.zst',
  '.7z',
  '.rar',
]);
const BINARY_SUFFIXES = Object.freeze([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
]);
const SAFE_PROVIDER_VALUES = new Set([
  'sk_live_never_allowed',
  'whsec_test_only_secret',
  'AKIAIOSFODNN7EXAMPLE',
]);
const SAFE_DATABASE_PASSWORDS = new Set(['local-only-placeholder', 'replace_me_local_password']);
const SAFE_COMPOSE_DATABASE_USERINFO =
  '${POSTGRES_USER:-booking_engine_local}:${POSTGRES_PASSWORD:-local-only-placeholder}';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const SECRET_PATTERNS = Object.freeze([
  {
    name: 'private-key-block',
    expression: /-----BEGIN (?:(?:ENCRYPTED|DSA|RSA|EC|OPENSSH) )?PRIVATE KEY-----/gu,
  },
  {
    name: 'live-provider-key',
    expression: /\b(?:sk|rk)_live_[A-Za-z0-9_-]{8,}/gu,
  },
  {
    name: 'provider-webhook-secret',
    expression: /\bwhsec_[A-Za-z0-9_-]{8,}/gu,
  },
  {
    name: 'cloud-access-key',
    expression: /\bAKIA[0-9A-Z]{16}\b/gu,
  },
]);
const DATABASE_URL_SCHEME_EXPRESSION = /postgres(?:ql)?:\/\//giu;
const DATABASE_URL_TERMINATOR_EXPRESSION = /["`<>]/u;
const DATABASE_URL_VALUE_SCHEME_EXPRESSION = /postgres(?:ql)?:\/\//iu;
const DATABASE_URL_SCHEME_PREFIX_EXPRESSION = /^postgres(?:ql)?:/iu;

function hasSuffix(file, suffixes) {
  const normalizedFile = file.toLowerCase();
  return suffixes.some((suffix) => normalizedFile.endsWith(suffix));
}

function decodedUrlPassword(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function credentialMarkerView(value) {
  return value.replace(/%3a/giu, ':').replace(/%40/giu, '@');
}

function hasOuterDatabaseAuthorityPassword(value) {
  const markerView = credentialMarkerView(value);
  const authorityStart = markerView.indexOf('://') + 3;
  const userInfoEnd = markerView.lastIndexOf('@');
  const passwordStart = markerView.indexOf(':', authorityStart);
  const nestedSchemeOffset = markerView
    .slice(authorityStart)
    .search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
  const nestedSchemeStart =
    nestedSchemeOffset === -1 ? markerView.length : authorityStart + nestedSchemeOffset;
  return (
    userInfoEnd !== -1 &&
    passwordStart !== -1 &&
    passwordStart + 1 < userInfoEnd &&
    passwordStart < nestedSchemeStart
  );
}

function classifyEmbeddedSchemeAuthorityPassword(value) {
  const markerView = credentialMarkerView(value);
  const authorityStart = markerView.indexOf('://') + 3;
  const userInfoEnd = markerView.lastIndexOf('@');
  const passwordStart = markerView.indexOf(':', authorityStart);
  if (userInfoEnd === -1 || passwordStart === -1 || passwordStart + 1 >= userInfoEnd) {
    return null;
  }

  const password = decodedUrlPassword(markerView.slice(passwordStart + 1, userInfoEnd));
  if (password === null) {
    return null;
  }
  const embeddedSchemeStart = password.search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
  if (embeddedSchemeStart === -1 || /[/?#&=]/u.test(password.slice(0, embeddedSchemeStart))) {
    return null;
  }
  return SAFE_DATABASE_PASSWORDS.has(password);
}

function hasExactComposeDatabaseCredentials(value) {
  const authorityStart = value.indexOf('://') + 3;
  let authorityEnd = value.length;
  for (const delimiter of ['/', '?', '#']) {
    const delimiterIndex = value.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1 && delimiterIndex < authorityEnd) {
      authorityEnd = delimiterIndex;
    }
  }

  const userInfoEnd = value.lastIndexOf('@', authorityEnd - 1);
  if (
    userInfoEnd === -1 ||
    value.slice(authorityStart, userInfoEnd) !== SAFE_COMPOSE_DATABASE_USERINFO
  ) {
    return false;
  }

  const markerView = credentialMarkerView(value);
  return markerView.indexOf('@') === markerView.lastIndexOf('@');
}

function classifyMalformedDatabaseUrl(value) {
  if (value.length > MAX_DATABASE_URL_LENGTH) {
    return false;
  }
  const rawAuthorityStart = value.indexOf('://') + 3;
  const rawNestedSchemeOffset = value
    .slice(rawAuthorityStart)
    .search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
  const rawNestedSchemeStart =
    rawNestedSchemeOffset === -1 ? value.length : rawAuthorityStart + rawNestedSchemeOffset;

  let hasPassword = false;
  let isPlaceholder = true;

  if (hasExactComposeDatabaseCredentials(value)) {
    hasPassword = true;
  } else {
    const markerView = credentialMarkerView(value);
    const authorityStart = markerView.indexOf('://') + 3;
    const userInfoEnd = markerView.lastIndexOf('@');
    const passwordStart = markerView.indexOf(':', authorityStart);
    const nestedSchemeOffset = markerView
      .slice(authorityStart)
      .search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
    const nestedSchemeStart =
      nestedSchemeOffset === -1 ? markerView.length : authorityStart + nestedSchemeOffset;
    if (
      userInfoEnd !== -1 &&
      passwordStart !== -1 &&
      passwordStart + 1 < userInfoEnd &&
      passwordStart < nestedSchemeStart
    ) {
      hasPassword = true;
      const password = decodedUrlPassword(markerView.slice(passwordStart + 1, userInfoEnd));
      isPlaceholder = password !== null && SAFE_DATABASE_PASSWORDS.has(password);
    }
  }

  const queryStart = value.indexOf('?');
  if (queryStart !== -1 && queryStart < rawNestedSchemeStart) {
    const fragmentStart = value.indexOf('#', queryStart + 1);
    const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
    const query = value.slice(queryStart + 1, queryEnd);
    for (const [key, password] of new URLSearchParams(query)) {
      if (key !== 'password' || password === '') {
        continue;
      }
      hasPassword = true;
      isPlaceholder = isPlaceholder && SAFE_DATABASE_PASSWORDS.has(password);
    }
  }

  return hasPassword ? isPlaceholder : null;
}

function classifyDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return classifyMalformedDatabaseUrl(value);
  }

  let hasPassword = false;
  let isPlaceholder = true;

  if (hasExactComposeDatabaseCredentials(value)) {
    hasPassword = true;
  } else if (url.password !== '' && hasOuterDatabaseAuthorityPassword(value)) {
    hasPassword = true;
    const password = decodedUrlPassword(url.password);
    isPlaceholder = password !== null && SAFE_DATABASE_PASSWORDS.has(password);
  } else {
    const embeddedSchemePassword = classifyEmbeddedSchemeAuthorityPassword(value);
    if (embeddedSchemePassword !== null) {
      hasPassword = true;
      isPlaceholder = embeddedSchemePassword;
    }
  }

  for (const [key, password] of url.searchParams) {
    if (key !== 'password' || password === '') {
      continue;
    }
    hasPassword = true;
    isPlaceholder = isPlaceholder && SAFE_DATABASE_PASSWORDS.has(password);
  }

  return hasPassword ? isPlaceholder : null;
}

function uninspectable(candidate, name) {
  return {
    findings: [{ file: candidate.file, line: null, name, tracked: candidate.tracked }],
    placeholders: [],
    inspected: false,
    totalFindings: 1,
    totalPlaceholders: 0,
    truncatedFindings: 0,
    truncatedPlaceholders: 0,
  };
}

function compareMatches(left, right) {
  return left.index - right.index || left.patternOrder - right.patternOrder;
}

function retainEarliestMatch(matches, match) {
  if (matches.length < MAX_RETAINED_RESULTS) {
    matches.push(match);
    matches.sort(compareMatches);
    return;
  }

  if (compareMatches(match, matches[matches.length - 1]) >= 0) {
    return;
  }
  matches[matches.length - 1] = match;
  matches.sort(compareMatches);
}

function isDatabaseUrlWhitespaceOrControl(character) {
  const characterCode = character.charCodeAt(0);
  return (
    characterCode <= 0x1f ||
    characterCode === 0x7f ||
    (characterCode >= 0x80 && characterCode <= 0x9f) ||
    /\s/u.test(character)
  );
}

function hasIncompleteDatabasePasswordMarker(value) {
  const markerView = credentialMarkerView(value);
  const authorityStart = markerView.indexOf('://') + 3;
  let authorityEnd = markerView.length;
  const nestedSchemeOffset = markerView
    .slice(authorityStart)
    .search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
  const nestedSchemeStart =
    nestedSchemeOffset === -1 ? markerView.length : authorityStart + nestedSchemeOffset;
  for (const delimiter of ['/', '?', '#']) {
    const delimiterIndex = markerView.indexOf(delimiter, authorityStart);
    if (delimiterIndex !== -1 && delimiterIndex < authorityEnd) {
      authorityEnd = delimiterIndex;
    }
  }
  if (
    markerView.slice(authorityStart, authorityEnd).endsWith(':') &&
    authorityEnd - 1 < nestedSchemeStart
  ) {
    return true;
  }

  const queryStart = value.indexOf('?');
  const rawAuthorityStart = value.indexOf('://') + 3;
  const rawNestedSchemeOffset = value
    .slice(rawAuthorityStart)
    .search(DATABASE_URL_VALUE_SCHEME_EXPRESSION);
  const rawNestedSchemeStart =
    rawNestedSchemeOffset === -1 ? value.length : rawAuthorityStart + rawNestedSchemeOffset;
  if (queryStart === -1 || queryStart >= rawNestedSchemeStart) {
    return false;
  }
  const fragmentStart = value.indexOf('#', queryStart + 1);
  const queryEnd = fragmentStart === -1 ? value.length : fragmentStart;
  for (const [key, password] of new URLSearchParams(value.slice(queryStart + 1, queryEnd))) {
    if (key === 'password' && password === '') {
      return true;
    }
  }
  return false;
}

function databaseUrlSourceEscape(text, start, limit) {
  if (text[start] !== '\\' || start + 1 >= limit) {
    return { length: 0, invalid: text[start] === '\\' };
  }

  const escapeType = text[start + 1];
  if (escapeType === '\n') {
    return { length: 2, invalid: false };
  }
  if (escapeType === '\r') {
    return {
      length: start + 2 < limit && text[start + 2] === '\n' ? 3 : 2,
      invalid: false,
    };
  }
  if (escapeType !== 'x' && escapeType !== 'u') {
    return { length: 2, invalid: false };
  }

  let digitsStart;
  let digitsEnd;
  let escapeEnd;
  if (escapeType === 'x') {
    digitsStart = start + 2;
    digitsEnd = digitsStart + 2;
    escapeEnd = digitsEnd;
  } else if (text[start + 2] !== '{') {
    digitsStart = start + 2;
    digitsEnd = digitsStart + 4;
    escapeEnd = digitsEnd;
  } else {
    digitsStart = start + 3;
    const closingBraceOffset = text
      .slice(digitsStart, Math.min(limit, digitsStart + 7))
      .indexOf('}');
    const closingBrace = closingBraceOffset === -1 ? -1 : digitsStart + closingBraceOffset;
    if (closingBrace === -1 || closingBrace === digitsStart) {
      return { length: 0, invalid: true };
    }
    digitsEnd = closingBrace;
    escapeEnd = closingBrace + 1;
  }

  if (escapeEnd > limit || !/^[0-9A-Fa-f]+$/u.test(text.slice(digitsStart, digitsEnd))) {
    return { length: 0, invalid: true };
  }
  return { length: escapeEnd - start, invalid: false };
}

function databaseUrlFollowsApostrophe(text, apostropheIndex) {
  const limit = Math.min(text.length, apostropheIndex + 1 + MAX_DATABASE_URL_LENGTH);
  let schemeStart = apostropheIndex + 1;
  while (schemeStart < limit) {
    if (DATABASE_URL_SCHEME_PREFIX_EXPRESSION.test(text.slice(schemeStart, schemeStart + 11))) {
      return { opens: true, invalid: false };
    }
    if (/\s/u.test(text[schemeStart])) {
      schemeStart += 1;
      continue;
    }
    const escape = databaseUrlSourceEscape(text, schemeStart, limit);
    if (escape.invalid) {
      return {
        opens: text.slice(schemeStart, limit).search(DATABASE_URL_VALUE_SCHEME_EXPRESSION) !== -1,
        invalid: true,
      };
    }
    if (escape.length === 0) {
      return { opens: false, invalid: false };
    }
    schemeStart += escape.length;
  }
  return { opens: true, invalid: true };
}

function databaseUrlQuoteSpans(text) {
  const spans = [];
  let openingQuote = null;
  let openingIndex = null;
  let openingAllowsNewline = false;
  let openingInvalidContext = false;
  let escaped = false;

  function recordSpan(start, end, closed, invalidContext) {
    if (spans.length >= MAX_DATABASE_URL_TEXT_CONTEXTS) {
      return false;
    }
    spans.push({ start, end, closed, invalidContext });
    return true;
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const apostropheAfterWord = character === "'" && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? '');
    const databaseStringContext =
      openingQuote === null && apostropheAfterWord
        ? databaseUrlFollowsApostrophe(text, index)
        : { opens: false, invalid: false };
    if (openingQuote === null) {
      if (
        !escaped &&
        (!apostropheAfterWord || databaseStringContext.opens) &&
        (character === '"' || character === "'" || character === '`')
      ) {
        openingQuote = character;
        openingIndex = index;
        openingAllowsNewline = databaseStringContext.opens;
        openingInvalidContext = databaseStringContext.invalid;
        escaped = false;
        continue;
      }
      escaped = character === '\\' ? !escaped : false;
      continue;
    }

    if (
      openingQuote !== '`' &&
      !openingAllowsNewline &&
      (character === '\n' || character === '\r')
    ) {
      if (!recordSpan(openingIndex + 1, index, false, openingInvalidContext)) {
        return { spans, limitExceeded: true };
      }
      openingQuote = null;
      openingIndex = null;
      openingAllowsNewline = false;
      openingInvalidContext = false;
      escaped = false;
      continue;
    }
    if (character === openingQuote && !escaped) {
      if (text[index + 1] === openingQuote) {
        index += 1;
        escaped = false;
        continue;
      }
      if (!recordSpan(openingIndex + 1, index, true, openingInvalidContext)) {
        return { spans, limitExceeded: true };
      }
      openingQuote = null;
      openingIndex = null;
      openingAllowsNewline = false;
      openingInvalidContext = false;
      escaped = false;
      continue;
    }
    escaped = character === '\\' ? !escaped : false;
  }

  if (
    openingQuote !== null &&
    !recordSpan(openingIndex + 1, text.length, false, openingInvalidContext)
  ) {
    return { spans, limitExceeded: true };
  }
  return { spans, limitExceeded: false };
}

function dotenvDatabaseValueStarts(text) {
  const starts = new Set();
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const prefix =
      /^[\t ]*(?:export[\t ]+)?[A-Za-z_][A-Za-z0-9_]*[\t ]*=[\t ]*(?:["'`][\t ]*)?/u.exec(
        text.slice(lineStart, lineEnd),
      );
    if (prefix !== null && !starts.has(lineStart + prefix[0].length)) {
      if (starts.size >= MAX_DATABASE_URL_TEXT_CONTEXTS) {
        return { starts, limitExceeded: true };
      }
      starts.add(lineStart + prefix[0].length);
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }
  return { starts, limitExceeded: false };
}

function trimmedDotenvValueEnd(text, start, end) {
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    end -= 1;
  }
  return end;
}

function trimmedQuotedDatabaseUrlEnd(text, start, end) {
  while (end > start && /\s/u.test(text[end - 1])) {
    end -= 1;
  }
  return end;
}

function dotenvDatabaseValueEnd(text, start, limit) {
  for (let index = start; index < limit; index += 1) {
    const character = text[index];
    const characterCode = text.charCodeAt(index);
    if (
      character === '#' ||
      character === '\n' ||
      character === '\r' ||
      (characterCode <= 0x1f && character !== '\t') ||
      characterCode === 0x7f ||
      (characterCode >= 0x80 && characterCode <= 0x9f)
    ) {
      return trimmedDotenvValueEnd(text, start, index);
    }
  }
  return trimmedDotenvValueEnd(text, start, limit);
}

function databaseUrlEnd(text, start, limit, quotedSpan, dotenvValueStart) {
  if (quotedSpan !== null) {
    return {
      end: trimmedQuotedDatabaseUrlEnd(text, start, quotedSpan.end),
      unclosedQuote: !quotedSpan.closed,
      invalidContext: quotedSpan.invalidContext,
    };
  }

  if (dotenvValueStart) {
    return {
      end: dotenvDatabaseValueEnd(text, start, limit),
      unclosedQuote: false,
      invalidContext: false,
    };
  }

  for (let index = start; index < limit; index += 1) {
    if (
      isDatabaseUrlWhitespaceOrControl(text[index]) ||
      DATABASE_URL_TERMINATOR_EXPRESSION.test(text[index])
    ) {
      return { end: index, unclosedQuote: false, invalidContext: false };
    }
  }
  return { end: limit, unclosedQuote: false, invalidContext: false };
}

function retainedFindings(candidate, text, matches) {
  const findings = [];
  let line = 1;
  let lineOffset = 0;

  for (const match of matches) {
    while (lineOffset < match.index) {
      if (text.charCodeAt(lineOffset) === 10) {
        line += 1;
      } else if (text.charCodeAt(lineOffset) === 13 && text.charCodeAt(lineOffset + 1) !== 10) {
        line += 1;
      }
      lineOffset += 1;
    }

    findings.push({
      file: candidate.file,
      line,
      name: match.name,
      tracked: candidate.tracked,
    });
  }
  return findings;
}

function scanText(candidate, text) {
  const findingMatches = [];
  const placeholderMatches = [];
  let totalFindings = 0;
  let totalPlaceholders = 0;

  function recordMatch(match) {
    if (match.placeholder) {
      totalPlaceholders += 1;
      retainEarliestMatch(placeholderMatches, match);
      return;
    }
    totalFindings += 1;
    retainEarliestMatch(findingMatches, match);
  }

  const databaseUrlMatches = [];
  for (const match of text.matchAll(DATABASE_URL_SCHEME_EXPRESSION)) {
    databaseUrlMatches.push(match);
    if (databaseUrlMatches.length > MAX_DATABASE_URL_CANDIDATES) {
      break;
    }
  }

  for (const [patternOrder, pattern] of SECRET_PATTERNS.entries()) {
    for (const match of text.matchAll(pattern.expression)) {
      recordMatch({
        index: match.index,
        name: pattern.name,
        patternOrder,
        placeholder: SAFE_PROVIDER_VALUES.has(match[0]),
      });
    }
  }

  const firstDatabaseUrlStart = databaseUrlMatches[0]?.index ?? -1;
  const quotedContext =
    firstDatabaseUrlStart === -1
      ? { spans: [], limitExceeded: false }
      : databaseUrlQuoteSpans(text);
  const dotenvContext =
    firstDatabaseUrlStart === -1 || quotedContext.limitExceeded
      ? { starts: new Set(), limitExceeded: false }
      : dotenvDatabaseValueStarts(text);
  const databaseUrlQuotedSpans = quotedContext.spans;
  const dotenvValueStarts = dotenvContext.starts;
  const databaseUrlContextLimitExceeded =
    quotedContext.limitExceeded || dotenvContext.limitExceeded;
  let quotedSpanIndex = 0;
  let databaseUrlTokenEnd = 0;
  let databaseUrlTokenHasUnclosedQuote = false;
  let databaseUrlTokenHasInvalidContext = false;
  let skippedDatabaseUrlTokenEnd = 0;
  let databaseUrlCandidateCount = 0;
  let databaseUrlCandidateBytes = 0;
  for (const match of databaseUrlMatches) {
    if (databaseUrlContextLimitExceeded) {
      recordMatch({
        index: match.index,
        name: 'database-url-context-limit',
        patternOrder: SECRET_PATTERNS.length,
        placeholder: false,
      });
      break;
    }
    if (match.index < skippedDatabaseUrlTokenEnd) {
      continue;
    }
    if (match.index >= databaseUrlTokenEnd) {
      while (
        quotedSpanIndex < databaseUrlQuotedSpans.length &&
        databaseUrlQuotedSpans[quotedSpanIndex].end <= match.index
      ) {
        quotedSpanIndex += 1;
      }
      const possibleQuotedSpan = databaseUrlQuotedSpans[quotedSpanIndex];
      const quotedSpan =
        possibleQuotedSpan !== undefined &&
        possibleQuotedSpan.start <= match.index &&
        match.index < possibleQuotedSpan.end
          ? possibleQuotedSpan
          : null;
      const boundary = databaseUrlEnd(
        text,
        match.index,
        text.length,
        quotedSpan,
        dotenvValueStarts.has(match.index),
      );
      databaseUrlTokenEnd = boundary.end;
      databaseUrlTokenHasUnclosedQuote = boundary.unclosedQuote;
      databaseUrlTokenHasInvalidContext = boundary.invalidContext;
    }

    if (databaseUrlTokenHasInvalidContext) {
      recordMatch({
        index: match.index,
        name: 'database-url-invalid-context',
        patternOrder: SECRET_PATTERNS.length,
        placeholder: false,
      });
      skippedDatabaseUrlTokenEnd = databaseUrlTokenEnd;
      continue;
    }

    const candidateLength = databaseUrlTokenEnd - match.index;
    if (candidateLength > MAX_DATABASE_URL_LENGTH) {
      recordMatch({
        index: match.index,
        name: 'database-url-too-large',
        patternOrder: SECRET_PATTERNS.length,
        placeholder: false,
      });
      skippedDatabaseUrlTokenEnd = databaseUrlTokenEnd;
      continue;
    }
    if (
      databaseUrlCandidateCount >= MAX_DATABASE_URL_CANDIDATES ||
      databaseUrlCandidateBytes + candidateLength > MAX_DATABASE_URL_CANDIDATE_BYTES
    ) {
      recordMatch({
        index: match.index,
        name: 'database-url-scan-limit',
        patternOrder: SECRET_PATTERNS.length,
        placeholder: false,
      });
      break;
    }

    databaseUrlCandidateCount += 1;
    databaseUrlCandidateBytes += candidateLength;
    const value = text.slice(match.index, databaseUrlTokenEnd);
    let placeholder = classifyDatabaseUrl(value);
    if (placeholder === null && databaseUrlTokenHasUnclosedQuote) {
      recordMatch({
        index: match.index,
        name: 'database-url-unclosed-quote',
        patternOrder: SECRET_PATTERNS.length,
        placeholder: false,
      });
      continue;
    }
    if (
      placeholder === null &&
      databaseUrlTokenEnd < text.length &&
      text[match.index - 1] !== '"' &&
      text[match.index - 1] !== "'" &&
      text[match.index - 1] !== '`' &&
      isDatabaseUrlWhitespaceOrControl(text[databaseUrlTokenEnd]) &&
      hasIncompleteDatabasePasswordMarker(value)
    ) {
      placeholder = false;
    }
    if (placeholder === null) {
      continue;
    }
    recordMatch({
      index: match.index,
      name: 'database-url-credential',
      patternOrder: SECRET_PATTERNS.length,
      placeholder,
    });
  }

  const findings = retainedFindings(candidate, text, findingMatches);
  const placeholders = retainedFindings(candidate, text, placeholderMatches);
  return {
    findings,
    placeholders,
    inspected: true,
    totalFindings,
    totalPlaceholders,
    truncatedFindings: totalFindings - findings.length,
    truncatedPlaceholders: totalPlaceholders - placeholders.length,
  };
}

/**
 * Apply deterministic secret policy to one file snapshot.
 *
 * Git and filesystem discovery stay in the command entrypoint. Missing content means discovery
 * could not inspect the candidate and is therefore a gate failure.
 *
 * Finding arrays contain a bounded redacted sample. Numeric totals and truncation counts are exact.
 *
 * @param {{ file: string, tracked: boolean, byteLength: number, contents?: Uint8Array }} candidate
 * @returns {{ findings: Array<{ file: string, line: number | null, name: string, tracked: boolean }>, placeholders: Array<{ file: string, line: number | null, name: string, tracked: boolean }>, inspected: boolean, totalFindings: number, totalPlaceholders: number, truncatedFindings: number, truncatedPlaceholders: number }}
 */
export function scanSecretCandidate(candidate) {
  if (
    !Number.isFinite(candidate.byteLength) ||
    !Number.isInteger(candidate.byteLength) ||
    candidate.byteLength < 0
  ) {
    return uninspectable(candidate, 'invalid-byte-length');
  }
  if (
    candidate.byteLength > MAX_SCANNABLE_BYTES ||
    (candidate.contents !== undefined && candidate.contents.byteLength > MAX_SCANNABLE_BYTES)
  ) {
    return uninspectable(candidate, 'file-over-size-limit');
  }
  if (hasSuffix(candidate.file, ARCHIVE_SUFFIXES)) {
    return uninspectable(candidate, 'archive-file');
  }
  if (candidate.contents === undefined) {
    return uninspectable(candidate, 'unreadable-file');
  }
  if (hasSuffix(candidate.file, BINARY_SUFFIXES) || candidate.contents.includes(0)) {
    return uninspectable(candidate, 'binary-file');
  }

  let text;
  try {
    text = UTF8_DECODER.decode(candidate.contents);
  } catch {
    return uninspectable(candidate, 'binary-file');
  }
  return scanText(candidate, text);
}
