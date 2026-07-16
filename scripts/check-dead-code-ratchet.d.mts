export type FindingCategory = 'files' | 'exports' | 'types' | 'duplicates';

export interface KnipFinding {
  file: string;
  category: FindingCategory;
  name: string;
}

export interface FindingsDiff {
  newFindings: KnipFinding[];
  resolvedFindings: KnipFinding[];
}

export interface KnipIssue {
  file: string;
  files?: readonly unknown[];
  exports?: readonly unknown[];
  types?: readonly unknown[];
  duplicates?: readonly unknown[];
}

export function extractFindings(issues: readonly KnipIssue[]): KnipFinding[];

export function findingKey(finding: KnipFinding): string;

export function compareFindings(a: KnipFinding, b: KnipFinding): number;

export function diffFindings(
  current: readonly KnipFinding[],
  baseline: readonly KnipFinding[],
): FindingsDiff;

export function countByCategory(
  findings: readonly KnipFinding[],
): Record<FindingCategory, number>;

export function parseKnipIssues(stdout: string, stderr: string): KnipIssue[];

export function readBaseline(rawJson: string): KnipFinding[];
