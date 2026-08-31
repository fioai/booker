/* global process, URL */

import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_RETAINED_RESULTS,
  MAX_SCANNABLE_BYTES,
  scanSecretCandidate,
} from './lib/secret-scanner.mjs';

const defaultRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_FIELD_LENGTH = 512;

class UnmergedIndexError extends Error {
  constructor(file, stage) {
    super('Git index contains an unmerged entry.');
    this.file = file;
    this.stage = stage;
  }
}

function help(stdout = process.stdout) {
  stdout.write(
    [
      'Usage: node scripts/check-secrets.mjs',
      '',
      'Scans tracked, staged, and non-ignored working-tree files without printing secret material.',
      'Known explicit placeholders are classified separately. Uninspectable candidates fail the gate.',
    ].join('\n') + '\n',
  );
}

function gitFiles(root, args) {
  const output = execFileSync('git', args, {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: GIT_OUTPUT_LIMIT,
  }).toString('utf8');
  return output.split('\0').filter((file) => file.length > 0);
}

function gitIndex(root) {
  const files = new Set();
  const stageZeroObjectIds = new Map();
  for (const entry of gitFiles(root, ['ls-files', '--stage', '-z'])) {
    const separator = entry.indexOf('\t');
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error('Unable to parse Git index entry.');
    }
    const metadata = /^([0-7]{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([0-3])$/u.exec(
      entry.slice(0, separator),
    );
    if (metadata === null) {
      throw new Error('Unable to parse Git index metadata.');
    }

    const file = entry.slice(separator + 1);
    const stage = metadata[3];
    if (stage !== '0') {
      throw new UnmergedIndexError(file, stage);
    }

    files.add(file);
    if (stageZeroObjectIds.has(file)) {
      throw new Error('Git index contains duplicate stage-0 entries.');
    }
    stageZeroObjectIds.set(file, metadata[2]);
  }
  return { files, stageZeroObjectIds };
}

function filesToScan(root, trackedFiles) {
  const candidates = new Map();
  for (const file of trackedFiles) {
    candidates.set(file, true);
  }
  for (const file of gitFiles(root, ['ls-files', '--others', '--exclude-standard', '-z'])) {
    if (!candidates.has(file)) {
      candidates.set(file, false);
    }
  }

  const sortedCandidates = [];
  for (const [file, tracked] of candidates) {
    sortedCandidates.push({ file, tracked });
  }
  sortedCandidates.sort((left, right) => {
    if (left.file < right.file) {
      return -1;
    }
    if (left.file > right.file) {
      return 1;
    }
    return 0;
  });
  return sortedCandidates;
}

function workingSnapshot(root, file, tracked) {
  const path = resolve(root, file);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return {
      contents: undefined,
      candidate: { file, tracked, byteLength: 0 },
    };
  }

  let contents;
  if (metadata.isFile() && metadata.size <= MAX_SCANNABLE_BYTES) {
    try {
      contents = readFileSync(path);
    } catch {
      contents = undefined;
    }
  }
  return {
    contents,
    candidate: {
      file,
      tracked,
      byteLength: metadata.size,
      ...(contents === undefined ? {} : { contents }),
    },
  };
}

function indexSnapshot(root, file, objectId) {
  if (objectId === undefined) {
    return {
      contents: undefined,
      candidate: { file, tracked: true, byteLength: 0 },
    };
  }

  let byteLength;
  try {
    const output = execFileSync('git', ['cat-file', '-s', objectId], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1024,
    });
    byteLength = Number.parseInt(output.trim(), 10);
  } catch {
    byteLength = Number.NaN;
  }

  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    return {
      contents: undefined,
      candidate: { file, tracked: true, byteLength: 0 },
    };
  }

  let contents;
  if (byteLength <= MAX_SCANNABLE_BYTES) {
    try {
      contents = execFileSync('git', ['cat-file', 'blob', objectId], {
        cwd: root,
        encoding: 'buffer',
        maxBuffer: MAX_SCANNABLE_BYTES + 1024,
      });
    } catch {
      contents = undefined;
    }
  }
  return {
    contents,
    candidate: {
      file,
      tracked: true,
      byteLength,
      ...(contents === undefined ? {} : { contents }),
    },
  };
}

