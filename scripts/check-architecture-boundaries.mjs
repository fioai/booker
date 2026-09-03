/* global process */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeRuntimeWorkspaceDependencies,
  validateWorkspaceGraph,
} from './lib/workspace-graph.mjs';

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
    for (const file of await filesUnder(join(root, directory))) {
      const source = await readFile(file, 'utf8');
      if (source.includes('ApiModuleDependencies')) {
        violations.push(`removed marker export reappeared: ${relative(root, file)}`);
      }
    }
  }
}

async function readWorkspaceProjects() {
  const workspacePackages = [];
  for (const workspaceRoot of ['apps', 'packages']) {
    const directory = join(root, workspaceRoot);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDirectory = join(directory, entry.name);
      try {
        const manifest = await readJson(join(projectDirectory, 'package.json'));
        if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
          violations.push(
            `workspace manifest has no package name: ${relative(root, projectDirectory)}`,
          );
          continue;
        }
        workspacePackages.push({ name: manifest.name, projectDirectory, manifest });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }

  const packageNames = new Set(workspacePackages.map(({ name }) => name));
  const namesByReferencePath = new Map();
  for (const { name, projectDirectory } of workspacePackages) {
    namesByReferencePath.set(resolve(projectDirectory), name);
    namesByReferencePath.set(resolve(projectDirectory, 'tsconfig.json'), name);
  }

  const projects = [];
  for (const { name, projectDirectory, manifest } of workspacePackages) {
    const dependencyAnalysis = analyzeRuntimeWorkspaceDependencies(name, manifest, packageNames);
    violations.push(...dependencyAnalysis.violations);
    const references = [];
    try {
      const tsconfig = await readJson(join(projectDirectory, 'tsconfig.json'));
      for (const reference of tsconfig.references ?? []) {
        if (typeof reference?.path !== 'string') {
          violations.push(`${name} has a composite reference without a path`);
          continue;
        }
        const referencePath = resolve(projectDirectory, reference.path);
        const targetName = namesByReferencePath.get(referencePath);
        if (targetName === undefined) {
          violations.push(
            `${name} has a composite reference to unknown workspace path ${relative(
              root,
              referencePath,
            )}`,
          );
          continue;
        }
        references.push(targetName);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    projects.push({ name, dependencies: dependencyAnalysis.dependencies, references });
  }
  return projects;
}

async function checkWorkspaceGraph() {
  violations.push(...validateWorkspaceGraph(await readWorkspaceProjects()));
}

await checkDatabaseBoundary();
await checkRemovedBoundaries();
await checkWorkspaceGraph();

if (violations.length > 0) {
  throw new Error(`Architecture boundary check failed:\n- ${violations.join('\n- ')}`);
}

process.stdout.write('Architecture boundary check passed.\n');
