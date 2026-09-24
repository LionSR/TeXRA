/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert a run's terminal facts and progress updates into
 * structured XML strings for follow-up delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context as a queued follow-up).
 */

import path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { withLogChannel } from '@logger/effectLog';
import {
  runStorageFilePath,
  type AttachedMemoryMiss,
  type OutputFileSummary,
  type ResultDiffSummary,
  type ResultMeta,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { runDirUnder } from '@utils/files/runStorageFs';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';
import { countLines, formatDuration } from '@utils/text/stringUtils';
import { unifiedDiffText } from '@utils/text/unifiedDiff';
import { formatDelivery } from './deliveryEnvelope';

export type SubagentResultMeta = Extract<ResultMeta, { producer: 'subagent' }>;

// ============================================================================
// Formatting helpers
// ============================================================================

/**
 * Format a single output file summary as XML. `path` remains run-relative for
 * acceptance tools; `read-path` identifies the model-facing route to inspect
 * the generated artifact.
 * When diff info is provided, includes a `diff` attribute pointing to the diff
 * file path (readable via /executions/{id}/files/...). Large changes are
 * flagged with `large-change="true"` but still include a diff file.
 */
function formatOutputFile(
  o: OutputFileSummary,
  runId: RunId,
  diffInfo?: ResultDiffSummary,
): string {
  const readPath =
    o.location === 'runStorage'
      ? runStorageFilePath(runId, o.relativePath)
      : o.absolutePath;
  const attrs = [
    `path="${escapeAttr(o.relativePath)}"`,
    `read-path="${escapeAttr(readPath)}"`,
    `location="${escapeAttr(o.location)}"`,
    o.originalPath !== null && `original="${escapeAttr(o.originalPath)}"`,
    o.added !== null && `added="${o.added}"`,
    o.removed !== null && `removed="${o.removed}"`,
  ]
    .filter(Boolean)
    .join(' ');

  if (diffInfo) {
    // Diff available as a file — orchestrator can read it on demand.
    const extra = diffInfo.largeChange ? ' large-change="true"' : '';
    return `<file ${attrs} diff="${escapeAttr(diffInfo.diffRelPath)}"${extra} />`;
  }
  return `<file ${attrs} />`;
}

/**
 * Format workflow output files, grouping by round when there are multiple rounds.
 * When diff info is provided, each <file> element includes a `diff` attribute
 * pointing to the diff file path (readable via /executions/{id}/files/...).
 */
function formatWorkflowOutputs(
  outputs: OutputFileSummary[],
  runId: RunId,
  diffInfos?: ReadonlyMap<string, ResultDiffSummary>,
): string[] {
  const format = (o: OutputFileSummary): string =>
    formatOutputFile(o, runId, diffInfos?.get(o.absolutePath));
  const rounds = unique(outputs.map((o) => o.round)).sort((a, b) => a - b);
  if (rounds.length <= 1) {
    return ['<output-files>', ...outputs.map(format), '</output-files>'];
  }
  // Multiple rounds — group files under <round> tags
  return [
    '<output-files>',
    ...rounds.flatMap((round) => [
      `<round number="${round}">`,
      ...outputs.filter((o) => o.round === round).map(format),
      '</round>',
    ]),
    '</output-files>',
  ];
}

/**
 * Shared context lines for both native delivery and error messages:
 * working-directory, then memory-misses, in that order (rendered right after
 * the builder-owned wall-time).
 */
function formatDeliveryPreamble(options: {
  workingDirectory?: string;
  memoryMisses?: readonly AttachedMemoryMiss[];
}): string[] {
  const lines: string[] = [];
  if (options.workingDirectory) {
    lines.push(
      `<working-directory>${escapeText(options.workingDirectory)}</working-directory>`,
    );
  }
  const misses = options.memoryMisses ?? [];
  if (misses.length > 0) {
    lines.push(
      '<memory-misses>',
      ...misses.map(
        (miss) =>
          `<memory-miss path="${escapeAttr(miss.path)}" reason="${escapeAttr(miss.reason)}" />`,
      ),
      '</memory-misses>',
    );
  }
  return lines;
}

/**
 * Format a run's terminal result as a delivery message.
 * Queued as a follow-up for the orchestrator, which it reads as a user-role message.
 *
 * Diff files are accessible via /executions/{id}/files/{diffRelPath}; the
 * delivery includes only the path reference, not the diff content itself.
 */
export function formatSubagentDelivery(
  agentName: string,
  result: { readonly outcome: RunOutcome; readonly output: RunEndOutput },
  options: {
    runId: RunId;
    memoryMisses?: readonly AttachedMemoryMiss[];
    wallTimeMs?: number;
    workingDirectory?: string;
  },
): string {
  const lines = formatDeliveryPreamble({
    workingDirectory: options.workingDirectory,
    memoryMisses: options.memoryMisses,
  });

  const { output } = result;
  if (output.category === 'workflow') {
    if (output.diffsUnavailable) {
      lines.push(
        `<diffs-unavailable reason="${escapeAttr(output.diffsUnavailable)}">Diff computation failed: read the output files directly to review the changes.</diffs-unavailable>`,
      );
    }
    if (output.outputs.length > 0) {
      const diffsByPath = new Map(
        output.diffs.map((diff) => [diff.path, diff] as const),
      );
      lines.push(
        ...formatWorkflowOutputs(output.outputs, options.runId, diffsByPath),
      );
    }
    if (output.compileFailures.length > 0) {
      lines.push('<compile-failures>');
      for (const failure of output.compileFailures) {
        lines.push(
          `<failure round="${failure.round}" file="${escapeAttr(failure.displayName)}" output="${escapeAttr(failure.outputPath)}" log="${escapeAttr(failure.logPath)}" />`,
        );
      }
      lines.push('</compile-failures>');
    }
  } else if (output.category === 'toolUse') {
    if (output.response) {
      lines.push('<response>', escapeText(output.response), '</response>');
    }
    if (output.files.length > 0) {
      lines.push(
        '<touched-files>',
        ...output.files.map((f) => `<file path="${escapeAttr(f)}" />`),
        '</touched-files>',
      );
    }
  }

  return formatDelivery({
    tag: DELIVERY_TAG.subagentResult,
    runId: options.runId,
    attributes: [
      { name: 'agent', value: agentName },
      { name: 'category', value: output.category },
      { name: 'status', value: result.outcome },
    ],
    wallTime:
      options.wallTimeMs !== undefined
        ? formatDuration(options.wallTimeMs)
        : undefined,
    lines,
  });
}

/**
 * Format an error as a delivery message.
 */
export function formatSubagentError(
  runId: string,
  agentName: string,
  err: unknown,
  options?: {
    wallTimeMs?: number;
    workingDirectory?: string;
    memoryMisses?: readonly AttachedMemoryMiss[];
  },
): string {
  const formatted = normalizeProviderError(err);
  return formatDelivery({
    tag: DELIVERY_TAG.subagentError,
    runId,
    attributes: [
      { name: 'agent', value: agentName },
      { name: 'retryable', value: formatted.userRetryable },
    ],
    wallTime:
      options?.wallTimeMs !== undefined
        ? formatDuration(options.wallTimeMs)
        : undefined,
    lines: formatDeliveryPreamble({
      workingDirectory: options?.workingDirectory,
      memoryMisses: options?.memoryMisses,
    }),
    message: formatted.message,
  });
}

// ============================================================================
// Orchestrator follow-up framing
// ============================================================================

/**
 * Wrap an orchestrator's follow-up instruction in an XML tag so the subagent
 * knows this is a follow-up from its orchestrator (not a fresh user message).
 */
export function formatFollowUpInstruction(instruction: string): string {
  return [
    '<orchestrator-followup>',
    escapeText(instruction),
    '</orchestrator-followup>',
  ].join('\n');
}

/**
 * Build the structured result manifest for a finished subagent — the
 * machine-readable counterpart of {@link formatSubagentDelivery}'s XML.
 * Persisted beside the run's `run.end` row so later stages (orchestrator or a
 * workflow script) can chain on outputs and diffs as data instead of parsing
 * prose; how the run ended is the terminal fact's to say, not this record's.
 */
export function buildSubagentResultMeta(
  agentName: string,
  output: RunEndOutput,
  wallTimeMs: number,
): SubagentResultMeta {
  return { producer: 'subagent', agentName, wallTimeMs, output };
}

// ============================================================================
// Workflow output diffs
// ============================================================================

/** Maximum lines of diff to include per file in deliveries. */
const MAX_DIFF_LINES = 200;

/** Shorter truncation limit for large changes (>40% of file modified). */
const LARGE_CHANGE_DIFF_LINES = 80;

/**
 * When the changed lines (added + removed) exceed this fraction of the
 * original file's line count, the diff is flagged as a large change.
 * The orchestrator still gets a diff file but truncated shorter.
 */
const LARGE_CHANGE_RATIO = 0.4;

const CHANNEL = 'subagentDiffs';
// The boundary warn in `buildSubagentResult` predates the A4 file merge and
// stays on its historical channel so log ingestion keyed on it keeps seeing it.
const DELIVERY_CHANNEL = 'subagentDelivery';

/**
 * Truncate diff text to a maximum number of lines.
 * Appends a truncation notice if the diff exceeds the limit.
 */
function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + '\n[... diff truncated]';
}

