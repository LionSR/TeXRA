/**
 * How a document task's run reads to whoever launched it
 * (`DOCUMENT_TASK_RESULT`, the documents plugin's `AgentBlock.result`): its
 * delivery to the launching model (every revision's outputs, the proposed
 * revision's diffs, and the compile failures), the files it wrote for a
 * script's summary, and the diffs `document_propose` writes, which the
 * documents fact records and the run's result is derived from.
 */
import path from 'node:path';

import { Effect, FileSystem } from 'effect';

import { withLogChannel, isPathWithin } from '@texra-ai/harness';
import { runStorageFilePath, type RunId } from '@shared/schemas';
import { escapeAttr } from '@shared/utils/xmlEscape';
import { stripWorkflowRoundDir } from '@texra/shared/constants/workflowOutput';
import {
  DocumentsResultSchema,
  type DocumentDiffs,
  type DocumentsResult,
  type OutputFileSummary,
  type ResultDiffSummary,
} from '@texra/shared/plugins/documentOutputs';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { runDirUnder } from '@utils/files/runStorageFs';
import { workspaceRelativePath } from '@utils/files/workspaceFS';
import { countLines } from '@utils/text/stringUtils';
import { reportDiffTimeout, unifiedDiffText } from '@utils/text/unifiedDiff';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { AgentBlockResult, RecipeChange } from '@texra-ai/harness/plugins';

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
  const byRound = Map.groupBy(outputs, (o) => o.round);
  // Multiple rounds — group files under <round> tags
  const body =
    byRound.size <= 1
      ? outputs.map(format)
      : [...byRound]
          .sort(([a], [b]) => a - b)
          .flatMap(([round, files]) => [
            `<round number="${round}">`,
            ...files.map(format),
            '</round>',
          ]);
  return ['<output-files>', ...body, '</output-files>'];
}

/** The delivery body of a document task's result. Diff files are readable
 *  via /executions/{id}/files/{diffRelPath}; the delivery names them only. */
function documentsDelivery(value: DocumentsResult, runId: RunId): string[] {
  const lines: string[] = [];
  if (value.diffsUnavailable) {
    lines.push(
      `<diffs-unavailable reason="${escapeAttr(value.diffsUnavailable)}">Diff computation failed: read the output files directly to review the changes.</diffs-unavailable>`,
    );
  }
  if (value.outputs.length > 0) {
    const diffsByPath = new Map(
      value.diffs.map((diff) => [diff.path, diff] as const),
    );
    lines.push(...formatWorkflowOutputs(value.outputs, runId, diffsByPath));
  }
  if (value.compileFailures.length > 0) {
    lines.push('<compile-failures>');
    for (const failure of value.compileFailures) {
      lines.push(
        `<failure round="${failure.round}" file="${escapeAttr(failure.displayName)}" output="${escapeAttr(failure.outputPath)}" log="${escapeAttr(failure.logPath)}" />`,
      );
    }
    lines.push('</compile-failures>');
  }
  return lines;
}

/**
 * The workspace file an output replaces, not the run-storage copy that
 * carries it. A diff base in run storage is a child's `original/` snapshot
 * of the input, and then the output's round-relative name is the workspace
 * path.
 */
function deliveredFilePath(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  output: OutputFileSummary,
): string {
  return output.originalPath === null ||
    isPathWithin(roots.storage, output.originalPath)
    ? stripWorkflowRoundDir(output.relativePath)
    : workspaceRelativePath(roots.workspace, output.originalPath);
}

/** Every revision's outputs, in revision order: a document revised twice
 *  appears twice, the later entry its latest. */
function documentChanges(
  value: DocumentsResult,
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): RecipeChange[] {
  return value.outputs
    .toSorted((a, b) => a.round - b.round)
    .map((output) => ({
      path: deliveredFilePath(roots, output),
      absolutePath: output.absolutePath,
      base: output.originalPath,
      added: output.added,
      removed: output.removed,
    }));
}

