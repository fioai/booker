export const WORKSPACE_DEPENDENCY_GRAPH = Object.freeze({
  '@booking-engine/api': Object.freeze([
    '@booking-engine/booking-core',
    '@booking-engine/channel-ical',
    '@booking-engine/database-postgres',
    '@booking-engine/payments',
    '@booking-engine/sdk-typescript',
  ]),
  '@booking-engine/booking-core': Object.freeze([]),
  '@booking-engine/channel-calendar': Object.freeze([]),
  '@booking-engine/channel-ical': Object.freeze(['@booking-engine/channel-calendar']),
  '@booking-engine/database-postgres': Object.freeze([
    '@booking-engine/booking-core',
    '@booking-engine/channel-ical',
    '@booking-engine/payments',
  ]),
  '@booking-engine/notifications': Object.freeze([]),
  '@booking-engine/payments': Object.freeze([]),
  '@booking-engine/payments-stripe': Object.freeze(['@booking-engine/payments']),
  '@booking-engine/sdk-typescript': Object.freeze([]),
  '@booking-engine/test-support': Object.freeze([]),
});

const RUNTIME_DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]);

function isLocalPathSpecifier(specifier) {
  return (
    specifier.startsWith('file:') ||
    specifier.startsWith('link:') ||
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('.\\') ||
    specifier.startsWith('..\\') ||
    specifier.startsWith('/') ||
    specifier.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/u.test(specifier)
  );
}

function isInternalNpmAliasSpecifier(specifier) {
  return specifier.startsWith('npm:@booking-engine/');
}

/**
 * @typedef {object} WorkspaceDependencyManifest
 * @property {Readonly<Record<string, unknown>>} [dependencies]
 * @property {Readonly<Record<string, unknown>>} [optionalDependencies]
 * @property {Readonly<Record<string, unknown>>} [peerDependencies]
 * @property {Readonly<Record<string, unknown>>} [devDependencies]
 */

/**
 * @typedef {object} RuntimeWorkspaceDependencyAnalysis
 * @property {string[]} dependencies
 * @property {string[]} violations
 */

/**
 * Find canonical runtime workspace dependencies and reject specifiers that can hide workspace edges.
 *
 * devDependencies are intentionally excluded because they do not create runtime edges.
 *
 * @param {string} packageName
 * @param {WorkspaceDependencyManifest} manifest
 * @param {ReadonlySet<string>} workspacePackageNames
 * @returns {RuntimeWorkspaceDependencyAnalysis}
 */
export function analyzeRuntimeWorkspaceDependencies(packageName, manifest, workspacePackageNames) {
  const dependencies = new Set();
  const violations = [];

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    for (const [dependency, specifier] of Object.entries(manifest[field] ?? {})) {
      const hasInternalKey =
        dependency.startsWith('@booking-engine/') || workspacePackageNames.has(dependency);

      if (hasInternalKey) {
        dependencies.add(dependency);
        if (specifier !== 'workspace:*') {
          violations.push(
            `${packageName} ${field} entry ${dependency} must use "workspace:*"; found ${JSON.stringify(
              specifier,
            )}`,
          );
        }
      } else if (typeof specifier === 'string') {
        if (specifier.startsWith('workspace:')) {
          violations.push(
            `${packageName} ${field} entry ${dependency} uses ${JSON.stringify(
              specifier,
            )}; workspace dependencies must use their canonical package name with "workspace:*"`,
          );
        } else if (isLocalPathSpecifier(specifier)) {
          violations.push(
            `${packageName} ${field} entry ${dependency} uses disallowed local-path specifier ${JSON.stringify(
              specifier,
            )}; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"`,
          );
        } else if (isInternalNpmAliasSpecifier(specifier)) {
          violations.push(
            `${packageName} ${field} entry ${dependency} uses internal npm alias ${JSON.stringify(
              specifier,
            )}; internal dependencies must use their canonical package name with "workspace:*"`,
          );
        }
      }
    }
  }

  return {
    dependencies: [...dependencies].sort(),
    violations: violations.sort(),
  };
}

/**
 * @typedef {object} WorkspaceProject
 * @property {string} name
 * @property {string[]} dependencies
 * @property {string[]} references
 */

/**
 * Validate the declared dependencies and TypeScript references for every workspace project.
 *
 * @param {readonly WorkspaceProject[]} projects
 * @returns {string[]}
 */
export function validateWorkspaceGraph(projects) {
  const violations = [];
  const expectedNames = new Set(Object.keys(WORKSPACE_DEPENDENCY_GRAPH));
  const projectsByName = new Map();

  for (const project of projects) {
    if (projectsByName.has(project.name)) {
      violations.push(`duplicate workspace package ${project.name}`);
      continue;
    }
    projectsByName.set(project.name, project);
    if (!expectedNames.has(project.name)) {
      violations.push(`unknown workspace package ${project.name}`);
    }
  }

  for (const name of expectedNames) {
    const project = projectsByName.get(name);
    if (project === undefined) {
      violations.push(`expected workspace package is missing: ${name}`);
      continue;
    }

    const expectedDependencies = new Set(WORKSPACE_DEPENDENCY_GRAPH[name]);
    const dependencies = new Set(project.dependencies);
    const references = new Set(project.references);

    for (const dependency of expectedDependencies) {
      if (!dependencies.has(dependency)) {
        violations.push(`${name} is missing required workspace dependency ${dependency}`);
      }
      if (!references.has(dependency)) {
        violations.push(`${name} is missing a composite reference to ${dependency}`);
      }
    }

    for (const dependency of dependencies) {
      if (!expectedNames.has(dependency)) {
        violations.push(`${name} declares unknown workspace dependency ${dependency}`);
      } else if (!expectedDependencies.has(dependency)) {
        violations.push(`${name} declares forbidden workspace dependency ${dependency}`);
      }
    }

    for (const reference of references) {
      if (!expectedNames.has(reference)) {
        violations.push(
          `${name} has a composite reference to unknown workspace package ${reference}`,
        );
      } else if (!expectedDependencies.has(reference)) {
        violations.push(`${name} has an extra composite reference to ${reference}`);
      }
    }
  }

  return violations.sort();
}
