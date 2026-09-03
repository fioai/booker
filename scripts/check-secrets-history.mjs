/* global process, Buffer, URL */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

import {
  MAX_RETAINED_RESULTS,
  MAX_SCANNABLE_BYTES,
  scanSecretCandidate,
} from './lib/secret-scanner.mjs';

const defaultRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_FIELD_LENGTH = 512;
const MAX_BATCH_OBJECTS = 16 * 1024;
const MAX_BATCH_CONTENT_OBJECTS = 1024;
const MAX_BATCH_CONTENT_BYTES = 8 * 1024 * 1024;
const GIT_OBJECT_ID_EXPRESSION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_PATH_PREFIX = 'path=';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

class HistoryScanError extends Error {
  constructor() {
    super('Git history scan failed.');
  }
}

function help(stdout = process.stdout) {
  stdout.write(
    [
      'Usage: node scripts/check-secrets-history.mjs',
      '',
      'Scans every unique blob reachable from all Git refs, including deleted historical files.',
      'It reads Git objects directly and never checks out a commit or prints secret material.',
      'This is separate from the current-tree scan: use corepack pnpm scan:secrets for that scan.',
      'Known explicit placeholders are classified separately. Uninspectable blobs fail the gate.',
    ].join('\n') + '\n',
  );
}

function runGit(root, args, input, maxBuffer = GIT_OUTPUT_LIMIT) {
  let result;
  try {
    result = spawnSync('git', args, {
      cwd: root,
      ...(input === undefined ? {} : { input }),
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer,
    });
  } catch {
    throw new HistoryScanError();
  }

  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.signal !== null ||
    !Buffer.isBuffer(result.stdout)
  ) {
    throw new HistoryScanError();
  }
  return result.stdout;
}
function assertCompleteHistory(root) {
  const shallowState = decodeUtf8(runGit(root, ['rev-parse', '--is-shallow-repository']));
  if (shallowState !== 'false\n') {
    throw new HistoryScanError();
  }
}

function decodeUtf8(bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new HistoryScanError();
  }
}

function recordObject(objects, objectId, file) {
  const current = objects.get(objectId);
  if (current === undefined) {
    objects.set(objectId, { objectId, file });
    return;
  }
  if (file !== undefined && (current.file === undefined || file < current.file)) {
    current.file = file;
  }
}

function parseObjectListing(output) {
  const text = decodeUtf8(output);
  if (text.length === 0) {
    return new Map();
  }
  if (!text.endsWith('\0')) {
    throw new HistoryScanError();
  }

  const fields = text.split('\0');
  const objects = new Map();
  let pendingObjectId;
  for (let index = 0; index < fields.length - 1; index += 1) {
    const field = fields[index];
    if (field.length === 0) {
      throw new HistoryScanError();
    }

    if (GIT_OBJECT_ID_EXPRESSION.test(field)) {
      if (pendingObjectId !== undefined) {
        recordObject(objects, pendingObjectId);
      }
      pendingObjectId = field;
      continue;
    }

    if (!field.startsWith(GIT_PATH_PREFIX) || pendingObjectId === undefined) {
      throw new HistoryScanError();
    }
    const file = field.slice(GIT_PATH_PREFIX.length);
    if (file.length === 0) {
      throw new HistoryScanError();
    }
    recordObject(objects, pendingObjectId, file);
    pendingObjectId = undefined;
  }

  if (pendingObjectId !== undefined) {
    recordObject(objects, pendingObjectId);
  }
  return objects;
}

function parseObjectSize(sizeText) {
  if (!/^\d+$/u.test(sizeText)) {
    throw new HistoryScanError();
  }

  let size;
  try {
    size = BigInt(sizeText);
  } catch {
    throw new HistoryScanError();
  }
  return size > BigInt(MAX_SCANNABLE_BYTES) ? MAX_SCANNABLE_BYTES + 1 : Number(size);
}

function parseBatchCheck(output, objectIds) {
  const text = decodeUtf8(output);
  if (!text.endsWith('\n')) {
    throw new HistoryScanError();
  }

  const lines = text.split('\n');
  if (lines.length !== objectIds.length + 1) {
    throw new HistoryScanError();
  }

  const objects = [];
  for (const [index, line] of lines.slice(0, -1).entries()) {
    const fields = line.split(' ');
    if (fields.length !== 3 || fields[0] !== objectIds[index]) {
      throw new HistoryScanError();
    }
    const type = fields[1];
    if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
      throw new HistoryScanError();
    }
    objects.push({ objectId: fields[0], type, byteLength: parseObjectSize(fields[2]) });
  }
  return objects;
}

