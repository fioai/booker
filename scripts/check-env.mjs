/* global process, URL */

import { readFile } from 'node:fs/promises';

import {
  safeEnvironmentSummary,
  validateEnvironmentTemplate,
  validateRuntimeEnvironment,
} from './lib/environment.mjs';

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/check-env.mjs [--runtime|--template]',
      '',
      '--runtime  validate the explicit runtime environment variables.',
      '--template validate required keys in .env.example without loading credentials.',
    ].join('\n') + '\n',
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  if (process.argv.includes('--template')) {
    const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    const result = validateEnvironmentTemplate(template);
    process.stdout.write(
      'Environment template validation passed (' + result.keyCount + ' keys).\n',
    );
    return;
  }
  const config = validateRuntimeEnvironment(process.env);
  process.stdout.write('Environment validation passed (' + safeEnvironmentSummary(config) + ').\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'unknown validation error';
  process.stderr.write('Environment validation failed: ' + message + '\n');
  process.exitCode = 1;
});
