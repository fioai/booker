/* global process, URL */
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
let temporaryDirectory;

function fail(message) {
  throw new Error(`SDK package smoke failed: ${message}`);
}

try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'booking-engine-sdk-'));
  const packageDirectory = join(root, 'packages/sdk-typescript');
  try {
    await access(join(packageDirectory, 'dist/index.js'));
    await access(join(packageDirectory, 'README.md'));
  } catch {
    fail('build dist/index.js and keep packages/sdk-typescript/README.md before packing');
  }

  await exec(
    'pnpm',
    [
      'pack',
      '--filter',
      '@booking-engine/sdk-typescript',
      '--pack-destination',
      temporaryDirectory,
    ],
    { cwd: root },
  );
  const packedFiles = (await readdir(temporaryDirectory)).filter((name) => name.endsWith('.tgz'));
  if (packedFiles.length !== 1) {
    fail(`expected one packed artifact, found ${packedFiles.length}`);
  }
  const tarball = join(temporaryDirectory, packedFiles[0]);
  await exec('pnpm', ['init'], { cwd: temporaryDirectory });
  await writeFile(
    join(temporaryDirectory, 'package.json'),
    JSON.stringify(
      { name: 'booking-engine-sdk-consumer', private: true, type: 'module' },
      null,
      2,
    ) + '\n',
  );
  const archive = await exec('tar', ['-tzf', tarball], { cwd: temporaryDirectory });
  const archiveEntries = archive.stdout.split(/\r?\n/u);
  if (
    !archiveEntries.includes('package/README.md') ||
    !archiveEntries.includes('package/dist/index.js')
  ) {
    fail('packed artifact is missing dist/index.js or README.md');
  }
  await exec('pnpm', ['install', '--ignore-scripts', tarball], { cwd: temporaryDirectory });
  await writeFile(
    join(temporaryDirectory, 'smoke.mjs'),
    "import { createBookingEngineClientV1, BookingEngineApiErrorV1 } from '@booking-engine/sdk-typescript';\nif (typeof createBookingEngineClientV1 !== 'function' || typeof BookingEngineApiErrorV1 !== 'function') throw new Error('V1 exports are missing');\nconst client = createBookingEngineClientV1({ baseUrl: 'https://booking.example.test' });\nif (client.apiVersion !== 'v1' || typeof client.requestToBook !== 'function') throw new Error('V1 client path is missing');\n",
  );
  await exec('node', ['smoke.mjs'], { cwd: temporaryDirectory });
  const installedManifest = JSON.parse(
    await readFile(
      join(temporaryDirectory, 'node_modules/@booking-engine/sdk-typescript/package.json'),
      'utf8',
    ),
  );
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const dependency of Object.keys(installedManifest[field] ?? {})) {
      if (dependency.startsWith('@booking-engine/')) {
        fail(`packed SDK has a workspace runtime dependency: ${dependency}`);
      }
    }
  }
  process.stdout.write('SDK package consumer smoke passed.\n');
} finally {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
