export interface SecretCandidate {
  readonly file: string;
  readonly tracked: boolean;
  readonly byteLength: number;
  readonly contents?: Uint8Array;
}

export interface SecretFinding {
  readonly file: string;
  readonly line: number | null;
  readonly name: string;
  readonly tracked: boolean;
}

export interface SecretScanResult {
  readonly findings: SecretFinding[];
  readonly placeholders: SecretFinding[];
  readonly inspected: boolean;
  readonly totalFindings: number;
  readonly totalPlaceholders: number;
  readonly truncatedFindings: number;
  readonly truncatedPlaceholders: number;
}

export declare const MAX_SCANNABLE_BYTES: number;
export declare const MAX_RETAINED_RESULTS: number;
export declare function scanSecretCandidate(candidate: SecretCandidate): SecretScanResult;
