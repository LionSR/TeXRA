/**
 * Agent review issue model: schema, model-response parsing, and prompt
 * building for the local agent review feature.
 *
 * Host-neutral core — the VS Code extension (and potentially other hosts)
 * collects a diff of the working tree against the main branch, sends it
 * through a one-shot helper-model call, and parses the structured issue
 * list out of the response. Issue ids are assigned here, at store time,
 * so downstream renderers never have to synthesize identity.
 */

// Standard library imports
import { randomUUID } from 'node:crypto';

// Third-party imports
import { z } from 'zod';

// Local imports
import { AGENT_REVIEW_APPROACHES } from '@shared/schemas/coreSettings';

const REVIEW_SEVERITIES = ['critical', 'warning', 'info'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/**
 * Issue entry as requested from the model. Lenient on the fields a model
 * is most likely to fumble (line numbers, severity) so a single sloppy
 * entry degrades gracefully instead of discarding the whole review.
 */
const ModelReviewIssueSchema = z.object({
  file: z.string().min(1),
  startLine: z.int().positive().catch(1),
  endLine: z.int().positive().nullish(),
  severity: z.enum(REVIEW_SEVERITIES).catch('warning'),
  title: z.string().min(1),
  description: z.string().catch(''),
  suggestion: z.string().nullish(),
});

export interface ReviewIssue {
  /** Stable id assigned at parse time; used by tree items, diagnostics, and commands. */
  id: string;
  /** Repository-relative path with forward slashes (as in the diff). */
  file: string;
  /** 1-based line in the new version of the file. */
  startLine: number;
  /** 1-based inclusive end line; always >= startLine. */
  endLine: number;
  severity: ReviewSeverity;
  title: string;
  description: string;
  suggestion?: string;
}

/** Strip diff-style `a/`/`b/` prefixes and normalize separators. */
export function normalizeReviewFilePath(file: string): string {
  let normalized = file.trim().replaceAll('\\', '/');
  if (normalized.startsWith('a/') || normalized.startsWith('b/')) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Extract candidate JSON payloads from a model response, most-specific
 * first: fenced ```json blocks, then the widest bracketed array, then the
 * widest object (for `{ "issues": [...] }` shaped replies).
 */
function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    candidates.push(match[1]);
  }
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  return candidates;
}

/**
 * Parse the issue list out of a raw model response.
 *
 * Accepts a bare JSON array, an `{ "issues": [...] }` object, or either
 * wrapped in a code fence. Invalid entries are skipped rather than failing
 * the parse; an unparseable response yields an empty list.
 */
export function parseReviewResponse(text: string): ReviewIssue[] {
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const rawIssues = Array.isArray(parsed)
      ? parsed
      : parsed !== null &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { issues?: unknown }).issues)
        ? (parsed as { issues: unknown[] }).issues
        : null;
    if (!rawIssues) continue;

    return rawIssues.flatMap((raw): ReviewIssue[] => {
      const result = ModelReviewIssueSchema.safeParse(raw);
      if (!result.success) return [];
      const entry = result.data;
      const startLine = entry.startLine;
      const endLine = Math.max(startLine, entry.endLine ?? startLine);
      return [
        {
          id: randomUUID(),
          file: normalizeReviewFilePath(entry.file),
          startLine,
          endLine,
          severity: entry.severity,
          title: entry.title.trim(),
          description: entry.description.trim(),
          suggestion: entry.suggestion?.trim() || undefined,
        },
      ];
    });
  }
  return [];
}

export type ReviewApproach = (typeof AGENT_REVIEW_APPROACHES)[number];

export interface ReviewPromptInput {
  /** Human-readable description of the diff base (e.g. "main branch (origin/main)"). */
  baseDescription: string;
  changedFiles: string[];
  diff: string;
  approach: ReviewApproach;
  /** Full file contents appended in thorough mode. */
  extraContext?: string;
}

const MAX_REPORTED_ISSUES = 10;

const REVIEW_SYSTEM_PROMPT = `You are an automated reviewer for a research project. You are given the diff of the user's working tree against the repository's base branch. Report concrete, high-value problems INTRODUCED BY THIS CHANGE — your findings appear directly in the user's editor, so precision matters more than volume.

Look for, in priority order:
1. Bugs and correctness issues: logic errors, broken references, off-by-one or boundary mistakes, wrong signs/units in math or numerics, unhandled error paths.
2. Accidental commits: secrets or API keys, build artifacts, caches or databases (e.g. package-store or .db files), personal/editor configuration that contradicts the project's documented setup, large binaries.
3. Security problems: injection, unvalidated external input, destructive operations without guards.
4. Inconsistencies with the rest of the change or the project: configuration that does not match what the project documentation specifies, renamed symbols with stale call sites, LaTeX labels/citations that no longer resolve.

Do NOT report style preferences, formatting, or speculative concerns. If the change is sound, report nothing.

Respond with ONLY a JSON array (inside a \`\`\`json code fence) of at most ${MAX_REPORTED_ISSUES} issues, ordered most severe first. Each item:
{
  "file": "path exactly as it appears in the diff (repository-relative)",
  "startLine": <1-based line number in the NEW version of the file>,
  "endLine": <optional 1-based inclusive end line>,
  "severity": "critical" | "warning" | "info",
  "title": "short one-line summary",
  "description": "what is wrong and why it matters, in 1-3 sentences",
  "suggestion": "optional: the concrete fix"
}
For deleted or binary files use startLine 1. If there are no significant issues respond with [].`;

const THOROUGH_ADDENDUM = `\n\nThis is a THOROUGH review: full contents of the changed files are provided after the diff. Cross-check the diff against the surrounding code — callers, definitions, and project configuration — before reporting, and verify each issue against the full file rather than the diff hunk alone.`;

const QUICK_ADDENDUM = `\n\nThis is a QUICK review: judge from the diff alone and only report issues you are confident about.`;

/** Build the system and user prompts for a review call. */
export function buildReviewPrompts(input: ReviewPromptInput): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemPrompt =
    REVIEW_SYSTEM_PROMPT +
    (input.approach === 'thorough' ? THOROUGH_ADDENDUM : QUICK_ADDENDUM);

  const parts = [
    `<base>${input.baseDescription}</base>`,
    `<changed-files>\n${input.changedFiles.join('\n')}\n</changed-files>`,
    `<diff>\n${input.diff}\n</diff>`,
  ];
  if (input.extraContext) {
    parts.push(`<file-contents>\n${input.extraContext}\n</file-contents>`);
  }
  return { systemPrompt, userPrompt: parts.join('\n\n') };
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
      `${index + 1}. ${issue.file}:${lineRange} [${issue.severity}] — ${issue.title}`,
    );
    if (issue.description) lines.push(`   ${issue.description}`);
    if (issue.suggestion) lines.push(`   Suggested fix: ${issue.suggestion}`);
    lines.push('');
  }
  lines.push(
    'Make the smallest change that resolves each issue; do not refactor unrelated code. Read each file before editing — line numbers may have drifted since the review.',
  );
  return lines.join('\n');
}