function collectResult(aggregate, result, snapshot) {
  aggregate.totalFindings += result.totalFindings;
  aggregate.totalPlaceholders += result.totalPlaceholders;
  if (result.inspected) {
    aggregate.scannedSnapshots += 1;
  }

  for (const finding of result.findings) {
    if (aggregate.findings.length === MAX_RETAINED_RESULTS) {
      break;
    }
    aggregate.findings.push({ ...finding, snapshot });
  }
  for (const placeholder of result.placeholders) {
    if (aggregate.placeholders.length === MAX_RETAINED_RESULTS) {
      break;
    }
    aggregate.placeholders.push({ ...placeholder, snapshot });
  }
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

function createReport(aggregate) {
  const truncatedFindings = aggregate.totalFindings - aggregate.findings.length;
  const truncatedPlaceholders = aggregate.totalPlaceholders - aggregate.placeholders.length;

  if (aggregate.totalFindings > 0) {
    let stderr = `Secret scan failed: ${aggregate.totalFindings} finding(s).\n`;
    for (const finding of aggregate.findings) {
      const file = diagnosticField(finding.file);
      const name = diagnosticField(finding.name);
      const snapshot = diagnosticField(finding.snapshot);
      const location = finding.line === null ? file : `${file}:${finding.line}`;
      stderr += `  ${location} (${name}, ${snapshot})\n`;
    }
    stderr +=
      'Secret scan totals: placeholders ' +
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
    'Secret scan passed: inspected ' +
    aggregate.scannedSnapshots +
    ' text snapshot(s); ignored ' +
    aggregate.totalPlaceholders +
    ' explicit placeholder(s); findings 0.\n' +
    'Secret scan totals: retained finding diagnostics 0; truncated finding diagnostics 0; ' +
    'retained placeholder diagnostics ' +
    aggregate.placeholders.length +
    '; truncated placeholder diagnostics ' +
    truncatedPlaceholders +
    '.\n' +
    'Limitation: this deterministic scan does not inspect external secret stores, Git history, or high-entropy values without a known marker.\n';
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    truncatedFindings,
    truncatedPlaceholders,
  };
}

/**
 * Scan tracked and non-ignored working-tree files plus index blobs staged relative to HEAD.
 *
 * @param {string} [root]
 * @returns {{ exitCode: number, stdout: string, stderr: string, scannedSnapshots: number, totalFindings: number, totalPlaceholders: number, retainedFindings: number, retainedPlaceholders: number, truncatedFindings: number, truncatedPlaceholders: number }}
 */
export function runSecretScan(root = defaultRoot) {
  const scanRoot = resolve(root);
  const aggregate = {
    findings: [],
    placeholders: [],
    scannedSnapshots: 0,
    totalFindings: 0,
    totalPlaceholders: 0,
  };
  const indexState = gitIndex(scanRoot);
  const stagedFiles = new Set(
    gitFiles(scanRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z']),
  );

  for (const candidate of filesToScan(scanRoot, indexState.files)) {
    const working = workingSnapshot(scanRoot, candidate.file, candidate.tracked);
    collectResult(aggregate, scanSecretCandidate(working.candidate), 'working tree');

    if (!candidate.tracked || !stagedFiles.has(candidate.file)) {
      continue;
    }

    const index = indexSnapshot(
      scanRoot,
      candidate.file,
      indexState.stageZeroObjectIds.get(candidate.file),
    );
    if (
      working.contents !== undefined &&
      index.contents !== undefined &&
      working.contents.equals(index.contents)
    ) {
      continue;
    }
    collectResult(aggregate, scanSecretCandidate(index.candidate), 'index');
  }

  const report = createReport(aggregate);
  return {
    exitCode: report.exitCode,
    stdout: report.stdout,
    stderr: report.stderr,
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
      const result = runSecretScan();
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    }
  } catch (error) {
    if (error instanceof UnmergedIndexError) {
      const file = diagnosticField(error.file);
      process.stderr.write(
        `Secret scan failed: unmerged Git index entry at "${file}" (stage ${error.stage}).\n`,
      );
    } else {
      process.stderr.write('Secret scan failed: command execution failed.\n');
    }
    process.exitCode = 1;
  }
}
