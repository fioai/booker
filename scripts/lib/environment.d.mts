export interface EnvironmentInput {
  readonly [name: string]: unknown;
}

export interface EnvironmentValidationOptions {
  readonly requireApplicationScope?: boolean;
  readonly rejectSampleData?: boolean;
}

export interface EnvironmentConfig {
  readonly environment: string;
  readonly databaseUrl: string;
  readonly schema: string;
  readonly host: string;
  readonly port: number;
  readonly secureCookies: boolean;
  readonly adminOrigin: string | undefined;
  readonly sampleData: boolean;
  readonly organizationId?: string;
  readonly propertyId?: string;
  readonly samplePassword?: string;
}

export interface RuntimeEnvironmentConfig extends EnvironmentConfig {
  readonly organizationId: string;
  readonly propertyId: string;
}

export declare const DEPLOYMENT_IDENTITY_KEYS: readonly string[];

export declare class EnvironmentValidationError extends Error {
  constructor(message: string);
}

export declare function validateDatabaseUrl(value: unknown, environment?: string): string;

export declare function validateEnvironment(
  input: EnvironmentInput,
  options?: EnvironmentValidationOptions,
): Readonly<EnvironmentConfig>;

export declare function validateRuntimeEnvironment(
  input: EnvironmentInput,
): Readonly<RuntimeEnvironmentConfig>;

export declare function validateMigrationEnvironment(
  input: EnvironmentInput,
): Readonly<EnvironmentConfig>;

export declare function validateEnvironmentTemplate(text: unknown): Readonly<{ keyCount: number }>;

export declare function safeEnvironmentSummary(config: EnvironmentConfig): string;
