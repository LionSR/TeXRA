export interface KnipCounts {
  unusedFiles: number;
  unusedExports: number;
  unusedTypes: number;
  duplicateExports: number;
}

export interface RatchetViolation {
  metric: keyof KnipCounts;
  currentCount: number;
  baselineCount: number;
}

export interface KnipIssue {
  file: string;
  files?: readonly unknown[];
  exports?: readonly unknown[];
  types?: readonly unknown[];
  duplicates?: readonly unknown[];
}

export function summarizeKnipIssues(issues: readonly KnipIssue[]): KnipCounts;

export function findRatchetViolations(
  current: KnipCounts,
  baseline: KnipCounts,
): RatchetViolation[];

export function parseKnipIssues(stdout: string, stderr: string): KnipIssue[];