function inspectObjects(root, objectIds) {
  const inspected = new Map();
  for (let start = 0; start < objectIds.length; start += MAX_BATCH_OBJECTS) {
    const batch = objectIds.slice(start, start + MAX_BATCH_OBJECTS);
    const output = runGit(
      root,
      ['cat-file', '--batch-check'],
      `${batch.join('\n')}\n`,
      GIT_OUTPUT_LIMIT,
    );
    for (const object of parseBatchCheck(output, batch)) {
      inspected.set(object.objectId, object);
    }
  }
  return inspected;
}

function parseBatchContents(output, blobs) {
  const contents = new Map();
  let offset = 0;
  for (const blob of blobs) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new HistoryScanError();
    }

    const header = decodeUtf8(output.subarray(offset, headerEnd));
    const fields = header.split(' ');
    if (
      fields.length !== 3 ||
      fields[0] !== blob.objectId ||
      fields[1] !== 'blob' ||
      parseObjectSize(fields[2]) !== blob.byteLength
    ) {
      throw new HistoryScanError();
    }

    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + blob.byteLength;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
      throw new HistoryScanError();
    }
    contents.set(blob.objectId, output.subarray(contentStart, contentEnd));
    offset = contentEnd + 1;
  }

  if (offset !== output.length) {
    throw new HistoryScanError();
  }
  return contents;
}

function readBlobBatch(root, blobs) {
  const output = runGit(
    root,
    ['cat-file', '--batch'],
    `${blobs.map(({ objectId }) => objectId).join('\n')}\n`,
  );
  return parseBatchContents(output, blobs);
}

function collectResult(aggregate, result) {
  aggregate.scannedSnapshots += result.inspected ? 1 : 0;
  aggregate.totalFindings += result.totalFindings;
  aggregate.totalPlaceholders += result.totalPlaceholders;

  for (const finding of result.findings) {
    if (aggregate.findings.length === MAX_RETAINED_RESULTS) {
      break;
    }
    aggregate.findings.push(finding);
  }
  for (const placeholder of result.placeholders) {
    if (aggregate.placeholders.length === MAX_RETAINED_RESULTS) {
      break;
    }
    aggregate.placeholders.push(placeholder);
  }
}

function scanBlob(aggregate, blob, contents) {
  const candidate = {
    file: blob.file,
    tracked: true,
    byteLength: blob.byteLength,
    ...(contents === undefined ? {} : { contents }),
  };
  collectResult(aggregate, scanSecretCandidate(candidate));
}

function scanBlobs(root, blobs, aggregate) {
  let batch = [];
  let batchBytes = 0;

  const flush = () => {
    if (batch.length === 0) {
      return;
    }
    const contents = readBlobBatch(root, batch);
    for (const blob of batch) {
      scanBlob(aggregate, blob, contents.get(blob.objectId));
    }
    batch = [];
    batchBytes = 0;
  };

  for (const blob of blobs) {
    if (blob.byteLength > MAX_SCANNABLE_BYTES) {
      flush();
      scanBlob(aggregate, blob);
      continue;
    }

    if (
      batch.length >= MAX_BATCH_CONTENT_OBJECTS ||
      (batch.length > 0 && batchBytes + blob.byteLength > MAX_BATCH_CONTENT_BYTES)
    ) {
      flush();
    }
    batch.push(blob);
    batchBytes += blob.byteLength;
  }
  flush();
}

function diagnosticField(value) {
  const truncated = value.length > MAX_DIAGNOSTIC_FIELD_LENGTH;
  const limit = truncated ? MAX_DIAGNOSTIC_FIELD_LENGTH - 3 : value.length;
  let sanitized = '';
  for (let index = 0; index < limit; ) {
    const codePoint = value.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    if (index + width > limit) {
      break;
    }
    const isControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    sanitized += isControl ? '?' : value.slice(index, index + width);
    index += width;
  }
  return truncated ? sanitized + '...' : sanitized;
}
function diagnosticFile(value) {
  const contents = Buffer.from(value);
  const result = scanSecretCandidate({
    file: 'history-diagnostic',
    tracked: true,
    byteLength: contents.byteLength,
    contents,
  });
  return result.totalFindings > 0 ? '<redacted path>' : diagnosticField(value);
}