/** Info about a diff file written to the run's run directory. */
interface DiffFileInfo {
  /** The relative path within the run directory (e.g. "diffs/chapter1.tex.diff"). */
  diffRelPath: string;
  /** True when the change ratio exceeded the large-change threshold. */
  largeChange: boolean;
}

/**
 * Compute diffs for workflow output files and write them to the run's
 * run directory as `.diff` files. Returns a map from output absolutePath to
 * diff file info, so the delivery formatter can reference them by path.
 *
 * All diffs are written regardless of change size. Large changes (ratio above
 * {@link LARGE_CHANGE_RATIO}) are flagged so the orchestrator knows the diff
 * may be truncated and can read the full output file for context.
 *
 * Files without an original (new files) or where reading fails are omitted.
 */
const computeAndWriteWorkflowDiffs = Effect.fn(
  'subagentResults.computeAndWriteWorkflowDiffs',
)(function* (storageRoot: string, runId: RunId, outputs: OutputFileSummary[]) {
  const fs = yield* FileSystem.FileSystem;
  const results = new Map<string, DiffFileInfo>();
  const diffsToWrite: { diffRelPath: string; content: string }[] = [];

  // First pass: compute diffs and decide which to write.
  yield* Effect.forEach(
    outputs,
    (o) =>
      Effect.gen(function* () {
        if (!o.originalPath) return;
        const [original, modified] = yield* Effect.all(
          [
            readNormalizedFile(fs, o.originalPath),
            readNormalizedFile(fs, o.absolutePath),
          ],
          { concurrency: 2 },
        );

        // Flag large changes so the orchestrator knows to also read the
        // full output file — the diff alone may not capture everything.
        let largeChange = false;
        const originalLines = countLines(original);
        if (originalLines > 0 && o.added !== null && o.removed !== null) {
          const changedLines = o.added + o.removed;
          largeChange = changedLines / originalLines > LARGE_CHANGE_RATIO;
        }

        const diff = unifiedDiffText(original, modified);
        if (diff) {
          const limit = largeChange ? LARGE_CHANGE_DIFF_LINES : MAX_DIFF_LINES;
          const truncated = truncateDiff(diff, limit);
          // Use full relativePath (with separators replaced) to avoid collisions
          // when multiple files share the same basename in different directories.
          const safeName = sanitizePathSegment(o.relativePath, {
            invalidCharPattern: /[\\/]/g,
            replacement: '_',
          });
          const diffRelPath = `diffs/${safeName}.diff`;
          results.set(o.absolutePath, { diffRelPath, largeChange });
          diffsToWrite.push({ diffRelPath, content: truncated });
        }
      }).pipe(
        // File read failure is non-fatal — skip diff for this file — but
        // surface the skip so a missing diff is not indistinguishable from an
        // unchanged file (matching the loud diff-unavailable note the caller
        // boundary logs).
        Effect.catch((error) =>
          Effect.logWarning(
            `Skipping diff for ${o.absolutePath}: ${toErrorMessage(error)}`,
          ).pipe(withLogChannel(CHANNEL)),
        ),
      ),
    { concurrency: 'unbounded' },
  );

  // Second pass: write diff files to disk.
  if (diffsToWrite.length > 0) {
    const runDir = runDirUnder(storageRoot, runId);
    // One recursive create reaches the run directory and the runs root above
    // it, which is all the run-dir ensure ahead of this ever did.
    const diffsDir = path.join(runDir, 'diffs');
    yield* fs.makeDirectory(diffsDir, { recursive: true });

    yield* Effect.forEach(
      diffsToWrite,
      ({ diffRelPath, content }) =>
        fs.writeFileString(path.join(runDir, diffRelPath), content),
      { concurrency: 'unbounded', discard: true },
    );
  }

  return results;
});

