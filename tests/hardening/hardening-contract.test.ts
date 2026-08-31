import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { createPropertyConfiguration } from '../../packages/booking-core/src/index.js';
import { SAMPLE_DATA } from '../../scripts/seed-sample.mjs';
import { runSecretScan } from '../../scripts/check-secrets.mjs';
import { MAX_RETAINED_RESULTS } from '../../scripts/lib/secret-scanner.mjs';

const root = resolve(import.meta.dirname, '../..');

function runScript(script: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function runGit(repository: string, args: readonly string[]) {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

describe('hardening entrypoints', () => {
  it('accepts an explicit local runtime environment without printing credentials', () => {
    const result = runScript('scripts/check-env.mjs', ['--runtime'], {
      BOOKING_ENGINE_ENV: 'local',
      DATABASE_URL:
        'postgresql://booking_engine_local:local-only-placeholder@127.0.0.1:15432/booking_engine_local',
      DATABASE_SCHEMA: 'public',
      PORT: '3000',
      HOST: '127.0.0.1',
      BOOKING_ENGINE_ORGANIZATION_ID: 'sample-tenant',
      BOOKING_ENGINE_PROPERTY_ID: 'sample-bungalow',
      BOOKING_ENGINE_SAMPLE_DATA: 'false',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Environment validation passed');
    expect(result.stdout).not.toContain('local-only-placeholder');
  });

  it('fails closed when sample data is requested in production', () => {
    const result = runScript('scripts/check-env.mjs', ['--runtime'], {
      BOOKING_ENGINE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:local-only-placeholder@example.test/booking',
      DATABASE_SCHEMA: 'public',
      PORT: '3000',
      HOST: '127.0.0.1',
      BOOKING_ENGINE_ORGANIZATION_ID: 'sample-tenant',
      BOOKING_ENGINE_PROPERTY_ID: 'sample-bungalow',
      BOOKING_ENGINE_SAMPLE_DATA: 'true',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('sample data is disabled');
  });

  it('scans staged index divergence and non-ignored untracked files', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'booking-engine-secret-scan-'));
    const credentialCount = MAX_RETAINED_RESULTS + 17;
    const placeholderCount = MAX_RETAINED_RESULTS + 5;
    const credentials = Array.from({ length: credentialCount }, (_, index) =>
      ['sk', 'live', `commandcredential${index.toString().padStart(8, '0')}`].join('_'),
    );
    const placeholders = Array.from({ length: placeholderCount }, () =>
      ['sk', 'live', 'never_allowed'].join('_'),
    );
    const commaPassword = ['command', 'comma', 'secret'].join('-');
    const semicolonPassword = ['command', 'semicolon', 'secret'].join('-');
    const databasePasswords = [commaPassword, semicolonPassword];
    const historicalCredential = ['sk', 'live', 'historicalcredential'].join('_');
    const untrackedCredential = ['sk', 'live', 'untrackedcredential'].join('_');
    const cleanStagedContents = 'clean staged-file configuration\n';
    const cleanHistoricalContents = 'clean historical-file replacement\n';
    const untrackedFile = '00-untracked.env';
    const credentialFreeUrl = ['postgresql', '://localhost/booking'].join('');
    const malformedUrl = ['postgresql', '://[broken'].join('');
    const indexContents =
      [
        [
          credentialFreeUrl,
          ',',
          ['postgresql', '://user:', commaPassword, '@localhost/booking'].join(''),
        ].join(''),
        [
          malformedUrl,
          ';',
          ['postgresql', '://user:', semicolonPassword, '@localhost/booking'].join(''),
        ].join(''),
      ].join('\n') +
      '\n' +
      credentials.join('\n') +
      '\n' +
      placeholders.join('\n');
    const expectedFindings = credentialCount + databasePasswords.length + 1;

    try {
      runGit(repository, ['init', '--quiet']);
      writeFileSync(resolve(repository, 'staged.env'), cleanStagedContents);
      writeFileSync(resolve(repository, 'historical.env'), historicalCredential);
      runGit(repository, ['add', '--', 'staged.env', 'historical.env']);
      runGit(repository, [
        '-c',
        'user.name=Hardening Test',
        '-c',
        'user.email=hardening@example.test',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'scanner fixture',
      ]);

      writeFileSync(resolve(repository, 'staged.env'), indexContents);
      runGit(repository, ['add', '--', 'staged.env']);
      writeFileSync(resolve(repository, 'staged.env'), cleanStagedContents);
      writeFileSync(resolve(repository, 'historical.env'), cleanHistoricalContents);
      writeFileSync(resolve(repository, untrackedFile), `${untrackedCredential}\n`);

      const result = runSecretScan(repository);

      expect(result).toEqual({
        exitCode: 1,
        stdout: '',
        stderr: expect.any(String),
        scannedSnapshots: 4,
        totalFindings: expectedFindings,
        totalPlaceholders: placeholderCount,
        retainedFindings: MAX_RETAINED_RESULTS,
        retainedPlaceholders: MAX_RETAINED_RESULTS,
        truncatedFindings: expectedFindings - MAX_RETAINED_RESULTS,
        truncatedPlaceholders: placeholderCount - MAX_RETAINED_RESULTS,
      });
      expect(result.stderr).toContain(`Secret scan failed: ${expectedFindings} finding(s).`);
      expect(result.stderr).toContain(`${untrackedFile}:1 (live-provider-key, working tree)`);
      expect(result.stderr).toContain('(database-url-credential, index)');
      expect(result.stderr).toContain(
        `truncated finding diagnostics ${expectedFindings - MAX_RETAINED_RESULTS}`,
      );
      expect(result.stderr).toContain(
        `truncated placeholder diagnostics ${placeholderCount - MAX_RETAINED_RESULTS}`,
      );
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(MAX_RETAINED_RESULTS + 2);
      for (const secret of databasePasswords) {
        expect(result.stderr).not.toContain(secret);
      }
      for (const credential of [...credentials, untrackedCredential]) {
        expect(result.stderr).not.toContain(credential);
      }
      expect(result.stderr).not.toContain(historicalCredential);

      runGit(repository, ['add', '--', 'staged.env']);
      writeFileSync(resolve(repository, untrackedFile), 'clean untracked configuration\n');
      runGit(repository, ['mv', 'staged.env', 'renamed.env']);
      const identicalResult = runSecretScan(repository);
      expect(identicalResult).toMatchObject({
        exitCode: 0,
        scannedSnapshots: 3,
        totalFindings: 0,
        totalPlaceholders: 0,
        retainedFindings: 0,
        retainedPlaceholders: 0,
        truncatedFindings: 0,
        truncatedPlaceholders: 0,
      });
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it('fails closed on an unmerged index without exposing conflict-stage credentials', () => {
    const repository = mkdtempSync(resolve(tmpdir(), 'booking-engine-unmerged-index-scan-'));
    const conflictFile = 'conflicted.env';
    const credential = ['sk', 'live', 'unmergedindexcredential'].join('_');
    const baseContents = 'HEADER=stable\nSTATUS=base\nFOOTER=stable\n';
    const currentContents = 'HEADER=stable\nSTATUS=current\nFOOTER=stable\n';
    const sanitizedWorktreeContents = 'HEADER=stable\nSTATUS=sanitized\nFOOTER=stable\n';
    const scannerPath = resolve(repository, 'scripts/check-secrets.mjs');

    try {
      mkdirSync(resolve(repository, 'scripts/lib'), { recursive: true });
      copyFileSync(resolve(root, 'scripts/check-secrets.mjs'), scannerPath);
      copyFileSync(
        resolve(root, 'scripts/lib/secret-scanner.mjs'),
        resolve(repository, 'scripts/lib/secret-scanner.mjs'),
      );
      writeFileSync(resolve(repository, conflictFile), baseContents);
      runGit(repository, ['init', '--quiet']);
      runGit(repository, ['add', '--', 'scripts', conflictFile]);
      runGit(repository, [
        '-c',
        'user.name=Hardening Test',
        '-c',
        'user.email=hardening@example.test',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'unmerged scanner base',
      ]);

      runGit(repository, ['checkout', '--quiet', '-b', 'incoming']);
      writeFileSync(
        resolve(repository, conflictFile),
        `HEADER=stable\nSTATUS=${credential}\nFOOTER=stable\n`,
      );
      runGit(repository, ['add', '--', conflictFile]);
      runGit(repository, [
        '-c',
        'user.name=Hardening Test',
        '-c',
        'user.email=hardening@example.test',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'incoming conflict credential',
      ]);

      runGit(repository, ['checkout', '--quiet', '-b', 'current', 'HEAD~1']);
      writeFileSync(resolve(repository, conflictFile), currentContents);
      runGit(repository, ['add', '--', conflictFile]);
      runGit(repository, [
        '-c',
        'user.name=Hardening Test',
        '-c',
        'user.email=hardening@example.test',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '--quiet',
        '--no-verify',
        '-m',
        'current sanitized conflict',
      ]);

      const merge = spawnSync(
        'git',
        [
          '-c',
          'user.name=Hardening Test',
          '-c',
          'user.email=hardening@example.test',
          '-c',
          'commit.gpgSign=false',
          '-c',
          'core.hooksPath=/dev/null',
          'merge',
          '--no-commit',
          '--no-ff',
          'incoming',
        ],
        {
          cwd: repository,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      expect(merge.status).not.toBe(0);

      const unmergedEntries = runGit(repository, [
        'ls-files',
        '--unmerged',
        '--stage',
        '-z',
        '--',
        conflictFile,
      ])
        .stdout.split('\0')
        .filter((entry) => entry.length > 0);
      const unmergedStages = unmergedEntries.map((entry) => {
        const metadata = / ([1-3])\t(.*)$/su.exec(entry);
        if (metadata === null) {
          throw new Error('Unable to parse unmerged test index entry.');
        }
        expect(metadata[2]).toBe(conflictFile);
        return metadata[1];
      });
      expect(unmergedStages).toEqual(['1', '2', '3']);
      const credentialStage = unmergedStages.find((stage) =>
        runGit(repository, ['show', `:${stage}:${conflictFile}`]).stdout.includes(credential),
      );
      expect(credentialStage).toBe('3');
      const [reportedStage] = unmergedStages;
      if (reportedStage === undefined) {
        throw new Error('Expected an unmerged test index entry.');
      }

      writeFileSync(resolve(repository, conflictFile), sanitizedWorktreeContents);
      expect(readFileSync(resolve(repository, conflictFile), 'utf8')).toBe(
        sanitizedWorktreeContents,
      );

      const result = spawnSync(process.execPath, [scannerPath], {
        cwd: repository,
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `Secret scan failed: unmerged Git index entry at "${conflictFile}" (stage ${reportedStage}).\n`,
      );
      expect(output.length).toBeLessThanOrEqual(1024);
      expect(output).not.toContain(credential);
    } finally {
      rmSync(repository, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'reads stage-0 object IDs for colon paths, which Windows worktrees cannot contain',
    () => {
      const repository = mkdtempSync(resolve(tmpdir(), 'booking-engine-colon-index-scan-'));
      const stageLikeFile = '0:foo';
      const ambiguousFile = 'foo';
      const stagedCredential = ['sk', 'live', 'stagefilenamecredential'].join('_');
      const cleanStageLikeContents = 'clean stage-like path configuration\n';
      const cleanAmbiguousContents = 'clean ordinary path configuration\n';

      try {
        runGit(repository, ['init', '--quiet']);
        writeFileSync(resolve(repository, stageLikeFile), cleanStageLikeContents);
        writeFileSync(resolve(repository, ambiguousFile), cleanAmbiguousContents);
        runGit(repository, ['add', '--', stageLikeFile, ambiguousFile]);
        runGit(repository, [
          '-c',
          'user.name=Hardening Test',
          '-c',
          'user.email=hardening@example.test',
          '-c',
          'commit.gpgSign=false',
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--quiet',
          '--no-verify',
          '-m',
          'colon scanner fixture',
        ]);

        writeFileSync(resolve(repository, stageLikeFile), `${stagedCredential}\n`);
        runGit(repository, ['add', '--', stageLikeFile]);
        writeFileSync(resolve(repository, stageLikeFile), cleanStageLikeContents);

        const result = runSecretScan(repository);

        expect(result).toEqual({
          exitCode: 1,
          stdout: '',
          stderr: expect.any(String),
          scannedSnapshots: 3,
          totalFindings: 1,
          totalPlaceholders: 0,
          retainedFindings: 1,
          retainedPlaceholders: 0,
          truncatedFindings: 0,
          truncatedPlaceholders: 0,
        });
        expect(result.stderr).toContain(`${stageLikeFile}:1 (live-provider-key, index)`);
        expect(result.stderr).not.toContain(stagedCredential);
      } finally {
        rmSync(repository, { force: true, recursive: true });
      }
    },
  );

  it('declares a clean Docker build and app health path', () => {
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const compose = readFileSync(resolve(root, 'docker-compose.yml'), 'utf8');
    const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');
    expect(dockerfile).toContain('pnpm build');
    expect(dockerfile).toContain('scripts/run-api.mjs');
    expect(compose).toContain('healthz');
    expect(compose).toContain('depends_on:');
    expect(dockerignore).toContain('node_modules');
    expect(dockerignore).toContain('.env');
  });

  it('keeps deterministic sample data valid against the domain configuration invariants', () => {
    const result = createPropertyConfiguration({
      ...SAMPLE_DATA.property,
      bedConfiguration: [...SAMPLE_DATA.property.bedConfiguration],
      amenities: [...SAMPLE_DATA.property.amenities],
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
    expect(SAMPLE_DATA.property).toMatchObject({
      name: 'Sample Garden Bungalow',
      maximumGuests: 2,
      bedConfiguration: [{ type: 'double', quantity: 1 }],
    });
    expect(SAMPLE_DATA.rate.cleaningFeeMinor).toBe(0);
    expect(JSON.stringify(SAMPLE_DATA.property)).not.toMatch(/pool/iu);
  });

  it('exposes real smoke, backup/restore, and secret-scan commands', () => {
    for (const script of [
      'scripts/smoke-request-to-book.mjs',
      'scripts/backup-restore-check.mjs',
      'scripts/check-secrets.mjs',
      'scripts/docker-clean-room.mjs',
      'scripts/migrate.mjs',
    ]) {
      expect(existsSync(resolve(root, script)), script).toBe(true);
      const result = runScript(script, ['--help']);
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('Usage:');
    }
  });
});