function createReport(aggregate) {
  const truncatedFindings = aggregate.totalFindings - aggregate.findings.length;
  const truncatedPlaceholders = aggregate.totalPlaceholders - aggregate.placeholders.length;

  if (aggregate.totalFindings > 0) {
    let stderr = `History secret scan failed: ${aggregate.totalFindings} finding(s).\n`;
    for (const finding of aggregate.findings) {
      const file = diagnosticFile(finding.file);
      const name = diagnosticField(finding.name);
      const location = finding.line === null ? file : `${file}:${finding.line}`;
      stderr += `  ${location} (${name}, Git history)\n`;
    }
    stderr +=
      'History secret scan totals: unique blobs ' +
      aggregate.uniqueBlobs +
      '; placeholders ' +
      aggregate.totalPlaceholders +
      '; retained finding diagnostics ' +
      aggregate.findings.length +
      '; truncated finding diagnostics ' +
      truncatedFindings +
      '; retained placeholder diagnostics ' +
      aggregate.placeholders.length +
      '; truncated placeholder diagnostics ' +
      truncatedPlaceholders +
      '.\n';
    return {
      exitCode: 1,
      stdout: '',
      stderr,
      truncatedFindings,
      truncatedPlaceholders,
    };
  }

  const stdout =
    'History secret scan passed: scanned ' +
    aggregate.uniqueBlobs +
    ' unique blob(s); inspected ' +
    aggregate.scannedSnapshots +
    ' text blob(s); ignored ' +
    aggregate.totalPlaceholders +
    ' explicit placeholder(s); findings 0.\n' +
    'History secret scan totals: retained finding diagnostics 0; truncated finding diagnostics 0; ' +
    'retained placeholder diagnostics ' +
    aggregate.placeholders.length +
    '; truncated placeholder diagnostics ' +
    truncatedPlaceholders +
    '.\n' +
    'Scope: Git history only. The current-tree scan is separate; use corepack pnpm scan:secrets.\n';
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    truncatedFindings,
    truncatedPlaceholders,
  };
}

/**
 * Scan every unique blob reachable from every Git ref without checking out a commit.
 *
 * @param {string} [root]
 * @returns {{ exitCode: number, stdout: string, stderr: string, uniqueBlobs: number, scannedSnapshots: number, totalFindings: number, totalPlaceholders: number, retainedFindings: number, retainedPlaceholders: number, truncatedFindings: number, truncatedPlaceholders: number }}
 */
export function runHistorySecretScan(root = defaultRoot) {
  const scanRoot = resolve(root);
  assertCompleteHistory(scanRoot);
  const objectEntries = parseObjectListing(
    runGit(scanRoot, ['-c', 'core.quotePath=false', 'rev-list', '--objects', '--all', '-z']),
  );
  const objectIds = [...objectEntries.keys()].sort();
  const objectInfo = inspectObjects(scanRoot, objectIds);
  const blobs = [];
  for (const objectId of objectIds) {
    const info = objectInfo.get(objectId);
    if (info === undefined) {
      throw new HistoryScanError();
    }
    if (info.type !== 'blob') {
      continue;
    }
    blobs.push({
      objectId,
      file: objectEntries.get(objectId)?.file ?? '(unmapped blob)',
      byteLength: info.byteLength,
    });
  }

  const aggregate = {
    findings: [],
    placeholders: [],
    uniqueBlobs: blobs.length,
    scannedSnapshots: 0,
    totalFindings: 0,
    totalPlaceholders: 0,
  };
  scanBlobs(scanRoot, blobs, aggregate);

  const report = createReport(aggregate);
  return {
    exitCode: report.exitCode,
    stdout: report.stdout,
    stderr: report.stderr,
    uniqueBlobs: aggregate.uniqueBlobs,
    scannedSnapshots: aggregate.scannedSnapshots,
    totalFindings: aggregate.totalFindings,
    totalPlaceholders: aggregate.totalPlaceholders,
    retainedFindings: aggregate.findings.length,
    retainedPlaceholders: aggregate.placeholders.length,
    truncatedFindings: report.truncatedFindings,
    truncatedPlaceholders: report.truncatedPlaceholders,
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--help')) {
      help();
    } else {
      const result = runHistorySecretScan();
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    }
  } catch {
    process.stderr.write('History secret scan failed: Git command or protocol error.\n');
    process.exitCode = 1;
  }
}
