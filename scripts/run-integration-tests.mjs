/* global process, URL */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateMigrationEnvironment } from './lib/environment.mjs';
import { loadEnvironment } from './lib/load-environment.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vitestEntry = resolve(root, 'node_modules/vitest/vitest.mjs');

function main() {
  const source = loadEnvironment();
  if (source === 'process' || source === 'file') {
    validateMigrationEnvironment(process.env);
  }

  const child = spawn(
    process.execPath,
    [vitestEntry, 'run', 'tests/integration', ...process.argv.slice(2)],
    {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    },
  );
  const forwardSignal = (signal) => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  const forwardInterrupt = () => forwardSignal('SIGINT');
  const forwardTermination = () => forwardSignal('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTermination);

  child.once('error', () => {
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTermination);
    process.stderr.write('Integration test runner failed to start Vitest.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTermination);
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'environment validation failed';
  process.stderr.write('Integration test runner failed: ' + message + '\n');
  process.exitCode = 1;
}
