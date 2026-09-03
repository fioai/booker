export interface WorkspaceDependencyManifest {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
  readonly peerDependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
}

export interface RuntimeWorkspaceDependencyAnalysis {
  dependencies: string[];
  violations: string[];
}

export interface WorkspaceProject {
  name: string;
  dependencies: string[];
  references: string[];
}

export declare const WORKSPACE_DEPENDENCY_GRAPH: Readonly<Record<string, readonly string[]>>;
export declare function analyzeRuntimeWorkspaceDependencies(
  packageName: string,
  manifest: WorkspaceDependencyManifest,
  workspacePackageNames: ReadonlySet<string>,
): RuntimeWorkspaceDependencyAnalysis;

export declare function validateWorkspaceGraph(projects: readonly WorkspaceProject[]): string[];
