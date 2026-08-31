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

const SOURCE_MAPPING_URL_PATTERN =
  /(?:\/\/[#@][ \t]*sourceMappingURL[ \t]*=[ \t]*([^\s"'`]*)|\/\*[#@][ \t]*sourceMappingURL[ \t]*=[ \t]*([^*\s]*)[ \t]*\*\/)/gu;

function fail(message) {
  throw new Error(`SDK package smoke failed: ${message}`);
}

function runPackageManager(args, options) {
  const packageManagerPath = process.env.npm_execpath;
  if (typeof packageManagerPath !== 'string' || packageManagerPath.length === 0) {
    fail('package manager execution path is unavailable; run this check through Corepack pnpm');
  }
  if (typeof process.execPath !== 'string' || process.execPath.length === 0) {
    fail('Node.js execution path is unavailable');
  }
  return exec(process.execPath, [packageManagerPath, ...args], options);
}

function resolvePackedSourceMapTarget(archiveEntry, sourceMappingUrl) {
  if (sourceMappingUrl.length === 0) {
    fail(`packed ${archiveEntry} contains an empty sourceMappingURL target`);
  }
  if (/^data:/iu.test(sourceMappingUrl)) {
    return undefined;
  }

  let targetUrl;
  try {
    targetUrl = new URL(sourceMappingUrl, `archive:///${archiveEntry}`);
  } catch {
    fail(`packed ${archiveEntry} contains an invalid sourceMappingURL target: ${sourceMappingUrl}`);
  }
  if (targetUrl.protocol !== 'archive:' || targetUrl.host !== '') {
    fail(
      `packed ${archiveEntry} contains a sourceMappingURL target outside the artifact: ${sourceMappingUrl}`,
    );
  }

  try {
    return decodeURIComponent(targetUrl.pathname).replace(/^\/+/u, '');
  } catch {
    fail(`packed ${archiveEntry} contains an invalid sourceMappingURL target: ${sourceMappingUrl}`);
  }
}

try {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'booking-engine-sdk-'));
  const packageDirectory = join(root, 'packages/sdk-typescript');
  try {
    await access(join(packageDirectory, 'dist/index.js'));
    await access(join(packageDirectory, 'dist/index.d.ts'));
    await access(join(packageDirectory, 'README.md'));
  } catch {
    fail(
      'build dist/index.js and dist/index.d.ts, and keep packages/sdk-typescript/README.md before packing',
    );
  }

  await runPackageManager(
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
  const forbiddenArchiveEntries = archiveEntries.filter(
    (entry) => entry.endsWith('.tsbuildinfo') || entry.endsWith('.map'),
  );
  if (forbiddenArchiveEntries.length > 0) {
    fail(`packed artifact contains build-only files: ${forbiddenArchiveEntries.join(', ')}`);
  }
  const archiveEntrySet = new Set(archiveEntries);
  const packedCodeEntries = archiveEntries.filter((entry) =>
    /\.(?:[cm]?js|d\.[cm]?ts)$/u.test(entry),
  );
  for (const archiveEntry of packedCodeEntries) {
    const packedCode = await exec('tar', ['-xOzf', tarball, archiveEntry], {
      cwd: temporaryDirectory,
    });
    for (const match of packedCode.stdout.matchAll(SOURCE_MAPPING_URL_PATTERN)) {
      const sourceMappingUrl = match[1] ?? match[2];
      if (sourceMappingUrl === undefined) {
        fail(`packed ${archiveEntry} contains an unreadable sourceMappingURL directive`);
      }
      const sourceMapTarget = resolvePackedSourceMapTarget(archiveEntry, sourceMappingUrl);
      if (sourceMapTarget !== undefined && !archiveEntrySet.has(sourceMapTarget)) {
        fail(
          `packed ${archiveEntry} contains a dangling sourceMappingURL target: ${sourceMappingUrl}`,
        );
      }
    }
  }
  if (
    !archiveEntries.includes('package/LICENSE') ||
    !archiveEntries.includes('package/README.md') ||
    !archiveEntries.includes('package/dist/index.js') ||
    !archiveEntries.includes('package/dist/index.d.ts')
  ) {
    fail('packed artifact is missing LICENSE, README.md, dist/index.js, or dist/index.d.ts');
  }
  await runPackageManager(['install', '--ignore-scripts', tarball], { cwd: temporaryDirectory });
  const installedManifest = JSON.parse(
    await readFile(
      join(temporaryDirectory, 'node_modules/@booking-engine/sdk-typescript/package.json'),
      'utf8',
    ),
  );
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = Object.keys(installedManifest[field] ?? {});
    if (dependencies.length > 0) {
      fail(`packed SDK ${field} must be empty; found ${dependencies.join(', ')}`);
    }
  }
  await writeFile(
    join(temporaryDirectory, 'smoke.ts'),
    [
      'import {',
      '  BookingEngineApiErrorV1,',
      '  createBookingEngineClientV1,',
      '  type BookingEngineClientV1,',
      '  type PublicRequestToBookInputV1,',
      '  type PublicRequestToBookOptionsV1,',
      '  type PublicRequestToBookV1,',
      "} from '@booking-engine/sdk-typescript';",
      '// @ts-expect-error Manifest proof types are internal.',
      "import type { PublicBookingManifestTypeChecksV1 } from '@booking-engine/sdk-typescript';",
      '// @ts-expect-error OpenAPI proof types are internal.',
      "import type { PublicOpenApiContractTypesV1 } from '@booking-engine/sdk-typescript';",
      '// @ts-expect-error The compatibility input alias is not public.',
      "import type { PublicBookingRequestInputV1 } from '@booking-engine/sdk-typescript';",
      '// @ts-expect-error The compatibility response alias is not public.',
      "import type { PublicBookingRequestV1 } from '@booking-engine/sdk-typescript';",
      '',
      "const client: BookingEngineClientV1 = createBookingEngineClientV1({ baseUrl: 'https://booking.example.test' });",
      'declare const input: PublicRequestToBookInputV1;',
      'declare const options: PublicRequestToBookOptionsV1;',
      "const booking: Promise<PublicRequestToBookV1> = client.requestToBook('property-id', input, options);",
      'declare const removedCompatibilityInput: PublicBookingRequestInputV1;',
      'declare const removedCompatibilityResponse: PublicBookingRequestV1;',
      'function describeError(error: unknown): string {',
      '  return error instanceof BookingEngineApiErrorV1 ? `${error.status}:${error.code}` : "unknown";',
      '}',
      'void booking;',
      'void describeError;',
      'void removedCompatibilityInput;',
      'void removedCompatibilityResponse;',
      '',
    ].join('\n'),
  );
  await exec(
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--pretty',
      'false',
      'smoke.ts',
    ],
    { cwd: temporaryDirectory },
  );
  await writeFile(
    join(temporaryDirectory, 'smoke.mjs'),
    "import { createBookingEngineClientV1, BookingEngineApiErrorV1 } from '@booking-engine/sdk-typescript';\nif (typeof createBookingEngineClientV1 !== 'function' || typeof BookingEngineApiErrorV1 !== 'function') throw new Error('V1 exports are missing');\nconst client = createBookingEngineClientV1({ baseUrl: 'https://booking.example.test' });\nif (client.apiVersion !== 'v1' || typeof client.requestToBook !== 'function') throw new Error('V1 client path is missing');\n",
  );
  await exec(process.execPath, ['smoke.mjs'], { cwd: temporaryDirectory });
  process.stdout.write('SDK package consumer smoke passed.\n');
} finally {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