// ============================================================================
// Built terminal results
// ============================================================================

type WorkflowRunEndOutput = Extract<RunEndOutput, { category: 'workflow' }>;

/**
 * A workflow output with its diffs: computes them against each output's
 * original, writes them as files to the run's run directory, and records
 * their paths on the output so a reader can open them on demand. The one
 * owner of `diffs`/`diffsUnavailable`, for both deliveries that report a
 * workflow run: a subagent's record and the CLI's `texra run` result.
 * Diff computation failure is non-fatal: the output is returned without
 * diffs, and `diffsUnavailable` says why.
 */
export const withWorkflowDiffs = Effect.fn('subagentResults.withWorkflowDiffs')(
  function* (
    storageRoot: string,
    runId: RunId,
    output: WorkflowRunEndOutput,
  ): Effect.fn.Return<WorkflowRunEndOutput, never, FileSystem.FileSystem> {
    if (output.outputs.length === 0) return output;
    let diffsUnavailable: string | undefined;
    const diffInfos = yield* computeAndWriteWorkflowDiffs(
      storageRoot,
      runId,
      output.outputs,
    ).pipe(
      Effect.catch((err) => {
        diffsUnavailable = toErrorMessage(err);
        return Effect.logWarning(
          `Diff computation failed for ${runId}: ${diffsUnavailable}`,
        ).pipe(withLogChannel(DELIVERY_CHANNEL), Effect.as(undefined));
      }),
    );
    return {
      ...output,
      ...(diffInfos
        ? {
            diffs: output.outputs.flatMap((file) => {
              const diff = diffInfos.get(file.absolutePath);
              return diff ? [{ path: file.absolutePath, ...diff }] : [];
            }),
          }
        : {}),
      ...(diffsUnavailable !== undefined ? { diffsUnavailable } : {}),
    };
  },
);

/**
 * Build a subagent's persistence record. For workflow results, computes
 * the output diffs first ({@link withWorkflowDiffs}) — the record and the
 * delivery reference diff file paths so the orchestrator can read them on
 * demand via /executions/{id}/files/.
 */
export const buildSubagentResult = Effect.fn(
  'subagentResults.buildSubagentResult',
)(function* (
  runId: RunId,
  agentName: string,
  output: RunEndOutput,
  options: {
    readonly startedAt: number;
    /** Storage root of the launching session: where this run's diffs land. */
    readonly storageRoot: string;
  },
): Effect.fn.Return<SubagentResultMeta, never, FileSystem.FileSystem> {
  const enriched: RunEndOutput =
    output.category === 'workflow'
      ? yield* withWorkflowDiffs(options.storageRoot, runId, output)
      : output;
  const wallTimeMs = Date.now() - options.startedAt;
  return buildSubagentResultMeta(agentName, enriched, wallTimeMs);
});
