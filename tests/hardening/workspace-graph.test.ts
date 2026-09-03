import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_DEPENDENCY_GRAPH,
  analyzeRuntimeWorkspaceDependencies,
  validateWorkspaceGraph,
  type WorkspaceDependencyManifest,
  type WorkspaceProject,
} from '../../scripts/lib/workspace-graph.mjs';

function validWorkspaceProjects(): WorkspaceProject[] {
  return Object.entries(WORKSPACE_DEPENDENCY_GRAPH).map(([name, dependencies]) => ({
    name,
    dependencies: [...dependencies],
    references: [...dependencies],
  }));
}

function findProject(projects: WorkspaceProject[], name: string) {
  const project = projects.find((candidate) => candidate.name === name);
  if (project === undefined) {
    throw new Error(`Test workspace package not found: ${name}`);
  }
  return project;
}

const workspacePackageNames = new Set(Object.keys(WORKSPACE_DEPENDENCY_GRAPH));

const windowsLocalDependencyCases = (
  ['dependencies', 'optionalDependencies', 'peerDependencies'] as const
).flatMap((dependencyField) =>
  (
    [
      '.\\payments',
      '..\\payments',
      '\\payments',
      '\\\\server\\share\\payments',
      'C:\\workspace\\payments',
    ] as const
  ).map((specifier) => [specifier, dependencyField] as const),
);

function analyzeRuntimeDependencies(name: string, manifest: WorkspaceDependencyManifest) {
  return analyzeRuntimeWorkspaceDependencies(name, manifest, workspacePackageNames);
}

function setRuntimeDependencies(
  projects: WorkspaceProject[],
  name: string,
  manifest: WorkspaceDependencyManifest,
) {
  findProject(projects, name).dependencies = analyzeRuntimeDependencies(
    name,
    manifest,
  ).dependencies;
}

describe('workspace manifest dependency validation', () => {
  it('accepts a canonical direct workspace edge', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          '@booking-engine/booking-core': 'workspace:*',
        },
      }),
    ).toEqual({
      dependencies: ['@booking-engine/booking-core'],
      violations: [],
    });
  });

  it('rejects a scoped workspace alias behind an allowed key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          '@booking-engine/booking-core': 'workspace:@booking-engine/payments@*',
        },
      }),
    ).toEqual({
      dependencies: ['@booking-engine/booking-core'],
      violations: [
        '@booking-engine/api dependencies entry @booking-engine/booking-core must use "workspace:*"; found "workspace:@booking-engine/payments@*"',
      ],
    });
  });

  it('rejects a workspace alias behind an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        optionalDependencies: {
          'payment-adapter': 'workspace:@booking-engine/payments@*',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api optionalDependencies entry payment-adapter uses "workspace:@booking-engine/payments@*"; workspace dependencies must use their canonical package name with "workspace:*"',
      ],
    });
  });

  it('rejects a relative workspace target', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        peerDependencies: {
          'local-payments': 'workspace:../../packages/payments',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api peerDependencies entry local-payments uses "workspace:../../packages/payments"; workspace dependencies must use their canonical package name with "workspace:*"',
      ],
    });
  });

  it('rejects a file runtime dependency under an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          'local-payments': 'file:../payments',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api dependencies entry local-payments uses disallowed local-path specifier "file:../payments"; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"',
      ],
    });
  });

  it('rejects a link runtime dependency under an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        optionalDependencies: {
          'local-payments': 'link:../payments',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api optionalDependencies entry local-payments uses disallowed local-path specifier "link:../payments"; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"',
      ],
    });
  });

  it('rejects a bare relative runtime dependency under an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        peerDependencies: {
          'local-payments': '../payments',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api peerDependencies entry local-payments uses disallowed local-path specifier "../payments"; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"',
      ],
    });
  });

  it('rejects a bare absolute runtime dependency under an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          'local-payments': '/workspace/payments',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api dependencies entry local-payments uses disallowed local-path specifier "/workspace/payments"; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"',
      ],
    });
  });

  it.each(windowsLocalDependencyCases)(
    'rejects Windows local-path specifier %s in %s',
    (specifier, dependencyField) => {
      expect(
        analyzeRuntimeDependencies('@booking-engine/api', {
          [dependencyField]: {
            'local-payments': specifier,
          },
        }),
      ).toEqual({
        dependencies: [],
        violations: [
          `@booking-engine/api ${dependencyField} entry local-payments uses disallowed local-path specifier ${JSON.stringify(specifier)}; runtime dependencies must use registry specifiers or canonical internal package names with "workspace:*"`,
        ],
      });
    },
  );

  it('rejects an internal npm alias under an arbitrary key', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          'payment-adapter': 'npm:@booking-engine/payments@*',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [
        '@booking-engine/api dependencies entry payment-adapter uses internal npm alias "npm:@booking-engine/payments@*"; internal dependencies must use their canonical package name with "workspace:*"',
      ],
    });
  });

  it('accepts ordinary external registry dependencies', () => {
    expect(
      analyzeRuntimeDependencies('@booking-engine/api', {
        dependencies: {
          stripe: '^18.0.0',
          'stripe-compatible': 'npm:stripe@^18.0.0',
        },
      }),
    ).toEqual({
      dependencies: [],
      violations: [],
    });
  });
});