/** How a document task's run reads to whoever launched it. */
export const DOCUMENT_TASK_RESULT: AgentBlockResult<DocumentsResult> =
  Object.freeze({
    schema: DocumentsResultSchema,
    delivery: documentsDelivery,
    changes: documentChanges,
  });

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

const CHANNEL = 'documentDiffs';

/**
 * Truncate diff text to a maximum number of lines.
 * Appends a truncation notice if the diff exceeds the limit.
 */
function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + '\n[... diff truncated]';
}

/**
 * Compute diffs for workflow output files and write them to the run's
 * run directory as `.diff` files, in the order of `outputs`.
 *
 * All diffs are written regardless of change size. Large changes (ratio above
 * {@link LARGE_CHANGE_RATIO}) are flagged so the orchestrator knows the diff
 * may be truncated and can read the full output file for context.
 *
 * Files without an original (new files) or where reading fails are omitted.
 */
const computeAndWriteWorkflowDiffs = Effect.fn('documents.computeDiffs')(
  function* (storageRoot: string, runId: RunId, outputs: OutputFileSummary[]) {
    const fs = yield* FileSystem.FileSystem;
    const computed = yield* Effect.forEach(
      outputs,
      (o) =>
        Effect.gen(function* () {
          if (!o.originalPath) return null;
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

          const { text: diff, timeout } = unifiedDiffText(original, modified);
          yield* reportDiffTimeout(timeout);
          if (!diff) return null;
          const limit = largeChange ? LARGE_CHANGE_DIFF_LINES : MAX_DIFF_LINES;
          // Use full relativePath (with separators replaced) to avoid collisions
          // when multiple files share the same basename in different directories.
          const safeName = o.relativePath.replaceAll(/[\\/]/g, '_');
          const summary: ResultDiffSummary = {
            path: o.absolutePath,
            diffRelPath: `diffs/${safeName}.diff`,
            largeChange,
          };
          return { summary, content: truncateDiff(diff, limit) };
        }).pipe(
          // File read failure is non-fatal — skip diff for this file — but
          // surface the skip so a missing diff is not indistinguishable from an
          // unchanged file (matching the loud diff-unavailable note the caller
          // boundary logs).
          Effect.catch((error) =>
            Effect.logWarning(
              `Skipping diff for ${o.absolutePath}: ${toErrorMessage(error)}`,
            ).pipe(withLogChannel(CHANNEL), Effect.as(null)),
          ),
        ),
      { concurrency: 'unbounded' },
    );
    const written = computed.filter((diff) => diff !== null);
    if (written.length > 0) {
      const runDir = runDirUnder(storageRoot, runId);
      // One recursive create reaches the run directory and the runs root above
      // it, which is all the run-dir ensure ahead of this ever did.
      yield* fs.makeDirectory(path.join(runDir, 'diffs'), { recursive: true });
      yield* Effect.forEach(
        written,
        ({ summary, content }) =>
          fs.writeFileString(path.join(runDir, summary.diffRelPath), content),
        { concurrency: 'unbounded', discard: true },
      );
    }
    return written.map((diff) => diff.summary);
  },
);

/**
 * The diffs of a task's outputs against the documents they started from,
 * written to the run's storage: what `document_propose` records in the
 * documents fact. A failed computation is no diffs, with the reason, and is
 * logged; the task still proposes.
 */
export const computeDocumentDiffs = Effect.fn('documents.diffs')(function* (
  storageRoot: string,
  runId: RunId,
  outputs: OutputFileSummary[],
): Effect.fn.Return<DocumentDiffs, never, FileSystem.FileSystem> {
  if (outputs.length === 0) return {};
  const computed = yield* Effect.result(
    computeAndWriteWorkflowDiffs(storageRoot, runId, outputs),
  );
  if (computed._tag === 'Failure') {
    const reason = toErrorMessage(computed.failure);
    yield* Effect.logWarning(
      `Diff computation failed for ${runId}: ${reason}`,
    ).pipe(withLogChannel(CHANNEL));
    return { diffsUnavailable: reason };
  }
  return { diffs: computed.success };
});
