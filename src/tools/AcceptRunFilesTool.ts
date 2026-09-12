/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files live in task-run storage
 * (executions/{runId}/). This tool copies those files into the workspace
 * — the programmatic equivalent of the "Accept" button in the progress view.
 *
 * Each file goes through the standard tool edit approval flow (same diff
 * panel as write_file), so the user can review, edit, or reject each file.
 */

// Third-party imports
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { Effect } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import { currentSession } from '@agent/runtime/SessionHandle';
import { appSignals } from '@eventBus/AppSignals';
import { cleanupAcceptedWorkspaceDiffFiles } from '@latex/acceptedFileTarget';
import { effectRuntime } from '@platform/processRuntime';
import { stripCriticizeAnnotations } from '@replacement/advanced';
import {
  RunIdSchema,
  ToolError,
  type EditRecord,
  type ToolResult,
} from '@shared/schemas';
import type { RequestRefusal, RunId, FileLocation } from '@shared/schemas';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { formatResultCount, pluralize } from '@utils/text/stringUtils';
import {
  findExistingRunStoragePath,
  getOriginalSnapshotPath,
  inspectRunStorageEntry,
} from '@utils/files/runStorageFs';

// ============================================================================
// Rejection bookkeeping
// ============================================================================

/** One declined file: the refusal a person or a policy gave it. */
interface RecordedRejection {
  readonly path: string;
  readonly refusal: RequestRefusal;
}

/**
 * The one refusal a whole-run rejection reports: a cancellation outranks a
 * denial, which outranks a person's rejection, and the feedback every
 * rejected file collected rides the person's arm.
 */
function summarizeRefusals(rejections: readonly RecordedRejection[]): {
  readonly path: string;
  readonly refusal: RequestRefusal;
} {
  const of = <A extends RequestRefusal['action']>(action: A) =>
    rejections.filter(
      (
        r,
      ): r is RecordedRejection & {
        refusal: Extract<RequestRefusal, { action: A }>;
      } => r.refusal.action === action,
    );
  const cancelled = of('cancel');
  const denied = of('deny');
  const rejected = of('reject');
  const pathOf = (group: readonly RecordedRejection[]) =>
    group.length > 1 ? 'multiple files' : group[0]!.path;
  const lines = (values: readonly (string | null | undefined)[]) =>
    values.filter((v): v is string => !!v).join('\n');
  if (cancelled.length > 0) {
    return {
      path: pathOf(cancelled),
      refusal: {
        action: 'cancel',
        cause: lines(cancelled.map((r) => r.refusal.cause)) || null,
      },
    };
  }
  if (denied.length > 0) {
    return {
      path: pathOf(denied),
      refusal: {
        action: 'deny',
        reason: lines(denied.map((r) => r.refusal.reason)),
      },
    };
  }
  return {
    path: pathOf(rejected),
    refusal: {
      action: 'reject',
      feedback: lines(rejected.map((r) => r.refusal.feedback)) || null,
    },
  };
}

// ============================================================================
// Schema
// ============================================================================

const FileMapping = z.strictObject({
  /** Output file path (matches `path` attribute in subagent-result XML). */
  path: z
    .string()
    .describe(
      'Output file path (matches path attribute in subagent-result delivery)',
    ),
  /**
   * Original workspace path to restore to (matches `original` attribute in
   * subagent-result XML). If omitted, defaults to path.
   */
  original: z
    .string()
    .nullish()
    .describe(
      'Original workspace path to write to (matches original attribute in delivery). Defaults to path if omitted.',
    ),
});

const AcceptRunFilesInputSchema = z.strictObject({
  /** Run ID (matches `id` attribute in subagent-result XML). */
  execution_id: RunIdSchema.describe(
    'Run ID (matches id attribute in subagent-result delivery)',
  ),
  /** Files to accept from run storage into the workspace. */
  files: z
    .array(FileMapping)
    .min(1)
    .describe('Files to copy from run storage to workspace'),
  /** If true, strip `\criticize{...}{...}{...}` annotations before approval. */
  strip_criticize: z
    .boolean()
    .nullish()
    .describe(
      'If true, remove all \\criticize{...}{...}{...} LaTeX annotations from each file before approval. Use when accepting output from critique-style agents that embed review markers.',
    ),
});

export type AcceptRunFilesInput = z.infer<typeof AcceptRunFilesInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

