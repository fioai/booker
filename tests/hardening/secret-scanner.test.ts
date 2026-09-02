import { describe, expect, it } from 'vitest';

import {
  MAX_RETAINED_RESULTS,
  MAX_SCANNABLE_BYTES,
  scanSecretCandidate,
  type SecretCandidate,
} from '../../scripts/lib/secret-scanner.mjs';

const DATABASE_SCHEME_CASES = ['POSTGRES', 'PoStGrEs', 'POSTGRESQL', 'PoStGrEsQl'];

function liveKey(value: string): string {
  return ['sk', 'live', value].join('_');
}

function textCandidate(file: string, text: string, tracked = true): SecretCandidate {
  const contents = Buffer.from(text);
  return { file, tracked, byteLength: contents.byteLength, contents };
}

function databaseUrl(query: string, scheme = 'postgresql'): string {
  return [scheme, '://user@localhost/booking?', query].join('');
}

describe('secret scanning policy', () => {
  it('reports every match of the same secret pattern', () => {
    const result = scanSecretCandidate(
      textCandidate(
        'config/provider.env',
        `${liveKey('firstcredential')}\nplain text\n${liveKey('secondcredential')}`,
      ),
    );

    expect(result.findings).toEqual([
      {
        file: 'config/provider.env',
        line: 1,
        name: 'live-provider-key',
        tracked: true,
      },
      {
        file: 'config/provider.env',
        line: 3,
        name: 'live-provider-key',
        tracked: true,
      },
    ]);
    expect(result.placeholders).toEqual([]);
    expect(result.inspected).toBe(true);
  });

  it('counts every match while retaining bounded redacted samples', () => {
    const matchCount = MAX_RETAINED_RESULTS * 4 + 7;
    const credentials = Array.from({ length: matchCount }, (_, index) =>
      liveKey(`credential${index.toString().padStart(8, '0')}`),
    );
    const text = credentials
      .map((credential) => `${credential}\r\n${liveKey('never_allowed')}`)
      .join('\r\n');

    const result = scanSecretCandidate(textCandidate('config/many.env', text));

    expect(result.totalFindings).toBe(matchCount);
    expect(result.totalPlaceholders).toBe(matchCount);
    expect(result.findings).toHaveLength(MAX_RETAINED_RESULTS);
    expect(result.placeholders).toHaveLength(MAX_RETAINED_RESULTS);
    expect(result.truncatedFindings).toBe(matchCount - MAX_RETAINED_RESULTS);
    expect(result.truncatedPlaceholders).toBe(matchCount - MAX_RETAINED_RESULTS);
    expect(result.findings.map((finding) => finding.line)).toEqual(
      Array.from({ length: MAX_RETAINED_RESULTS }, (_, index) => index * 2 + 1),
    );
    expect(result.placeholders.map((finding) => finding.line)).toEqual(
      Array.from({ length: MAX_RETAINED_RESULTS }, (_, index) => index * 2 + 2),
    );
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(credentials[0]);
    expect(serializedResult).not.toContain(credentials[credentials.length - 1]);
  });

  it('detects a PostgreSQL query password without returning its value', () => {
    const password = ['live', 'database', 'secret'].join('-');
    const result = scanSecretCandidate(
      textCandidate('config/database.env', databaseUrl(`password=${password}`)),
    );

    expect(result.findings).toEqual([
      {
        file: 'config/database.env',
        line: 1,
        name: 'database-url-credential',
        tracked: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it('keeps apostrophes inside unquoted database credentials and honors quoted boundaries', () => {
    const scheme = ['postgres', 'ql'].join('');
    const assignmentPassword = ['assignment', "'", 'credential'].join('');
    const yamlPassword = ['yaml', "'", 'credential'].join('');
    const doubleQuotedPassword = ['double', "'", 'quoted', 'credential'].join('-');
    const singleQuotedPassword = ['single', 'quoted', 'credential'].join('-');
    const file = 'config/apostrophe-database.env';
    const text = [
      ['DATABASE_URL=', scheme, '://user:', assignmentPassword, '@localhost/booking'].join(''),
      ['database_url: ', scheme, '://user:', yamlPassword, '@localhost/booking'].join(''),
      ['DATABASE_URL="', scheme, '://user:', doubleQuotedPassword, '@localhost/booking"'].join(''),
      ["DATABASE_URL='", scheme, '://user:', singleQuotedPassword, "@localhost/booking'"].join(''),
    ];

    const result = scanSecretCandidate(textCandidate(file, text.join('\n')));

    expect(result.totalFindings).toBe(4);
    expect(result.findings).toEqual(
      text.map((_, index) => ({
        file,
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    for (const password of [
      assignmentPassword,
      yamlPassword,
      doubleQuotedPassword,
      singleQuotedPassword,
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('keeps quoted whitespace inside complete database credential values', () => {
    const scheme = ['postgres', 'ql'].join('');
    const leadingPassword = ['leading', 'quoted', 'secret'].join('-');
    const interiorPassword = ['interior', 'authority', 'secret'].join('-');
    const interiorPasswordValue = ['prefix', interiorPassword].join(' ');
    const placeholderSuffix = ['quoted', 'real', 'secret'].join('-');
    const templateSuffix = ['template', 'real', 'secret'].join('-');
    const assignmentSuffix = ['assignment', 'real', 'secret'].join('-');
    const singleAssignmentSuffix = ['single', 'assignment', 'secret'].join('-');
    const backtickAssignmentSuffix = ['backtick', 'assignment', 'secret'].join('-');
    const generalDoubleSuffix = ['general', 'double', 'secret'].join('-');
    const generalSingleSuffix = ['general', 'single', 'secret'].join('-');
    const generalBacktickSuffix = ['general', 'backtick', 'secret'].join('-');
    const escapedQuoteSuffix = ['escaped', 'quote', 'secret'].join('-');
    const multilineSuffix = ['multiline', 'template', 'secret'].join('-');
    const encodedPassword = ['encoded', '%20', 'quoted', '%20', 'secret'].join('');
    const decodedEncodedPassword = ['encoded', 'quoted', 'secret'].join(' ');
    const file = 'config/quoted-database.env';
    const text = [
      ['DATABASE_URL="', databaseUrl(`password= ${leadingPassword}`, scheme), '"'].join(''),
      ["DATABASE_URL='", scheme, '://user:', interiorPasswordValue, "@localhost/booking'"].join(''),
      [
        'DATABASE_URL="',
        databaseUrl(`password=local-only-placeholder ${placeholderSuffix}`, scheme),
        '"',
      ].join(''),
      ["DATABASE_URL='", databaseUrl(`password=${encodedPassword}`, scheme), "'"].join(''),
      ['DATABASE_URL="', databaseUrl('password=local-only-placeholder', scheme), '"'].join(''),
      [
        'const url = `',
        databaseUrl(`password=local-only-placeholder ${templateSuffix}`, scheme),
        '`;',
      ].join(''),
      ['const placeholder = `', databaseUrl('password=local-only-placeholder', scheme), '`;'].join(
        '',
      ),
      [
        'DATABASE_URL="  ',
        databaseUrl(`password=local-only-placeholder ${assignmentSuffix}`, scheme),
        '"',
      ].join(''),
      ['DATABASE_URL = "  ', databaseUrl('password=local-only-placeholder', scheme), '  "'].join(
        '',
      ),
      [
        "DATABASE_URL='  ",
        databaseUrl(`password=local-only-placeholder ${singleAssignmentSuffix}`, scheme),
        "'",
      ].join(''),
      [
        'DATABASE_URL=`  ',
        databaseUrl(`password=local-only-placeholder ${backtickAssignmentSuffix}`, scheme),
        '`',
      ].join(''),
      [
        'const doubleUrl = "  ',
        databaseUrl(`password=local-only-placeholder ${generalDoubleSuffix}`, scheme),
        '";',
      ].join(''),
      [
        'const doublePlaceholder = "  ',
        databaseUrl('password=local-only-placeholder', scheme),
        '  ";',
      ].join(''),
      [
        "const singleUrl = '  ",
        databaseUrl(`password=local-only-placeholder ${generalSingleSuffix}`, scheme),
        "';",
      ].join(''),
      [
        "const singlePlaceholder = '  ",
        databaseUrl('password=local-only-placeholder', scheme),
        "  ';",
      ].join(''),
      [
        'const backtickUrl = `  ',
        databaseUrl(`password=local-only-placeholder ${generalBacktickSuffix}`, scheme),
        '`;',
      ].join(''),
      [
        'const backtickPlaceholder = `  ',
        databaseUrl('password=local-only-placeholder', scheme),
        '  `;',
      ].join(''),
      [
        'const escapedUrl = "  ',
        databaseUrl('password=local-only-placeholder', scheme),
        '\\" ',
        escapedQuoteSuffix,
        '";',
      ].join(''),
      [
        'const multilineUrl = `\n  ',
        databaseUrl(`password=local-only-placeholder ${multilineSuffix}`, scheme),
        '\n`;',
      ].join(''),
      [
        'const multilinePlaceholder = `\n  ',
        databaseUrl('password=local-only-placeholder', scheme),
        '\n`;',
      ].join(''),
    ];

    const result = scanSecretCandidate(textCandidate(file, text.join('\n')));

    expect(result.totalFindings).toBe(13);
    expect(result.findings).toEqual(
      [1, 2, 3, 4, 6, 8, 10, 11, 12, 14, 16, 18, 20].map((line) => ({
        file,
        line,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.totalPlaceholders).toBe(7);
    expect(result.placeholders).toEqual(
      [5, 7, 9, 13, 15, 17, 23].map((line) => ({
        file,
        line,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    const serializedResult = JSON.stringify(result);
    for (const password of [
      leadingPassword,
      interiorPasswordValue,
      placeholderSuffix,
      templateSuffix,
      assignmentSuffix,
      singleAssignmentSuffix,
      backtickAssignmentSuffix,
      generalDoubleSuffix,
      generalSingleSuffix,
      generalBacktickSuffix,
      escapedQuoteSuffix,
      multilineSuffix,
      encodedPassword,
      decodedEncodedPassword,
      'local-only-placeholder',
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('uses precomputed quote spans without backward delimiter ambiguity', () => {
    const scheme = ['postgres', 'ql'].join('');
    const leadingWhitespace = ' '.repeat(8 * 1024 + 1);
    const doubleSuffix = ['bounded', 'double', 'secret'].join('-');
    const backtickSuffix = ['bounded', 'backtick', 'secret'].join('-');
    const placeholder = 'local-only-placeholder';
    const cases = [
      [
        'const doubleUrl = "',
        leadingWhitespace,
        databaseUrl(`password=${placeholder} ${doubleSuffix}`, scheme),
        '"',
      ].join(''),
      [
        'const backtickUrl = `',
        leadingWhitespace,
        databaseUrl(`password=${placeholder} ${backtickSuffix}`, scheme),
        '`',
      ].join(''),
      [
        'const exactUrl = "',
        leadingWhitespace,
        databaseUrl(`password=${placeholder}`, scheme),
        '"',
      ].join(''),
      ['"Example"\n', databaseUrl(`password=${placeholder}`, scheme), '\ntrailing'].join(''),
      ['const unmatchedUrl = "  ', databaseUrl('password=', scheme)].join(''),
    ];

    const results = cases.map((text, index) =>
      scanSecretCandidate(textCandidate(`config/quote-span-${index}.env`, text)),
    );

    expect(
      results.map((result) => result.findings.map(({ line, name }) => ({ line, name }))),
    ).toEqual([
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [],
      [],
      [{ line: 1, name: 'database-url-unclosed-quote' }],
    ]);
    expect(
      results.map((result) => result.placeholders.map(({ line, name }) => ({ line, name }))),
    ).toEqual([
      [],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 2, name: 'database-url-credential' }],
      [],
    ]);
    const serializedResults = JSON.stringify(results);
    expect(serializedResults).not.toContain(doubleSuffix);
    expect(serializedResults).not.toContain(backtickSuffix);
    expect(serializedResults).not.toContain(placeholder);
  });

  it('keeps doubled delimiters inside database quote spans', () => {
    const scheme = ['postgres', 'ql'].join('');
    const singlePassword = ['pa', "''", 'ss'].join('');
    const doublePassword = ['pa', '""', 'ss'].join('');
    const incompletePassword = ['pa', "''"].join('');
    const placeholder = 'local-only-placeholder';
    const singleCredentialUrl = [scheme, '://user:', singlePassword, '@host/db'].join('');
    const doubleCredentialUrl = [scheme, '://user:', doublePassword, '@host/db'].join('');
    const placeholderUrl = [scheme, '://user:', placeholder, '@host/db'].join('');
    const malformedCredentialUrl = [scheme, '://user:', singlePassword, '@[broken'].join('');
    const incompleteCredentialUrl = [scheme, '://user:', incompletePassword].join('');
    const yamlFile = 'config/doubled-quote-database.yml';
    const sqlFile = 'config/doubled-quote-database.sql';
    const yamlResult = scanSecretCandidate(
      textCandidate(
        yamlFile,
        [
          `database_url: '${singleCredentialUrl}'`,
          `placeholder_url: '${placeholderUrl}''label'`,
          `double_url: "${doubleCredentialUrl}"`,
          `double_placeholder_url: "${placeholderUrl}""label"`,
          `malformed_url: '${malformedCredentialUrl}'`,
          `unclosed_url: '${incompleteCredentialUrl}`,
        ].join('\n'),
      ),
    );
    const sqlResult = scanSecretCandidate(
      textCandidate(
        sqlFile,
        [`SELECT '${singleCredentialUrl}';`, `SELECT '${placeholderUrl}''label';`].join('\n'),
      ),
    );

    expect(yamlResult.findings).toEqual([
      { file: yamlFile, line: 1, name: 'database-url-credential', tracked: true },
      { file: yamlFile, line: 3, name: 'database-url-credential', tracked: true },
      { file: yamlFile, line: 5, name: 'database-url-credential', tracked: true },
      { file: yamlFile, line: 6, name: 'database-url-unclosed-quote', tracked: true },
    ]);
    expect(yamlResult.placeholders).toEqual([
      { file: yamlFile, line: 2, name: 'database-url-credential', tracked: true },
      { file: yamlFile, line: 4, name: 'database-url-credential', tracked: true },
    ]);
    expect(yamlResult.totalFindings).toBe(4);
    expect(yamlResult.totalPlaceholders).toBe(2);
    expect(sqlResult.findings).toEqual([
      { file: sqlFile, line: 1, name: 'database-url-credential', tracked: true },
    ]);
    expect(sqlResult.placeholders).toEqual([
      { file: sqlFile, line: 2, name: 'database-url-credential', tracked: true },
    ]);
    expect(sqlResult.totalFindings).toBe(1);
    expect(sqlResult.totalPlaceholders).toBe(1);
    const serializedResults = JSON.stringify([yamlResult, sqlResult]);
    for (const secret of [
      singlePassword,
      doublePassword,
      incompletePassword,
      placeholder,
      singleCredentialUrl,
      doubleCredentialUrl,
      malformedCredentialUrl,
      incompleteCredentialUrl,
    ]) {
      expect(serializedResults).not.toContain(secret);
    }
  });

  it('fails closed with bounded context for a quote-dense maximum-size file', () => {
    const scheme = ['postgres', 'ql'].join('');
    const url = [scheme, '://localhost/booking'].join('');
    const quoteSpan = '"" ';
    const quoteSpanCount = Math.floor((MAX_SCANNABLE_BYTES - url.length) / quoteSpan.length);
    const text = [quoteSpan.repeat(quoteSpanCount), url].join('');
    const file = 'config/quote-dense-database.txt';

    const result = scanSecretCandidate(textCandidate(file, text));

    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_SCANNABLE_BYTES - quoteSpan.length);
    expect(result.totalFindings).toBe(1);
    expect(result.findings).toEqual([
      {
        file,
        line: 1,
        name: 'database-url-context-limit',
        tracked: true,
      },
    ]);
    expect(result.truncatedFindings).toBe(0);
    expect(result.totalPlaceholders).toBe(0);
    expect(result.placeholders).toEqual([]);
    expect(result.truncatedPlaceholders).toBe(0);
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it('does not treat word-internal apostrophes as quote openers', () => {
    const scheme = ['postgres', 'ql'].join('');
    const credentialFreeUrl = [scheme, '://localhost/booking'].join('');
    const text = [
      `Here's ${credentialFreeUrl}`,
      `// it's ${credentialFreeUrl}`,
      `Users' guide: ${credentialFreeUrl}`,
      `Maintainers' reference: ${credentialFreeUrl}`,
      `'${credentialFreeUrl}'`,
    ].join('\n');

    const result = scanSecretCandidate(textCandidate('docs/database-example.txt', text));

    expect(result.totalFindings).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.totalPlaceholders).toBe(0);
    expect(result.placeholders).toEqual([]);
  });

  it('recognizes keyword-adjacent single-quoted database strings', () => {
    const scheme = ['postgres', 'ql'].join('');
    const placeholder = 'local-only-placeholder';
    const directSuffix = ['keyword', 'direct', 'secret'].join('-');
    const spacedSuffix = ['keyword', 'spaced', 'secret'].join('-');
    const multilineSuffix = ['keyword', 'multiline', 'secret'].join('-');
    const escapedNewlineSuffix = ['keyword', 'escaped-newline', 'secret'].join('-');
    const escapedTabSuffix = ['keyword', 'escaped-tab', 'secret'].join('-');
    const escapedUnicodeSuffix = ['keyword', 'escaped-unicode', 'secret'].join('-');
    const escapedBraceSuffix = ['keyword', 'escaped-brace', 'secret'].join('-');
    const escapedHexTabSuffix = ['keyword', 'escaped-hex-tab', 'secret'].join('-');
    const escapedUnicodeNewlineSuffix = ['keyword', 'escaped-unicode-newline', 'secret'].join('-');
    const continuedLineSuffix = ['keyword', 'continued-line', 'secret'].join('-');
    const texts = [
      ["return'", databaseUrl(`password=${placeholder} ${directSuffix}`, scheme), "'"].join(''),
      ["identifier'  ", databaseUrl(`password=${placeholder} ${spacedSuffix}`, scheme), "'"].join(
        '',
      ),
      [
        "return'\n  ",
        databaseUrl(`password=${placeholder} ${multilineSuffix}`, scheme),
        "\n'",
      ].join(''),
      ["return'", databaseUrl(`password=${placeholder}`, scheme), "'"].join(''),
      [
        "return'\\n",
        databaseUrl(`password=${placeholder} ${escapedNewlineSuffix}`, scheme),
        "'",
      ].join(''),
      ["return'\\t", databaseUrl(`password=${placeholder} ${escapedTabSuffix}`, scheme), "'"].join(
        '',
      ),
      [
        "return'\\u0020",
        databaseUrl(`password=${placeholder} ${escapedUnicodeSuffix}`, scheme),
        "'",
      ].join(''),
      ["return'\\n", databaseUrl(`password=${placeholder}`, scheme), "'"].join(''),
      [
        "return'\\u{20}",
        databaseUrl(`password=${placeholder} ${escapedBraceSuffix}`, scheme),
        "'",
      ].join(''),
      [
        "return'\\x09",
        databaseUrl(`password=${placeholder} ${escapedHexTabSuffix}`, scheme),
        "'",
      ].join(''),
      [
        "return'\\u000A",
        databaseUrl(`password=${placeholder} ${escapedUnicodeNewlineSuffix}`, scheme),
        "'",
      ].join(''),
      [
        "return'\\",
        '\n',
        databaseUrl(`password=${placeholder} ${continuedLineSuffix}`, scheme),
        "'",
      ].join(''),
      ["return'\\u{20}", databaseUrl(`password=${placeholder}`, scheme), "'"].join(''),
      ["return'\\xG1", databaseUrl(`password=${placeholder}`, scheme), "'"].join(''),
    ];

    const results = texts.map((text, index) =>
      scanSecretCandidate(textCandidate(`config/keyword-string-${index}.ts`, text)),
    );

    expect(
      results.map((result) => result.findings.map(({ line, name }) => ({ line, name }))),
    ).toEqual([
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 2, name: 'database-url-credential' }],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 1, name: 'database-url-credential' }],
      [{ line: 2, name: 'database-url-credential' }],
      [],
      [{ line: 1, name: 'database-url-invalid-context' }],
    ]);
    expect(
      results.map((result) => result.placeholders.map(({ line, name }) => ({ line, name }))),
    ).toEqual([
      [],
      [],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [],
      [],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [],
      [],
      [],
      [],
      [{ line: 1, name: 'database-url-credential' }],
      [],
    ]);
    const serializedResults = JSON.stringify(results);
    expect(serializedResults).not.toContain(directSuffix);
    expect(serializedResults).not.toContain(spacedSuffix);
    expect(serializedResults).not.toContain(multilineSuffix);
    expect(serializedResults).not.toContain(escapedNewlineSuffix);
    expect(serializedResults).not.toContain(escapedTabSuffix);
    expect(serializedResults).not.toContain(escapedUnicodeSuffix);
    expect(serializedResults).not.toContain(escapedBraceSuffix);
    expect(serializedResults).not.toContain(escapedHexTabSuffix);
    expect(serializedResults).not.toContain(escapedUnicodeNewlineSuffix);
    expect(serializedResults).not.toContain(continuedLineSuffix);
    expect(serializedResults).not.toContain(placeholder);
  });

  it('fails closed when keyword quote context exceeds the lookahead bound', () => {
    const scheme = ['postgres', 'ql'].join('');
    const placeholder = 'local-only-placeholder';
    const rawSuffix = ['overbound', 'raw', 'secret'].join('-');
    const escapedSuffix = ['overbound', 'escaped', 'secret'].join('-');
    const texts = [
      [
        "return'",
        ' '.repeat(8 * 1024 + 1),
        databaseUrl(`password=${placeholder} ${rawSuffix}`, scheme),
        "'",
      ].join(''),
      [
        "return'",
        '\\t'.repeat((8 * 1024) / 2 + 1),
        databaseUrl(`password=${placeholder} ${escapedSuffix}`, scheme),
        "'",
      ].join(''),
    ];

    const results = texts.map((text, index) =>
      scanSecretCandidate(textCandidate(`config/overbound-keyword-${index}.ts`, text)),
    );

    expect(
      results.map((result) => result.findings.map(({ line, name }) => ({ line, name }))),
    ).toEqual([
      [{ line: 1, name: 'database-url-invalid-context' }],
      [{ line: 1, name: 'database-url-invalid-context' }],
    ]);
    expect(results.map((result) => result.placeholders)).toEqual([[], []]);
    const serializedResults = JSON.stringify(results);
    expect(serializedResults).not.toContain(rawSuffix);
    expect(serializedResults).not.toContain(escapedSuffix);
    expect(serializedResults).not.toContain(placeholder);
  });

  it('keeps dotenv assignment whitespace inside complete unquoted database values', () => {
    const scheme = ['postgres', 'ql'].join('');
    const authorityPassword = ['dotenv', 'authority', 'secret'].join('-');
    const authorityPasswordValue = ['real', authorityPassword].join(' ');
    const querySuffix = ['dotenv', 'query', 'secret'].join('-');
    const encodedPassword = ['dotenv', '%20', 'encoded', '%20', 'secret'].join('');
    const decodedEncodedPassword = ['dotenv', 'encoded', 'secret'].join(' ');
    const file = 'config/unquoted-dotenv-database.env';
    const text = [
      ['DATABASE_URL=', scheme, '://user:', authorityPasswordValue, '@localhost/booking'].join(''),
      [
        'DATABASE_URL = ',
        databaseUrl(`password=local-only-placeholder ${querySuffix}`, scheme),
      ].join(''),
      ['DATABASE_URL=', databaseUrl(`password=${encodedPassword}`, scheme)].join(''),
      [
        '  export DATABASE_URL \t= ',
        databaseUrl('password=local-only-placeholder', scheme),
        ' \t # local placeholder',
      ].join(''),
    ];

    const result = scanSecretCandidate(textCandidate(file, text.join('\n')));

    expect(result.totalFindings).toBe(3);
    expect(result.findings).toEqual(
      [1, 2, 3].map((line) => ({
        file,
        line,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.totalPlaceholders).toBe(1);
    expect(result.placeholders).toEqual([
      {
        file,
        line: 4,
        name: 'database-url-credential',
        tracked: true,
      },
    ]);
    const serializedResult = JSON.stringify(result);
    for (const password of [
      authorityPasswordValue,
      querySuffix,
      encodedPassword,
      decodedEncodedPassword,
      'local-only-placeholder',
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('fails closed when unquoted whitespace truncates a database password marker', () => {
    const scheme = ['postgres', 'ql'].join('');
    const authorityPassword = ['unquoted', 'authority', 'secret'].join('-');
    const queryPassword = ['unquoted', 'query', 'secret'].join('-');
    const file = 'config/unquoted-incomplete-database.env';
    const text = [
      [scheme, '://user: ', authorityPassword, '@localhost/booking'].join(''),
      databaseUrl(`password= ${queryPassword}`, scheme),
    ];

    const result = scanSecretCandidate(textCandidate(file, text.join('\n')));

    expect(result.totalFindings).toBe(2);
    expect(result.findings).toEqual(
      text.map((_, index) => ({
        file,
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(authorityPassword);
    expect(serializedResult).not.toContain(queryPassword);
  });

  it('classifies complete credential values that contain database schemes', () => {
    const scheme = ['postgres', 'ql'].join('');
    const nestedScheme = [scheme, '://'].join('');
    const exactSchemePassword = nestedScheme;
    const schemePrefixedPassword = [nestedScheme, 'nested-query-secret'].join('');
    const placeholderPrefixedPassword = [
      'local-only-placeholder-',
      nestedScheme,
      'nested-placeholder-secret',
    ].join('');
    const commaPrefixedPassword = [',', nestedScheme, 'nested-comma-secret'].join('');
    const semicolonPrefixedPassword = [';', nestedScheme, 'nested-semicolon-secret'].join('');
    const parenthesisPrefixedPassword = [')', nestedScheme, 'nested-parenthesis-secret'].join('');
    const pipePrefixedPassword = ['|', nestedScheme, 'nested-pipe-secret'].join('');
    const authorityPassword = [nestedScheme, 'nested-authority-secret'].join('');
    const encodedPassword = [scheme, '%3A%2F%2F', 'nested-encoded-secret'].join('');
    const decodedEncodedPassword = [nestedScheme, 'nested-encoded-secret'].join('');
    const fallbackPassword = [nestedScheme, 'user:nested-fallback-secret@localhost/booking'].join(
      '',
    );
    const file = 'config/nested-scheme-database.env';
    const urls = [
      databaseUrl(`password=${exactSchemePassword}`, scheme),
      databaseUrl(`password=${schemePrefixedPassword}`, scheme),
      databaseUrl(`password=${placeholderPrefixedPassword}`, scheme),
      databaseUrl(`password=${commaPrefixedPassword}`, scheme),
      databaseUrl(`password=${semicolonPrefixedPassword}`, scheme),
      databaseUrl(`password=${parenthesisPrefixedPassword}`, scheme),
      databaseUrl(`password=${pipePrefixedPassword}`, scheme),
      [scheme, '://user:', authorityPassword, '@localhost/booking'].join(''),
      databaseUrl(`pass%77ord=${encodedPassword}`, scheme),
      databaseUrl(`fallback=${fallbackPassword}`, scheme),
    ];

    const result = scanSecretCandidate(textCandidate(file, urls.join('\n')));

    expect(result.totalFindings).toBe(urls.length);
    expect(result.totalPlaceholders).toBe(0);
    expect(result.findings).toEqual(
      urls.map((_, index) => ({
        file,
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    for (const password of [
      exactSchemePassword,
      schemePrefixedPassword,
      placeholderPrefixedPassword,
      commaPrefixedPassword,
      semicolonPrefixedPassword,
      parenthesisPrefixedPassword,
      pipePrefixedPassword,
      authorityPassword,
      encodedPassword,
      decodedEncodedPassword,
      fallbackPassword,
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('classifies every PostgreSQL scheme after separators and adjacent text', () => {
    const outerCommaPassword = ['outer', 'comma', 'secret'].join('-');
    const commaPassword = ['comma', 'database', 'secret'].join('-');
    const semicolonPassword = ['semicolon', 'database', 'secret'].join('-');
    const pipePassword = ['pipe', 'database', 'secret'].join('-');
    const malformedAdjacentPassword = ['malformed', 'adjacent', 'secret'].join('-');
    const adjacentPassword = ['adjacent', 'database', 'secret'].join('-');
    const malformedRecoveryPassword = ['malformed', 'recovery', 'secret'].join('-');
    const punctuationPassword = ['inside', ',', 'punctuation', ';', 'secret'].join('');
    const passwords = [
      outerCommaPassword,
      commaPassword,
      semicolonPassword,
      pipePassword,
      malformedAdjacentPassword,
      adjacentPassword,
      malformedRecoveryPassword,
      punctuationPassword,
    ];
    const credentialUrl = (password: string) =>
      ['postgresql', '://user:', password, '@localhost/booking'].join('');
    const credentialFreeUrl = ['postgresql', '://localhost/booking'].join('');
    const malformedUrl = ['postgresql', '://[broken'].join('');
    const result = scanSecretCandidate(
      textCandidate(
        'config/adjacent-database.env',
        [
          [credentialUrl(outerCommaPassword), ',', credentialUrl(commaPassword)].join(''),
          [credentialFreeUrl, ';', credentialUrl(semicolonPassword)].join(''),
          [credentialFreeUrl, '|', credentialUrl(pipePassword)].join(''),
          [malformedUrl, ';', credentialUrl(malformedAdjacentPassword)].join(''),
          [credentialFreeUrl, ')adjacent-text', credentialUrl(adjacentPassword)].join(''),
          [malformedUrl, credentialUrl(malformedRecoveryPassword)].join(''),
          credentialUrl(punctuationPassword),
        ].join('\n'),
      ),
    );

    const findingLines = [1, 1, 2, 3, 4, 5, 6, 7];
    expect(result.totalFindings).toBe(findingLines.length);
    expect(result.findings).toEqual(
      findingLines.map((line) => ({
        file: 'config/adjacent-database.env',
        line,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    for (const password of passwords) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('fails closed after bounded dense database scheme candidates', () => {
    const candidateLimit = 1024;
    const matchCount = candidateLimit + 64;
    const scheme = ['postgres', 'ql'].join('');
    const prefix = [scheme, '://localhost/booking/'].join('');
    const urlLength = Math.floor(MAX_SCANNABLE_BYTES / matchCount) - 1;
    const url = [prefix, 'x'.repeat(urlLength - prefix.length)].join('');
    const text = Array.from({ length: matchCount }, () => url).join('\n');
    const file = 'config/dense-database.env';

    const result = scanSecretCandidate(textCandidate(file, text));

    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_SCANNABLE_BYTES - matchCount);
    expect(result.totalFindings).toBe(1);
    expect(result.findings).toEqual([
      {
        file,
        line: candidateLimit + 1,
        name: 'database-url-scan-limit',
        tracked: true,
      },
    ]);
    expect(result.truncatedFindings).toBe(0);
    expect(result.totalPlaceholders).toBe(0);
    expect(result.truncatedPlaceholders).toBe(0);
    expect(result.placeholders).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(url);
  });

  it('fails closed without parsing a database URL token over the size bound', () => {
    const scheme = ['postgres', 'ql'].join('');
    const password = ['late', 'database', 'secret'].join('-');
    const url = [
      scheme,
      '://localhost/booking?padding=',
      'x'.repeat(9 * 1024),
      '&password=',
      password,
    ].join('');
    const file = 'config/oversized-database.env';

    const result = scanSecretCandidate(textCandidate(file, url));

    expect(result.totalFindings).toBe(1);
    expect(result.findings).toEqual([
      {
        file,
        line: 1,
        name: 'database-url-too-large',
        tracked: true,
      },
    ]);
    expect(result.placeholders).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it('detects percent-encoded PostgreSQL query keys and values without returning them', () => {
    const encodedPassword = 'live%2Dencoded%2Dsecret';
    const decodedPassword = ['live', 'encoded', 'secret'].join('-');
    const result = scanSecretCandidate(
      textCandidate('config/encoded-database.env', databaseUrl(`pass%77ord=${encodedPassword}`)),
    );

    expect(result.findings).toEqual([
      {
        file: 'config/encoded-database.env',
        line: 1,
        name: 'database-url-credential',
        tracked: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(encodedPassword);
    expect(JSON.stringify(result)).not.toContain(decodedPassword);
  });

  it('detects authority passwords for uppercase and mixed-case PostgreSQL schemes', () => {
    const encodedPassword = ['live', '%2Dauthority%2D', 'secret'].join('');
    const decodedPassword = ['live', 'authority', 'secret'].join('-');
    const file = 'config/authority-scheme-case.env';
    const result = scanSecretCandidate(
      textCandidate(
        file,
        DATABASE_SCHEME_CASES.map((scheme) =>
          [scheme, '://user:', encodedPassword, '@localhost/booking'].join(''),
        ).join('\n'),
      ),
    );

    expect(result.findings).toEqual(
      DATABASE_SCHEME_CASES.map((_, index) => ({
        file,
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(encodedPassword);
    expect(serializedResult).not.toContain(decodedPassword);
  });

  it('detects encoded query passwords for uppercase and mixed-case PostgreSQL schemes', () => {
    const encodedKey = ['pass', '%77', 'ord'].join('');
    const encodedPassword = ['live', '%2Dquery%2D', 'secret'].join('');
    const decodedPassword = ['live', 'query', 'secret'].join('-');
    const file = 'config/query-scheme-case.env';
    const result = scanSecretCandidate(
      textCandidate(
        file,
        DATABASE_SCHEME_CASES.map((scheme) =>
          databaseUrl(`${encodedKey}=${encodedPassword}`, scheme),
        ).join('\n'),
      ),
    );

    expect(result.findings).toEqual(
      DATABASE_SCHEME_CASES.map((_, index) => ({
        file,
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(encodedPassword);
    expect(serializedResult).not.toContain(decodedPassword);
  });

  it('accepts only exact decoded PostgreSQL query placeholders', () => {
    const text = [
      databaseUrl('password=local-only-placeholder'),
      databaseUrl('pass%77ord=replace%5Fme%5Flocal%5Fpassword'),
      databaseUrl('password=local-only-placeholder-extra'),
    ].join('\n');

    const result = scanSecretCandidate(textCandidate('.env.example', text));

    expect(result.placeholders.map(({ line, name }) => ({ line, name }))).toEqual([
      { line: 1, name: 'database-url-credential' },
      { line: 2, name: 'database-url-credential' },
    ]);
    expect(result.findings).toEqual([
      {
        file: '.env.example',
        line: 3,
        name: 'database-url-credential',
        tracked: true,
      },
    ]);
  });

  it('does not exempt a former test value in production-looking or test paths', () => {
    const password = ['real', 'looking', 'value'].join('-');
    const files = ['config/production.env', 'tests/fixtures/database.env'];
    const results = files.map((file) =>
      scanSecretCandidate(textCandidate(file, databaseUrl(`password=${password}`))),
    );

    expect(results.map((result) => result.findings)).toEqual(
      files.map((file) => [
        {
          file,
          line: 1,
          name: 'database-url-credential',
          tracked: true,
        },
      ]),
    );
    expect(JSON.stringify(results)).not.toContain(password);
  });

  it('fails closed for credentials in malformed PostgreSQL URLs without returning values', () => {
    const authorityPassword = ['live', 'secret'].join('-');
    const encodedAuthorityPassword = ['live', '%2Dauthority%2D', 'secret'].join('');
    const decodedAuthorityPassword = ['live', 'authority', 'secret'].join('-');
    const encodedQueryPassword = ['live', '%2Dquery%2D', 'secret'].join('');
    const decodedQueryPassword = ['live', 'query', 'secret'].join('-');
    const malformedQueryPassword = ['live', '%ZZ', 'query'].join('-');
    const urls = [
      ['postgresql', '://user:', authorityPassword, '@[broken'].join(''),
      ['postgresql', '://user:', encodedAuthorityPassword, '@localhost:bad-port'].join(''),
      ['postgresql', '://user@[broken/db?pass%77ord=', encodedQueryPassword].join(''),
      ['postgresql', '://user@[broken/db?password=', malformedQueryPassword].join(''),
    ];

    const result = scanSecretCandidate(
      textCandidate('config/malformed-database.env', urls.join('\n')),
    );

    expect(result.findings).toEqual(
      urls.map((_, index) => ({
        file: 'config/malformed-database.env',
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    for (const password of [
      authorityPassword,
      encodedAuthorityPassword,
      decodedAuthorityPassword,
      encodedQueryPassword,
      decodedQueryPassword,
      malformedQueryPassword,
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('detects malformed userinfo across delimiters and encoded markers without leaking values', () => {
    const slashPassword = ['live', 'slash', 'secret'].join('-');
    const queryPassword = ['live', 'query-delimiter', 'secret'].join('-');
    const fragmentPassword = ['live', 'fragment', 'secret'].join('-');
    const encodedPassword = ['live', '%2Dencoded%2D', 'secret'].join('');
    const decodedPassword = ['live', 'encoded', 'secret'].join('-');
    const placeholderPrefix = 'local-only-placeholder';
    const urls = [
      ['postgresql://user:', slashPassword, '/fragment@[broken'].join(''),
      ['postgresql://user:', queryPassword, '?fragment@[broken'].join(''),
      ['postgresql://user:', fragmentPassword, '#fragment@[broken'].join(''),
      ['postgresql://user%3A', encodedPassword, '%40[broken'].join(''),
      ['postgresql://user:', placeholderPrefix, '/fragment@[broken'].join(''),
    ];

    const result = scanSecretCandidate(
      textCandidate('config/malformed-delimiter-database.env', urls.join('\n')),
    );

    expect(result.findings).toEqual(
      urls.map((_, index) => ({
        file: 'config/malformed-delimiter-database.env',
        line: index + 1,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    expect(result.placeholders).toEqual([]);
    const serializedResult = JSON.stringify(result);
    for (const password of [
      slashPassword,
      queryPassword,
      fragmentPassword,
      encodedPassword,
      decodedPassword,
      placeholderPrefix,
    ]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('only exempts the exact Compose authority credential pair', () => {
    const composeUserInfo = [
      '${POSTGRES_USER:-booking_engine_local}',
      '${POSTGRES_PASSWORD:-local-only-placeholder}',
    ].join(':');
    const livePassword = ['live', 'compose', 'secret'].join('-');
    const encodedPassword = ['live', '%2Dencoded%2Dcompose%2D', 'secret'].join('');
    const decodedPassword = ['live', 'encoded', 'compose', 'secret'].join('-');
    const urls = [
      [
        'postgresql://',
        composeUserInfo,
        '@postgres:5432/${POSTGRES_DB:-booking_engine_local}',
      ].join(''),
      ['postgresql://', composeUserInfo, '@second-user:', livePassword, '@postgres:5432/db'].join(
        '',
      ),
      [
        'postgresql://',
        composeUserInfo,
        '@postgres:5432/path/second-user:',
        livePassword,
        '@marker',
      ].join(''),
      ['postgresql://', composeUserInfo, '@second-user%3A', encodedPassword, '%40[broken'].join(''),
    ];

    const result = scanSecretCandidate(textCandidate('docker-compose.yml', urls.join('\n')));

    expect(result.placeholders.map(({ line, name }) => ({ line, name }))).toEqual([
      { line: 1, name: 'database-url-credential' },
    ]);
    expect(result.findings).toEqual(
      urls.slice(1).map((_, index) => ({
        file: 'docker-compose.yml',
        line: index + 2,
        name: 'database-url-credential',
        tracked: true,
      })),
    );
    const serializedResult = JSON.stringify(result);
    for (const password of [livePassword, encodedPassword, decodedPassword]) {
      expect(serializedResult).not.toContain(password);
    }
  });

  it('accepts only exact placeholders in malformed PostgreSQL URLs', () => {
    const urls = [
      ['postgresql', '://user:local%2Donly%2Dplaceholder@[broken'].join(''),
      ['postgresql', '://user:replace_me_local_password@localhost:bad-port'].join(''),
      ['postgresql://user%3Alocal%2Donly%2Dplaceholder%40[broken'].join(''),
      ['postgresql', '://user@[broken/db?pass%77ord=replace%5Fme%5Flocal%5Fpassword'].join(''),
      ['postgresql', '://user@[broken/db?password=local%2Donly%2Dplaceholder%2Dextra'].join(''),
    ];

    const result = scanSecretCandidate(textCandidate('.env.example', urls.join('\n')));

    expect(result.placeholders.map(({ line, name }) => ({ line, name }))).toEqual([
      { line: 1, name: 'database-url-credential' },
      { line: 2, name: 'database-url-credential' },
      { line: 3, name: 'database-url-credential' },
      { line: 4, name: 'database-url-credential' },
    ]);
    expect(result.findings).toEqual([
      {
        file: '.env.example',
        line: 5,
        name: 'database-url-credential',
        tracked: true,
      },
    ]);
  });

  it('detects standard private-key headers', () => {
    const types = ['ENCRYPTED', 'DSA', 'RSA', 'EC', 'OPENSSH', undefined];
    const result = scanSecretCandidate(
      textCandidate(
        'config/private-keys.txt',
        types
          .map((type) =>
            type === undefined
              ? ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
              : ['-----BEGIN', type, 'PRIVATE KEY-----'].join(' '),
          )
          .join('\n'),
      ),
    );

    expect(result.findings).toEqual(
      types.map((_, index) => ({
        file: 'config/private-keys.txt',
        line: index + 1,
        name: 'private-key-block',
        tracked: true,
      })),
    );
  });

  it('reports a real credential next to an explicit placeholder', () => {
    for (const file of ['.env.example', 'tests/provider-config.ts']) {
      const result = scanSecretCandidate(
        textCandidate(file, `${liveKey('never_allowed')}\n${liveKey('customercredential')}`),
      );

      expect(result.placeholders).toEqual([
        {
          file,
          line: 1,
          name: 'live-provider-key',
          tracked: true,
        },
      ]);
      expect(result.findings).toEqual([
        {
          file,
          line: 2,
          name: 'live-provider-key',
          tracked: true,
        },
      ]);
    }
  });

  it('fails closed before reading a candidate over the size limit', () => {
    const result = scanSecretCandidate({
      file: 'nested/large.env',
      tracked: false,
      byteLength: MAX_SCANNABLE_BYTES + 1,
    });

    expect(result).toEqual({
      findings: [
        {
          file: 'nested/large.env',
          line: null,
          name: 'file-over-size-limit',
          tracked: false,
        },
      ],
      placeholders: [],
      inspected: false,
      totalFindings: 1,
      totalPlaceholders: 0,
      truncatedFindings: 0,
      truncatedPlaceholders: 0,
    });
  });

  it('fails closed for invalid declared byte lengths', () => {
    const contents = Buffer.from('plain text');
    const invalidByteLengths = [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5];

    invalidByteLengths.forEach((byteLength, index) => {
      const file = `config/invalid-byte-length-${index}.env`;
      const result = scanSecretCandidate({
        file,
        tracked: true,
        byteLength,
        contents,
      });

      expect(result).toEqual({
        findings: [
          {
            file,
            line: null,
            name: 'invalid-byte-length',
            tracked: true,
          },
        ],
        placeholders: [],
        inspected: false,
        totalFindings: 1,
        totalPlaceholders: 0,
        truncatedFindings: 0,
        truncatedPlaceholders: 0,
      });
    });
  });

  it('enforces the actual content size independently of the declared byte length', () => {
    const file = 'config/mismatched-large.env';
    const result = scanSecretCandidate({
      file,
      tracked: false,
      byteLength: 1,
      contents: new Uint8Array(MAX_SCANNABLE_BYTES + 1),
    });

    expect(result).toEqual({
      findings: [
        {
          file,
          line: null,
          name: 'file-over-size-limit',
          tracked: false,
        },
      ],
      placeholders: [],
      inspected: false,
      totalFindings: 1,
      totalPlaceholders: 0,
      truncatedFindings: 0,
      truncatedPlaceholders: 0,
    });
  });

  it('fails closed for a tracked archive', () => {
    const result = scanSecretCandidate(
      textCandidate('backups/release.tar.gz', 'compressed archive fixture'),
    );

    expect(result).toEqual({
      findings: [
        {
          file: 'backups/release.tar.gz',
          line: null,
          name: 'archive-file',
          tracked: true,
        },
      ],
      placeholders: [],
      inspected: false,
      totalFindings: 1,
      totalPlaceholders: 0,
      truncatedFindings: 0,
      truncatedPlaceholders: 0,
    });
  });

  it('scans a tracked file under a generated path', () => {
    const result = scanSecretCandidate(
      textCandidate('artifacts/release/evidence.txt', liveKey('generatedcredential')),
    );

    expect(result.findings).toEqual([
      {
        file: 'artifacts/release/evidence.txt',
        line: 1,
        name: 'live-provider-key',
        tracked: true,
      },
    ]);
  });

  it('accepts only the explicit safe placeholder values', () => {
    const placeholders = [
      liveKey('never_allowed'),
      ['whsec', 'test', 'only', 'secret'].join('_'),
      ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
      ['postgresql://booking_engine_local:', 'local-only-placeholder', '@localhost/db'].join(''),
      ['postgresql://replace_me_local_user:', 'replace_me_local_password', '@localhost/db'].join(
        '',
      ),
    ].join('\n');
    const result = scanSecretCandidate(textCandidate('.env.example', placeholders));

    expect(result.findings).toEqual([]);
    expect(result.placeholders).toHaveLength(5);
    expect(result.totalPlaceholders).toBe(5);
    expect(result.truncatedPlaceholders).toBe(0);
    expect(result.placeholders.map(({ line, name }) => ({ line, name }))).toEqual([
      { line: 1, name: 'live-provider-key' },
      { line: 2, name: 'provider-webhook-secret' },
      { line: 3, name: 'cloud-access-key' },
      { line: 4, name: 'database-url-credential' },
      { line: 5, name: 'database-url-credential' },
    ]);
  });

  it('fails closed for binary content without a known extension', () => {
    const result = scanSecretCandidate({
      file: 'assets/opaque-data',
      tracked: true,
      byteLength: 3,
      contents: Uint8Array.of(0xff, 0x00, 0xfe),
    });

    expect(result.findings).toEqual([
      {
        file: 'assets/opaque-data',
        line: null,
        name: 'binary-file',
        tracked: true,
      },
    ]);
    expect(result.inspected).toBe(false);
    expect(result.totalFindings).toBe(1);
    expect(result.truncatedFindings).toBe(0);
  });
});
