/* global process, URL */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const ignoredPrefixes = ['.hermes-hardening-', 'node_modules/', 'dist/', 'artifacts/'];
const binaryExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.zip',
]);
const patterns = [
  { name: 'private-key-block', expression: /-----BEGIN (?:RSA|EC|OPENSSH|PRIVATE) KEY-----/u },
  { name: 'live-provider-key', expression: /\b(?:sk|rk)_live_[A-Za-z0-9_-]{8,}/u },
  { name: 'provider-webhook-secret', expression: /\bwhsec_[A-Za-z0-9_-]{8,}/u },
  { name: 'cloud-access-key', expression: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'database-url-credential', expression: /\bpostgres(?:ql)?:\/\/[^@\s/:]+:[^@\s]+@/u },
];

function help() {
  process.stdout.write(
    [
      'Usage: node scripts/check-secrets.mjs',
      '',
      'Scans tracked and non-ignored text files without printing matched secret material.',
      'Test fixtures, local placeholders, and Hermes evidence files are classified separately.',
    ].join('\n') + '\n',
  );
}

function filesToScan() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'buffer',
    },
  ).toString('utf8');
  return output
    .split('\0')
    .filter((file) => file.length > 0)
    .filter((file) => ignoredPrefixes.every((prefix) => !file.startsWith(prefix)))
    .filter((file) => !file.startsWith('.hermes-hardening-'))
    .filter((file) => !binaryExtensions.has(extname(file).toLowerCase()))
    .filter(
      (file) =>
        existsSync(resolve(root, file)) && statSync(resolve(root, file)).size <= 2 * 1024 * 1024,
    );
}

function isFixture(file, value) {
  return (
    /(?:^|\/)(?:test|tests|fixtures)(?:\/|$)/u.test(file) ||
    file === '.env.example' ||
    /(?:local-only-placeholder|never_allowed|test_only|example\.test)/iu.test(value)
  );
}

function main() {
  if (process.argv.includes('--help')) {
    help();
    return;
  }
  const confirmed = [];
  const fixtures = [];
  let scanned = 0;
  for (const file of filesToScan()) {
    const text = readFileSync(resolve(root, file), 'utf8');
    scanned += 1;
    for (const pattern of patterns) {
      const match = pattern.expression.exec(text);
      if (match === null) {
        continue;
      }
      const line = text.slice(0, match.index).split(/\r?\n/u).length;
      const finding = { file, line, name: pattern.name };
      if (isFixture(file, match[0])) {
        fixtures.push(finding);
      } else {
        confirmed.push(finding);
      }
    }
  }
  if (confirmed.length > 0) {
    process.stderr.write('Secret scan failed: ' + confirmed.length + ' confirmed finding(s).\n');
    for (const finding of confirmed) {
      process.stderr.write('  ' + finding.file + ':' + finding.line + ' (' + finding.name + ')\n');
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    'Secret scan passed: scanned ' +
      scanned +
      ' text file(s); ignored ' +
      fixtures.length +
      ' test/template marker(s); confirmed findings 0.\n',
  );
  process.stdout.write(
    'Limitation: this deterministic scan does not inspect external secret stores, Git history, or high-entropy values without a known marker.\n',
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'secret scan failed';
  process.stderr.write('Secret scan failed: ' + message + '\n');
  process.exitCode = 1;
}
