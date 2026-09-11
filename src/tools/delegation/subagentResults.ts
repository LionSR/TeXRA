/**
 * Formatting utilities for subagent results and progress updates.
 *
 * Format helpers convert a run's terminal facts and progress updates into
 * structured XML strings for FollowUpQueue delivery to the orchestrator.
 *
 * Design: Typed objects internally, XML formatting only at the boundary
 * (just before injection into model context via FollowUpQueue).
 */

import path from 'node:path';

import type { AttachedMemoryMiss } from '@agent/types/AttachedMemory';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import { normalizeProviderError } from '@common/errors/sdkError/providerErrorFormat';
import { createLog } from '@logger/logUtils';
import {
  runStorageFilePath,
  type OutputFileSummary,
  type ResultDiffSummary,
  type ResultMeta,
  type RunEndOutput,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import { formatDuration, unique } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { getRunDir, ensureRunDir } from '@utils/files/runStorageFs';
import { sanitizePathSegment } from '@utils/text/sanitizePathSegment';
import { countLines } from '@utils/text/stringUtils';
import { unifiedDiffText } from '@utils/text/unifiedDiff';
import {
  formatChildRunDelivery,
  formatChildRunError,
} from './deliveryEnvelope';

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
 * Injected into the orchestrator's FollowUpQueue as a user-role message.
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

  return formatChildRunDelivery(
    {
      tag: DELIVERY_TAG.subagentResult,
      runId: options.runId,
      attributes: [
        { name: 'agent', value: agentName },
        { name: 'category', value: output.category },
        { name: 'status', value: result.outcome },
      ],
    },
    {
      wallTime:
        options.wallTimeMs !== undefined
          ? formatDuration(options.wallTimeMs)
          : undefined,
      lines,
    },
  );
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
  return formatChildRunError(
    {
      tag: DELIVERY_TAG.subagentError,
      runId,
      attributes: [
        { name: 'agent', value: agentName },
        { name: 'retryable', value: formatted.userRetryable },
      ],
    },
    {
      wallTime:
        options?.wallTimeMs !== undefined
          ? formatDuration(options.wallTimeMs)
          : undefined,
      lines: formatDeliveryPreamble({
        workingDirectory: options?.workingDirectory,
        memoryMisses: options?.memoryMisses,
      }),
      message: formatted.message,
    },
  );
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

const log = createLog('subagentDiffs');
// The boundary warn in `buildSubagentResult` predates the A4 file merge and
// stays on its historical channel so log ingestion keyed on it keeps seeing it.
const deliveryLog = createLog('subagentDelivery');

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
export async function computeAndWriteWorkflowDiffs(
  runId: RunId,
  outputs: OutputFileSummary[],
): Promise<Map<string, DiffFileInfo>> {
  const results = new Map<string, DiffFileInfo>();
  const diffsToWrite: { diffRelPath: string; content: string }[] = [];

  // First pass: compute diffs and decide which to write.
  await Promise.all(
    outputs.map(async (o) => {
      if (!o.originalPath) return;
      try {
        const [original, modified] = await Promise.all([
          AbsoluteFS.read(o.originalPath),
          AbsoluteFS.read(o.absolutePath),
        ]);

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
      } catch (error) {
        // File read failure is non-fatal — skip diff for this file — but
        // surface the skip so a missing diff is not indistinguishable from an
        // unchanged file (matching the loud diff-unavailable note the caller
        // boundary logs).
        log.warn(
          `Skipping diff for ${o.absolutePath}: ${toErrorMessage(error)}`,
        );
      }
    }),
  );

  // Second pass: write diff files to disk.
  if (diffsToWrite.length > 0) {
    const runDir = getRunDir(runId);
    await ensureRunDir(runId);
    const diffsDir = path.join(runDir, 'diffs');
    await AbsoluteFS.ensureDir(diffsDir);

    await Promise.all(
      diffsToWrite.map(async ({ diffRelPath, content }) => {
        const fullPath = path.join(runDir, diffRelPath);
        await AbsoluteFS.write(fullPath, content);
      }),
    );
  }

  return results;
}

// ============================================================================
// Built terminal results
// ============================================================================

/**
 * Build a subagent's persistence record. For workflow results, computes
 * latexdiffs and writes them as files to the run's run directory first — the
 * record and the delivery reference diff file paths so the orchestrator can
 * read them on demand via /executions/{id}/files/.
 */
export async function buildSubagentResult(
  runId: RunId,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
  },
): Promise<SubagentResultMeta> {
  let diffInfos: Map<string, DiffFileInfo> | undefined;
  let diffsUnavailable: string | undefined;
  if (
    result.output.category === 'workflow' &&
    result.output.outputs.length > 0
  ) {
    try {
      diffInfos = await computeAndWriteWorkflowDiffs(
        runId,
        result.output.outputs,
      );
    } catch (err) {
      // Diff computation failure is non-fatal: deliver without diffs, but tell
      // the orchestrator to read the output files directly.
      diffsUnavailable = toErrorMessage(err);
      deliveryLog.warn(
        `Diff computation failed for ${runId}: ${diffsUnavailable}`,
      );
    }
  }

  const wallTimeMs = Date.now() - options.startedAt;
  const output: RunEndOutput =
    result.output.category === 'workflow'
      ? {
          ...result.output,
          ...(diffInfos
            ? {
                diffs: result.output.outputs.flatMap((file) => {
                  const diff = diffInfos.get(file.absolutePath);
                  return diff ? [{ path: file.absolutePath, ...diff }] : [];
                }),
              }
            : {}),
          ...(diffsUnavailable !== undefined ? { diffsUnavailable } : {}),
        }
      : result.output;
  return buildSubagentResultMeta(agentName, output, wallTimeMs);
}
