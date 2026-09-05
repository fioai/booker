export declare function runHistorySecretScan(root?: string): {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly uniqueBlobs: number;
  readonly scannedSnapshots: number;
  readonly totalFindings: number;
  readonly totalPlaceholders: number;
  readonly retainedFindings: number;
  readonly retainedPlaceholders: number;
  readonly truncatedFindings: number;
  readonly truncatedPlaceholders: number;
};
