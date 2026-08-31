export type EnvironmentSource = 'process' | 'file' | 'none';

export declare const DEPLOYMENT_IDENTITY_KEYS: readonly string[];

export declare function loadEnvironment(path?: string | URL): EnvironmentSource;
