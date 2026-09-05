export interface BackupPoolLike {
  end(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): void;
  removeListener(event: 'error', listener: (error: unknown) => void): void;
  query(...args: unknown[]): Promise<unknown>;
}

export interface ObservedBackupPool {
  readonly pool: BackupPoolLike;
  beginClosing(): void;
  hasError(): boolean;
  detach(): void;
}

export function observeBackupPool(pool: BackupPoolLike): ObservedBackupPool;

export interface BackupCleanupOptions {
  readonly targetPool: ObservedBackupPool | undefined;
  readonly targetEmptyPool: ObservedBackupPool | undefined;
  readonly sourcePool: ObservedBackupPool;
  readonly adminPool: ObservedBackupPool;
  readonly targetCreated: boolean;
  readonly dropTarget: (() => Promise<unknown>) | undefined;
}

export function cleanupBackupResources(options: BackupCleanupOptions): Promise<void>;

export function libpqHostArgument(hostname: string): string;