describe('workspace graph validation', () => {
  it('accepts the documented dependency and reference graph', () => {
    expect(validateWorkspaceGraph(validWorkspaceProjects())).toEqual([]);
  });

  it('rejects a missing dependency edge', () => {
    const projects = validWorkspaceProjects();
    const database = findProject(projects, '@booking-engine/database-postgres');
    database.dependencies = database.dependencies.filter(
      (dependency) => dependency !== '@booking-engine/booking-core',
    );

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/database-postgres is missing required workspace dependency @booking-engine/booking-core',
    ]);
  });

  it('rejects a forbidden dependency', () => {
    const projects = validWorkspaceProjects();
    findProject(projects, '@booking-engine/notifications').dependencies.push(
      '@booking-engine/payments',
    );

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/notifications declares forbidden workspace dependency @booking-engine/payments',
    ]);
  });

  it('rejects an unknown workspace package', () => {
    const projects = validWorkspaceProjects();
    projects.push({
      name: '@booking-engine/unknown',
      dependencies: [],
      references: [],
    });

    expect(validateWorkspaceGraph(projects)).toEqual([
      'unknown workspace package @booking-engine/unknown',
    ]);
  });

  it('rejects a missing TypeScript reference', () => {
    const projects = validWorkspaceProjects();
    const database = findProject(projects, '@booking-engine/database-postgres');
    database.references = database.references.filter(
      (reference) => reference !== '@booking-engine/channel-ical',
    );

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/database-postgres is missing a composite reference to @booking-engine/channel-ical',
    ]);
  });

  it('rejects an extra TypeScript reference', () => {
    const projects = validWorkspaceProjects();
    findProject(projects, '@booking-engine/payments').references.push(
      '@booking-engine/booking-core',
    );

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/payments has an extra composite reference to @booking-engine/booking-core',
    ]);
  });

  it('rejects a forbidden optional workspace dependency from a manifest', () => {
    const projects = validWorkspaceProjects();
    setRuntimeDependencies(projects, '@booking-engine/notifications', {
      optionalDependencies: {
        '@booking-engine/payments': 'workspace:*',
      },
    });

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/notifications declares forbidden workspace dependency @booking-engine/payments',
    ]);
  });

  it('rejects a forbidden peer workspace dependency from a manifest', () => {
    const projects = validWorkspaceProjects();
    setRuntimeDependencies(projects, '@booking-engine/notifications', {
      peerDependencies: {
        '@booking-engine/payments': 'workspace:*',
      },
    });

    expect(validateWorkspaceGraph(projects)).toEqual([
      '@booking-engine/notifications declares forbidden workspace dependency @booking-engine/payments',
    ]);
  });

  it('accepts allowed workspace dependencies from every runtime dependency field', () => {
    const projects = validWorkspaceProjects();
    setRuntimeDependencies(projects, '@booking-engine/database-postgres', {
      dependencies: {
        '@booking-engine/booking-core': 'workspace:*',
      },
      optionalDependencies: {
        '@booking-engine/channel-ical': 'workspace:*',
      },
      peerDependencies: {
        '@booking-engine/payments': 'workspace:*',
      },
    });

    expect(validateWorkspaceGraph(projects)).toEqual([]);
  });

  it('ignores workspace packages that appear only in devDependencies', () => {
    const projects = validWorkspaceProjects();
    setRuntimeDependencies(projects, '@booking-engine/notifications', {
      devDependencies: {
        '@booking-engine/payments': 'workspace:*',
      },
    });

    expect(validateWorkspaceGraph(projects)).toEqual([]);
  });
});
