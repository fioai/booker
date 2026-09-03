/* global fetch, process */
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const packageDirectory = join(root, 'packages/sdk-typescript');
const packageJsonPath = join(packageDirectory, 'package.json');
const packageName = '@booking-engine/sdk-typescript';
const registry = 'https://registry.npmjs.org';

function fail(message) {
  throw new Error(`Release invariant failed: ${message}`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function readManifest() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  } catch (error) {
    fail(`cannot read ${packageJsonPath}: ${errorMessage(error)}`);
  }
  if (manifest.name !== packageName) {
    fail(`expected package name ${packageName}, found ${JSON.stringify(manifest.name)}`);
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail(`package version is invalid: ${JSON.stringify(manifest.version)}`);
  }
  return manifest;
}

async function gitOutput(args) {
  try {
    const result = await exec('git', args, { cwd: root });
    return result.stdout.trim();
  } catch (error) {
    fail(`git ${args.join(' ')} failed: ${errorMessage(error)}`);
  }
}

function expectedTarballName(manifest) {
  return `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
}

async function checkReleaseRef(manifest, tag) {
  if (typeof tag !== 'string' || !/^v[^.]+\.[^.]+\.[^.]+$/u.test(tag)) {
    fail(`release tag must match v*.*.*, found ${JSON.stringify(tag)}`);
  }
  if (tag !== `v${manifest.version}`) {
    fail(`release tag ${tag} does not match package version ${manifest.version}`);
  }
  const [head, originMain] = await Promise.all([
    gitOutput(['rev-parse', 'HEAD']),
    gitOutput(['rev-parse', 'origin/main']),
  ]);
  if (head !== originMain) {
    fail(`release tag ${tag} points at ${head}, but current origin/main is ${originMain}`);
  }
  process.stdout.write(
    `Release tag ${tag} matches ${packageName}@${manifest.version} and origin/main.\n`,
  );
}

async function checkArtifact(manifest, inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    fail('artifact directory or path is required');
  }
  const input = resolve(inputPath);
  let inputStats;
  try {
    inputStats = await stat(input);
  } catch (error) {
    fail(`artifact path ${input} is unavailable: ${errorMessage(error)}`);
  }
  let artifact = input;
  if (inputStats.isDirectory()) {
    const archives = (await readdir(input)).filter((entry) => entry.endsWith('.tgz')).sort();
    if (archives.length !== 1) {
      fail(`expected one SDK tarball in ${input}, found ${archives.length}`);
    }
    artifact = join(input, archives[0]);
  }
  const expectedName = expectedTarballName(manifest);
  if (basename(artifact) !== expectedName) {
    fail(`expected tarball ${expectedName}, found ${basename(artifact)}`);
  }
  const siblingArchives = (await readdir(dirname(artifact)))
    .filter((entry) => entry.endsWith('.tgz'))
    .sort();
  if (siblingArchives.length !== 1 || siblingArchives[0] !== expectedName) {
    fail(`artifact directory must contain only ${expectedName}`);
  }

  let archiveListing;
  let packedManifest;
  try {
    archiveListing = (await exec('tar', ['-tzf', artifact], { cwd: root })).stdout
      .split(/\r?\n/u)
      .filter(Boolean);
    packedManifest = JSON.parse(
      (await exec('tar', ['-xOzf', artifact, 'package/package.json'], { cwd: root })).stdout,
    );
  } catch (error) {
    fail(`cannot inspect ${artifact}: ${errorMessage(error)}`);
  }
  const archiveEntries = new Set(archiveListing);
  for (const requiredEntry of [
    'package/LICENSE',
    'package/README.md',
    'package/dist/index.js',
    'package/dist/index.d.ts',
  ]) {
    if (!archiveEntries.has(requiredEntry)) {
      fail(`tarball is missing ${requiredEntry}`);
    }
  }
  if (packedManifest.name !== manifest.name || packedManifest.version !== manifest.version) {
    fail(
      `tarball manifest ${JSON.stringify(packedManifest.name)}@${JSON.stringify(
        packedManifest.version,
      )} does not match ${manifest.name}@${manifest.version}`,
    );
  }
  process.stdout.write(`${artifact}\n`);
}

async function checkUnpublished(manifest) {
  const packagePath = `${encodeURIComponent(manifest.name)}/${encodeURIComponent(
    manifest.version,
  )}`;
  const registryUrl = `${registry}/${packagePath}`;
  let response;
  try {
    response = await fetch(registryUrl, { headers: { accept: 'application/json' } });
  } catch (error) {
    fail(`registry lookup failed: ${errorMessage(error)}`);
  }
  if (response.status === 404) {
    process.stdout.write(`${manifest.name}@${manifest.version} is not published.\n`);
    return;
  }
  if (response.ok) {
    fail(`${manifest.name}@${manifest.version} is already published`);
  }
  fail(`registry lookup returned unexpected HTTP ${response.status}`);
}

const mode = process.argv[2];
const manifest = await readManifest();
if (mode === 'ref') {
  await checkReleaseRef(manifest, process.argv[3]);
} else if (mode === 'artifact') {
  await checkArtifact(manifest, process.argv[3]);
} else if (mode === 'unpublished') {
  await checkUnpublished(manifest);
} else {
  fail('usage: node scripts/check-release-invariants.mjs <ref TAG|artifact PATH|unpublished>');
}
