/* global process */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path)));
    } else if (entry.isFile() && path.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

async function checkDatabaseBoundary() {
  const sourceDirectory = join(root, 'packages/database-postgres/src');
  for (const file of await filesUnder(sourceDirectory)) {
    const source = await readFile(file, 'utf8');
    if (source.includes('@booking-engine/sdk-typescript')) {
      violations.push(`database source imports the SDK: ${relative(root, file)}`);
    }
  }
  const index = await readFile(join(sourceDirectory, 'index.ts'), 'utf8');
  if (
    /@booking-engine\/channel-ical/u.test(index) ||
    /\b(?:ICalBlockRecord|ICalBlockStore|ICalReleaseProvenance|ICalScope)\b/u.test(index)
  ) {
    violations.push('database index re-exports channel-owned iCalendar ports');
  }
}

async function checkRemovedBoundaries() {
  const removedPaths = [
    'apps/admin/package.json',
    'apps/api/src/admin/http-server.ts',
    'apps/api/src/public/booking/http-server.ts',
  ];
  for (const path of removedPaths) {
    try {
      await readFile(join(root, path));
      violations.push(`removed path still exists: ${path}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  for (const directory of ['apps', 'packages', 'scripts', 'tests']) {
    for (const file of await filesUnder(join(root, directory)).catch(() => [])) {
      const source = await readFile(file, 'utf8');
      if (source.includes('ApiModuleDependencies')) {
        violations.push(`removed marker export reappeared: ${relative(root, file)}`);
      }
    }
  }
}

async function checkCompositeReferences() {
  const workspaceRoots = ['apps', 'packages'];
  const packagesByName = new Map();
  for (const workspaceRoot of workspaceRoots) {
    const directory = join(root, workspaceRoot);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDirectory = join(directory, entry.name);
      try {
        const manifest = await readJson(join(projectDirectory, 'package.json'));
        packagesByName.set(manifest.name, projectDirectory);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  for (const [name, projectDirectory] of packagesByName) {
    let manifest;
    try {
      manifest = await readJson(join(projectDirectory, 'package.json'));
    } catch {
      continue;
    }
    const workspaceDependencies = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
      dependency.startsWith('@booking-engine/'),
    );
    if (workspaceDependencies.length === 0) continue;
    let tsconfig;
    try {
      tsconfig = await readJson(join(projectDirectory, 'tsconfig.json'));
    } catch {
      violations.push(`${name} has workspace dependencies but no tsconfig.json`);
      continue;
    }
    const references = new Set(
      (tsconfig.references ?? []).map((reference) => resolve(projectDirectory, reference.path)),
    );
    for (const dependency of workspaceDependencies) {
      const dependencyDirectory = packagesByName.get(dependency);
      if (dependencyDirectory === undefined) {
        violations.push(`${name} declares unknown workspace dependency ${dependency}`);
        continue;
      }
      if (!references.has(resolve(dependencyDirectory))) {
        violations.push(`${name} is missing a composite reference to ${dependency}`);
      }
    }
  }
}

await checkDatabaseBoundary();
await checkRemovedBoundaries();
await checkCompositeReferences();

if (violations.length > 0) {
  throw new Error(`Architecture boundary check failed:\n- ${violations.join('\n- ')}`);
}

process.stdout.write('Architecture boundary check passed.\n');
