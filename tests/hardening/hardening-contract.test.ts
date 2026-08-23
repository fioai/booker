import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';
import { createPropertyConfigurationV1 } from '../../packages/booking-core/src/index.js';
import { SAMPLE_DATA_V1 } from '../../scripts/seed-sample.mjs';

const root = resolve(import.meta.dirname, '../..');

function runScript(script: string, args: readonly string[] = [], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [resolve(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('hardening entrypoints', () => {
  it('accepts an explicit local runtime environment without printing credentials', () => {
    const result = runScript('scripts/check-env.mjs', ['--runtime'], {
      LOTUS_ENV: 'local',
      DATABASE_URL:
        'postgresql://lotus_booking_local:local-only-placeholder@127.0.0.1:15432/lotus_booking_local',
      DATABASE_SCHEMA: 'public',
      PORT: '3000',
      HOST: '127.0.0.1',
      LOTUS_ORGANIZATION_ID: 'sample-tenant',
      LOTUS_PROPERTY_ID: 'sample-bungalow',
      LOTUS_SAMPLE_DATA: 'false',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Environment validation passed');
    expect(result.stdout).not.toContain('local-only-placeholder');
  });

  it('fails closed when sample data is requested in production', () => {
    const result = runScript('scripts/check-env.mjs', ['--runtime'], {
      LOTUS_ENV: 'production',
      DATABASE_URL: 'postgresql://app:real-looking-value@example.test/booking',
      DATABASE_SCHEMA: 'public',
      PORT: '3000',
      HOST: '127.0.0.1',
      LOTUS_ORGANIZATION_ID: 'sample-tenant',
      LOTUS_PROPERTY_ID: 'sample-bungalow',
      LOTUS_SAMPLE_DATA: 'true',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('sample data is disabled');
  });

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
    const result = createPropertyConfigurationV1({
      ...SAMPLE_DATA_V1.property,
      bedConfiguration: [...SAMPLE_DATA_V1.property.bedConfiguration],
      amenities: [...SAMPLE_DATA_V1.property.amenities],
    });
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
    expect(SAMPLE_DATA_V1.property).toMatchObject({
      name: 'Sample Garden Bungalow',
      maximumGuests: 2,
      bedConfiguration: [{ type: 'double', quantity: 1 }],
    });
    expect(SAMPLE_DATA_V1.rate.cleaningFeeMinor).toBe(0);
    expect(JSON.stringify(SAMPLE_DATA_V1.property)).not.toMatch(/pool/iu);
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
