/**
 * Agent review issue model for the local agent review feature.
 *
 * Issues are reported live by the `changeReviewer` tool-use agent through
 * the `report_review_issue` tool; this module owns the canonical issue
 * shape, the store-time construction (ids are assigned here, never at
 * render time), and the instruction builders for the review and fix
 * agent sessions. Host-neutral — no vscode.
 */

// Standard library imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import { z } from 'zod';

// Local imports
import { normalizeFilePath } from '@utils/core';

const REVIEW_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface ReviewIssue {
  /** Stable id assigned at store time; used by tree items, diagnostics, and commands. */
  id: string;
  /** Repository-relative path with forward slashes (as in the diff). */
  file: string;
  /** 1-based line in the current version of the file. */
  startLine: number;
  /** 1-based inclusive end line; always >= startLine. */
  endLine: number;
  severity: ReviewSeverity;
  title: string;
  description: string;
  suggestion?: string;
}

/**
 * Wire shape of one finding, owned here because the `report_review_issue`
 * tool's input and the host-facing report are the same payload; the
 * `.describe()` strings are the model-facing documentation of each field.
 */
export const ReportReviewIssueInputSchema = z.strictObject({
  file: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Repository-relative path of the file the issue is in, exactly as it appears in the diff.',
    ),
  startLine: z
    .int()
    .min(1)
    .describe(
      '1-based line number in the current version of the file where the issue starts.',
    ),
  endLine: z
    .int()
    .min(1)
    .nullish()
    .describe('Optional 1-based inclusive end line of the issue.'),
  severity: z
    .enum(REVIEW_SEVERITIES)
    .describe(
      'critical = bug, security problem, or accidental commit; warning = likely problem worth fixing; info = minor but material.',
    ),
  title: z.string().trim().min(1).describe('Short one-line summary.'),
  description: z
    .string()
    .describe('What is wrong and why it matters, in 1-3 sentences.'),
  suggestion: z.string().nullish().describe('Optional concrete fix.'),
});

/** Raw finding as supplied by the reviewer agent's `report_review_issue` tool. */
export type ReviewIssueReport = z.infer<typeof ReportReviewIssueInputSchema>;

/** Strip diff-style `a/`/`b/` prefixes and normalize separators. */
export function normalizeReviewFilePath(file: string): string {
  let normalized = normalizeFilePath(file.trim());
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Build a stored issue from an agent report: id assigned at store time,
 * path normalized, line range clamped to a sane 1-based span.
 */
export function createReviewIssue(report: ReviewIssueReport): ReviewIssue {
  const startLine = Math.max(1, Math.floor(report.startLine));
  const endLine = Math.max(startLine, Math.floor(report.endLine ?? startLine));
  return {
    id: randomUUID(),
    file: normalizeReviewFilePath(report.file),
    startLine,
    endLine,
    severity: report.severity,
    title: report.title.trim(),
    description: report.description.trim(),
    suggestion: report.suggestion?.trim() || undefined,
  };
}

interface ReviewInstructionInput {
  /** Human-readable description of the diff base (e.g. "main branch (origin/main)"). */
  baseDescription: string;
  changedFiles: string[];
  diff: string;
  truncated: boolean;
  /** Optional free-text focus supplied per run via the "Find Issues" options. */
  userInstructions?: string;
}

/**
 * Build the instruction for a `changeReviewer` tool-use session. The diff and
 * changed-file list give the reviewer the change set while leaving the review
 * depth and supporting tool use to the model.
 */
export function buildReviewInstruction(input: ReviewInstructionInput): string {
  const sections = [
    `Review the working tree's diff with the ${input.baseDescription}. Decide which files and surrounding code must be inspected to assess the changes reliably.`,
  ];
  if (input.userInstructions) {
    sections.push(
      `Prioritize the user review instructions below. Also report other critical issues:\n<reviewer-instructions>\n${input.userInstructions}\n</reviewer-instructions>`,
    );
  }
  sections.push(
    `Report each confirmed finding with the report_review_issue tool, using the repository-relative path exactly as it appears in the diff.${input.truncated ? ' The diff was truncated to fit; read the listed files for the full picture.' : ''}`,
    `<changed-files>\n${input.changedFiles.join('\n')}\n</changed-files>`,
    `<diff>\n${input.diff}\n</diff>`,
  );
  return sections.join('\n\n');
}

/**
 * Build the instruction handed to a file-editing tool-use agent for
 * "Fix with Agent" / "Fix All Issues".
 */
export function buildFixInstruction(
  issues: readonly ReviewIssue[],
  baseDescription: string,
): string {
  const lines = [
    `Fix the following ${issues.length === 1 ? 'issue' : `${issues.length} issues`} found by an automated review of this branch's diff with the ${baseDescription}:`,
    '',
  ];
  for (const [index, issue] of issues.entries()) {
    const lineRange =
      issue.endLine > issue.startLine
        ? `${issue.startLine}-${issue.endLine}`
        : `${issue.startLine}`;
    lines.push(
      `${index + 1}. ${issue.file}:${lineRange} [${issue.severity}]: ${issue.title}`,
    );
    if (issue.description) lines.push(`   ${issue.description}`);
    if (issue.suggestion) lines.push(`   Suggested fix: ${issue.suggestion}`);
    lines.push('');
  }
  lines.push(
    'Make the smallest change that resolves each issue; do not refactor unrelated code. Read each file before editing because line numbers may have drifted since the review.',
  );
  return lines.join('\n');
}
