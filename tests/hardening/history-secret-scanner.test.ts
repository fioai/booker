import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { runSecretScan } from '../../scripts/check-secrets.mjs';
import { runHistorySecretScan } from '../../scripts/check-secrets-history.mjs';
import { MAX_RETAINED_RESULTS, MAX_SCANNABLE_BYTES } from '../../scripts/lib/secret-scanner.mjs';

const root = resolve(import.meta.dirname, '../..');
const historyScript = resolve(root, 'scripts/check-secrets-history.mjs');

function runGit(repository: string, args: readonly string[]) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

function createRepository(prefix: string): string {
  const repository = mkdtempSync(resolve(tmpdir(), prefix));
  runGit(repository, ['init', '--quiet']);
  return repository;
}

function commit(repository: string, message: string): void {
  runGit(repository, [
    '-c',
    'user.name=History Scanner Test',
    '-c',
    'user.email=history-scanner@example.test',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    message,
  ]);
}

function writeRepositoryFile(
  repository: string,
  file: string,
  contents: string | Uint8Array,
): void {
  const path = resolve(repository, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe('Git-history secret scanner', () => {
  it('finds a secret in a deleted historical file that current-tree scanning cannot see', () => {
    const repository = createRepository('booking-engine-history-deleted-');
    const credential = ['sk', 'live', 'deletedhistorycredential'].join('_');
    const file = 'old/config.env';

    try {
      writeRepositoryFile(repository, file, `TOKEN=${credential}\n`);
      runGit(repository, ['add', '--', file]);
      commit(repository, 'add old configuration');
      runGit(repository, ['rm', '--quiet', '--', file]);
      commit(repository, 'remove old configuration');

      const currentTree = runSecretScan(repository);
      expect(currentTree).toMatchObject({ exitCode: 0, totalFindings: 0 });

      const history = runHistorySecretScan(repository);
      expect(history).toMatchObject({
        exitCode: 1,
        uniqueBlobs: 1,
        totalFindings: 1,
        retainedFindings: 1,
      });
      expect(history.stderr).toContain(`${file}:1 (live-provider-key, Git history)`);
      expect(history.stderr).not.toContain(credential);
      expect(history.stdout).toBe('');
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });
  it('scans a blob reachable only from another Git ref', () => {
    const repository = createRepository('booking-engine-history-refs-');
    const credential = ['sk', 'live', 'sidebranchcredential'].join('_');
    const file = 'side/only.env';

    try {
      writeRepositoryFile(repository, 'safe/config.env', 'MODE=local\n');
      runGit(repository, ['add', '--', '.']);
      commit(repository, 'add base configuration');
      runGit(repository, ['branch', 'release-candidate']);
      runGit(repository, ['switch', '--quiet', 'release-candidate']);

      writeRepositoryFile(repository, file, `TOKEN=${credential}\n`);
      runGit(repository, ['add', '--', file]);
      commit(repository, 'add side branch credential');
      runGit(repository, ['switch', '--quiet', '-']);

      const currentTree = runSecretScan(repository);
      expect(currentTree).toMatchObject({ exitCode: 0, totalFindings: 0 });

      const history = runHistorySecretScan(repository);
      expect(history).toMatchObject({ exitCode: 1, totalFindings: 1 });
      expect(history.stderr).toContain(`${file}:1 (live-provider-key, Git history)`);
      expect(history.stderr).not.toContain(credential);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('passes clean history and documents the separate current-tree scope', () => {
    const repository = createRepository('booking-engine-history-clean-');

    try {
      writeRepositoryFile(repository, 'safe/config.env', 'TOKEN=local-development\n');
      runGit(repository, ['add', '--', '.']);
      commit(repository, 'add clean configuration');

      const result = runHistorySecretScan(repository);
      expect(result).toMatchObject({
        exitCode: 0,
        uniqueBlobs: 1,
        scannedSnapshots: 1,
        totalFindings: 0,
        totalPlaceholders: 0,
      });
      expect(result.stdout).toContain('Scope: Git history only.');
      expect(result.stdout).toContain('corepack pnpm scan:secrets');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('scans duplicate content once by unique Git blob ID', () => {
    const repository = createRepository('booking-engine-history-duplicates-');
    const contents = 'shared historical content\n';

    try {
      writeRepositoryFile(repository, 'one/config.env', contents);
      writeRepositoryFile(repository, 'two/config.env', contents);
      runGit(repository, ['add', '--', '.']);
      commit(repository, 'add duplicate content');

      const result = runHistorySecretScan(repository);
      expect(result).toMatchObject({
        exitCode: 0,
        uniqueBlobs: 1,
        scannedSnapshots: 1,
        totalFindings: 0,
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('reuses binary and size failure rules for historical blobs', () => {
    const repository = createRepository('booking-engine-history-limits-');
    const binaryFile = 'archive/opaque-data';
    const oversizedFile = 'archive/large.env';

    try {
      writeRepositoryFile(repository, binaryFile, Uint8Array.of(0xff, 0x00, 0xfe));
      writeRepositoryFile(
        repository,
        oversizedFile,
        new Uint8Array(MAX_SCANNABLE_BYTES + 1).fill(0x61),
      );
      runGit(repository, ['add', '--', '.']);
      commit(repository, 'add uninspectable blobs');

      const result = runHistorySecretScan(repository);
      expect(result).toMatchObject({
        exitCode: 1,
        uniqueBlobs: 2,
        scannedSnapshots: 0,
        totalFindings: 2,
      });
      expect(result.stderr).toContain(`${binaryFile} (binary-file, Git history)`);
      expect(result.stderr).toContain(`${oversizedFile} (file-over-size-limit, Git history)`);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('accepts safe paths with spaces and punctuation', () => {
    const repository = createRepository('booking-engine-history-paths-');
    const file = 'safe paths/[release] settings.env';

    try {
      writeRepositoryFile(repository, file, 'MODE=local\n');
      runGit(repository, ['add', '--', '.']);
      commit(repository, 'add unusual safe path');

      const result = runHistorySecretScan(repository);
      expect(result).toMatchObject({
        exitCode: 0,
        uniqueBlobs: 1,
        totalFindings: 0,
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('keeps historical finding diagnostics bounded and redacted', () => {
    const repository = createRepository('booking-engine-history-redaction-');
    const credentials = Array.from({ length: MAX_RETAINED_RESULTS + 9 }, (_, index) =>
      ['sk', 'live', `historyredaction${index.toString().padStart(8, '0')}`].join('_'),
    );
    const pathCredential = ['sk', 'live', 'historyfilenamecredential'].join('_');
    const file = `config/${pathCredential}.env`;

    try {
      writeRepositoryFile(repository, file, `${credentials.join('\n')}\n`);
      runGit(repository, ['add', '--', file]);
      commit(repository, 'add many historical credentials');

      const result = runHistorySecretScan(repository);
      expect(result).toMatchObject({
        exitCode: 1,
        uniqueBlobs: 1,
        totalFindings: credentials.length,
        retainedFindings: MAX_RETAINED_RESULTS,
        truncatedFindings: credentials.length - MAX_RETAINED_RESULTS,
      });
      expect(result.stderr).toContain('<redacted path>:1 (live-provider-key, Git history)');
      expect(result.stderr).not.toContain(credentials[0]);
      expect(result.stderr).not.toContain(credentials.at(-1) ?? '');
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(MAX_RETAINED_RESULTS + 2);
      expect(result.stderr.length).toBeLessThan(16 * 1024);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('fails closed on Git command failure without exposing command output', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'booking-engine-history-failure-'));
    const copiedScript = resolve(directory, 'scripts/check-secrets-history.mjs');

    try {
      mkdirSync(resolve(directory, 'scripts/lib'), { recursive: true });
      copyFileSync(historyScript, copiedScript);
      copyFileSync(
        resolve(root, 'scripts/lib/secret-scanner.mjs'),
        resolve(directory, 'scripts/lib/secret-scanner.mjs'),
      );
      const result = spawnSync(process.execPath, [copiedScript], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toBe(
        'History secret scan failed: Git command or protocol error.\n',
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('exposes a help entrypoint for the history command', () => {
    const result = spawnSync(process.execPath, [historyScript, '--help'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/check-secrets-history.mjs');
    expect(result.stdout).toContain('all Git refs');
  });
});