export class AcceptRunFilesTool extends defineTool({
  name: 'accept_run_files',
  requiresApproval: true,
  description: `Accept output files from a completed workflow run into the workspace.

Only workflow subagent results (category="workflow") have output files to
accept; tool-use subagents return text and have nothing for this tool.

Locates output files in task-run storage and writes them to the workspace.
Each file goes through an approval step before writing and may be rejected.

Parameters map directly to subagent-result delivery attributes:
  execution_id ← <subagent-result id="...">
  path         ← <file path="...">
  original     ← <file original="...">`,
  schema: AcceptRunFilesInputSchema,
}) {
  protected execute(input: AcceptRunFilesInput): Promise<ToolResult> {
    const session = currentSession();
    const runtime = effectRuntime();
    const prepareFiles = AsyncLocalStorage.bind(() =>
      this.acceptFiles(input, runtime),
    );
    const findRunDirectory = AsyncLocalStorage.bind(() =>
      findExistingRunStoragePath(input.execution_id),
    );
    return runtime.runPromise(
      Effect.gen(function* () {
        const directory = yield* Effect.tryPromise({
          try: findRunDirectory,
          catch: (error) => error,
        });
        if (
          directory === undefined &&
          !(yield* getRunRecords(session, input.execution_id).exists())
        )
          return yield* Effect.fail(
            new ToolError(
              `Run not found: ${input.execution_id}. Use /executions to list available executions.`,
            ),
          );
        return yield* Effect.tryPromise({
          try: prepareFiles,
          catch: (error) => error,
        });
      }).pipe(Effect.orDie),
    );
  }

  private async acceptFiles(
    input: AcceptRunFilesInput,
    runtime: ReturnType<typeof effectRuntime>,
  ): Promise<ToolResult> {
    const { execution_id: runId, files, strip_criticize } = input;

    // Phase 1: Validate all source paths and read content before any approvals
    const prepared = await Promise.all(
      files.map(async (mapping) => {
        assertNoParentTraversal(mapping.path);

        const sourceLocation = await this.resolveSourceFile(
          runId,
          mapping.path,
        );

        const destPath = mapping.original ?? mapping.path;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `original must be inside the workspace: ${destPath}`,
          );
        }

        const rawContent = await AbsoluteFS.read(sourceLocation.absolutePath);
        const { content: proposedContent, count: strippedCount } =
          strip_criticize
            ? stripCriticizeAnnotations(rawContent)
            : { content: rawContent, count: 0 };
        const destExists = await WorkspaceFS.exists(dest.relativePath);

        // Determine original content for diff display. In-place workflow
        // outputs can make source and destination the same workspace file, so
        // the pre-run snapshot is the only reliable "before" image.
        const snapshotPath = getOriginalSnapshotPath(runId, dest.relativePath);
        const snapshotContent = (await AbsoluteFS.isFile(snapshotPath))
          ? await AbsoluteFS.read(snapshotPath)
          : undefined;
        const isSameFile =
          sourceLocation.kind === 'workspace' &&
          sourceLocation.absolutePath === dest.absolutePath;
        let originalContent: string;
        if (snapshotContent !== undefined) {
          originalContent = snapshotContent;
        } else if (isSameFile) {
          originalContent = rawContent;
        } else if (destExists) {
          originalContent = await WorkspaceFS.read(dest.relativePath);
        } else {
          originalContent = '';
        }

        return {
          path: mapping.path,
          original: dest.relativePath,
          destAbsolutePath: dest.absolutePath,
          proposedContent,
          originalContent,
          destExists,
          strippedCount,
        };
      }),
    );

    // Phase 2: Request approval and write each file
    const results: string[] = [];
    const edits: EditRecord[] = [];
    const acceptedEntries: {
      outputPath: string;
      originalPath: string;
      destAbsolutePath: string;
    }[] = [];
    let rejected = 0;
    let unchanged = 0;
    const rejections: RecordedRejection[] = [];

    let totalStripped = 0;

    for (const entry of prepared) {
      const mappingNote =
        entry.path !== entry.original ? ` (from ${entry.path})` : '';

      if (entry.originalContent === entry.proposedContent) {
        unchanged++;
        results.push(`unchanged: ${entry.original}${mappingNote}`);
        continue;
      }

      const approval = await runtime.runPromise(
        requestToolEditApproval({
          path: entry.original,
          originalContent: entry.originalContent,
          proposedContent: entry.proposedContent,
          sourceTool: 'accept_run_files',
        }),
      );

      if (approval.action !== 'apply') {
        rejected++;
        rejections.push({ path: entry.original, refusal: approval });
        results.push(`rejected: ${entry.original}${mappingNote}`);
        continue;
      }

      await writeApprovedContent(
        entry.original,
        entry.originalContent,
        approval.appliedContent,
      );

      const action = entry.destExists ? 'replaced' : 'created';
      const strippedNote =
        entry.strippedCount > 0
          ? ` (stripped ${entry.strippedCount} \\criticize)`
          : '';
      totalStripped += entry.strippedCount;
      results.push(`${action}: ${entry.original}${mappingNote}${strippedNote}`);
      edits.push({
        path: entry.original,
        lineChanges: approval.lineChanges,
        startLine: approval.startLine,
      });
      acceptedEntries.push({
        outputPath: entry.path,
        originalPath: entry.original,
        destAbsolutePath: entry.destAbsolutePath,
      });
    }

    // Badge all accepted workspace files
    if (acceptedEntries.length > 0) {
      appSignals.emit('workspaceFilesWritten', {
        absolutePaths: acceptedEntries.map((e) => e.destAbsolutePath),
      });
    }

    const changed = files.length - unchanged;
    const detailedOutput = (summary: string): string =>
      `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`;

    if (changed === 0) {
      const summary = `No changes to accept from run ${runId}`;
      return {
        status: 'executed',
        summary,
        output: detailedOutput(summary),
        edits,
      };
    }

    // All changed files rejected: one rejection result, worded by the
    // refusal that outranks the others.
    if (rejected === changed && acceptedEntries.length === 0) {
      const { path, refusal } = summarizeRefusals(rejections);
      return buildApprovalRejectedResult(path, 'accept_run_files', refusal);
    }

    // Phase 3: Clean up diff files from workspace for accepted files
    const cleaned = await cleanupAcceptedWorkspaceDiffFiles(acceptedEntries);
    for (const f of cleaned) {
      results.push(`cleaned: ${f}`);
    }

    const accepted = acceptedEntries.length;
    const strippedSuffix =
      totalStripped > 0
        ? ` (stripped ${formatResultCount(totalStripped, '\\criticize annotation')})`
        : '';
    const unchangedSuffix =
      unchanged > 0
        ? ` (${formatResultCount(unchanged, 'unchanged file')})`
        : '';
    const summary = `Accepted ${accepted}/${changed} changed ${pluralize(changed, 'file')} from run ${runId}${strippedSuffix}${unchangedSuffix}`;
    return {
      status: 'executed',
      summary,
      output: detailedOutput(summary),
      edits,
    };
  }

  /**
   * Resolves a source file by checking run storage first, then workspace.
   * In taskRunStorage mode, files live under StorageFS. In workspace mode,
   * files are written directly to the workspace.
   */
  private async resolveSourceFile(
    runId: RunId,
    runPath: string,
  ): Promise<FileLocation> {
    const entry = await inspectRunStorageEntry(runId, runPath);
    switch (entry.kind) {
      case 'file':
        return entry.location;
      case 'symlink':
        throw new ToolError(
          `Cannot accept ${runPath} from run ${runId}: the run-storage entry is a symlink, meaning this round did not emit the file. Accepting it would propagate snapshot or workspace content rather than agent output.`,
        );
      case 'directory':
      case 'unsupported':
        throw new ToolError(
          `Cannot accept ${runPath} from run ${runId}: the run-storage entry is not a regular file.`,
        );
      case 'invalid':
        throw new ToolError(`Cannot accept ${runPath}: ${entry.reason}`);
      case 'missing':
        break;
    }

    // Fall back to workspace
    const wsLoc = WorkspaceFS.locatePath(runPath);
    if (
      wsLoc.kind !== 'external' &&
      (await WorkspaceFS.exists(wsLoc.relativePath))
    ) {
      return createWorkspaceLocation(wsLoc.absolutePath, wsLoc.relativePath);
    }

    throw new ToolError(
      `File not found in run storage or workspace: ${runPath}. ` +
        `Use executions tool with path /executions/${runId}/files to list available files.`,
    );
  }
}
