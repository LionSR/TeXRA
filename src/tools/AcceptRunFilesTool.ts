/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files live in run storage
 * (executions/{runId}/). This tool copies those files into the workspace
 * — the programmatic equivalent of the "Accept" button in the progress view.
 *
 * Each file goes through the standard tool edit approval flow (same diff
 * panel as write_file), so the user can review, edit, or reject each file.
 */

// Third-party imports
import { z } from 'zod';
import { Effect, FileSystem } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import type { ToolServices } from '@agent/runtime/ToolServices';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { emitAppSignal } from '@eventBus/AppSignals';
import { cleanupAcceptedWorkspaceDiffFiles } from '@latex/acceptedFileTarget';
import { WorkspaceFs } from '@platform/rootedFs';
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
import { requireToolRun } from '@tools/core/toolRun';
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { locateInWorkspace } from '@utils/files/workspaceFS';
import { entryExists, absentReason } from '@utils/files/fsEntryExists';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { formatResultCount, pluralize } from '@utils/text/stringUtils';
import {
  findExistingRunStoragePathUnder,
  originalSnapshotPathUnder,
  inspectRunStorageEntryUnder,
} from '@utils/files/runStorageFs';
import { ensureError } from '@utils/errors/errorMessage';

/**
 * Whether `target` is a file, following links: a symlink to a file is a
 * file, a dangling or circular link is not. `fs.stat` follows, so a symlink
 * to a file answers `File`, a dangling target is `NotFound`/`ENOTDIR`, and a
 * circular link raises `ELOOP` (`BadResource`) — those absences match
 * `statIfExists`, and any other failure still propagates.
 */
const fileAt = (fs: FileSystem.FileSystem, target: string) =>
  fs.stat(target).pipe(
    Effect.map((stats) => stats.type === 'File'),
    Effect.catchIf(
      (error) =>
        absentReason(error) ||
        (error.reason._tag === 'BadResource' &&
          (error.reason.cause as { code?: string } | undefined)?.code ===
            'ELOOP'),
      () => Effect.succeed(false),
    ),
  );

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

type AcceptRunFilesInput = z.infer<typeof AcceptRunFilesInputSchema>;

// ============================================================================
// Tool Implementation
// ============================================================================

function executeAcceptRunFilesTool(
  input: AcceptRunFilesInput,
): Effect.Effect<ToolResult, Error, ToolServices> {
  return Effect.gen(function* () {
    const call = yield* ToolCall;
    const { session } = yield* requireToolRun('accept_run_files', call);
    const directory = yield* findExistingRunStoragePathUnder(
      call.roots.storage,
      input.execution_id,
    );
    if (
      directory === undefined &&
      !(yield* getRunRecords(session, input.execution_id).exists())
    ) {
      return yield* Effect.fail(
        new ToolError(
          `Run not found: ${input.execution_id}. Use the executions tool with path /executions to list available runs.`,
        ),
      );
    }
    return yield* acceptFiles(input, call);
  });
}

const acceptFiles = Effect.fn('AcceptRunFilesTool.acceptFiles')(function* (
  input: AcceptRunFilesInput,
  call: ToolCallShape,
): Effect.fn.Return<
  ToolResult,
  Error,
  ToolCall | FileSystem.FileSystem | WorkspaceFs
> {
  const { execution_id: runId, files, strip_criticize } = input;

  // Phase 1: Validate all source paths and read content before any approvals
  const prepared = yield* Effect.forEach(
    files,
    (mapping) =>
      Effect.gen(function* () {
        assertNoParentTraversal(mapping.path);

        const sourceLocation = yield* resolveSourceFile(
          runId,
          mapping.path,
          call,
        );

        const destPath = mapping.original ?? mapping.path;
        // The call's own workspace root, as data: the source may resolve
        // under any root, but the destination is this session's.
        const dest = locateInWorkspace(call.roots.workspace, destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `original must be inside the workspace: ${destPath}`,
          );
        }
        const workspaceFs: FileSystem.FileSystem = yield* WorkspaceFs;
        const processFs = yield* FileSystem.FileSystem;

        const rawContent = yield* readNormalizedFile(
          processFs,
          sourceLocation.absolutePath,
        ).pipe(Effect.mapError(ensureError));
        const { content: proposedContent, count: strippedCount } =
          strip_criticize
            ? stripCriticizeAnnotations(rawContent)
            : { content: rawContent, count: 0 };
        const destExists = yield* entryExists(
          workspaceFs,
          dest.relativePath,
        ).pipe(Effect.mapError(ensureError));

        // Determine original content for diff display. In-place workflow
        // outputs can make source and destination the same workspace file, so
        // the pre-run snapshot is the only reliable "before" image.
        const snapshotPath = originalSnapshotPathUnder(
          call.roots.storage,
          runId,
          dest.relativePath,
        );
        const snapshotExists = yield* fileAt(processFs, snapshotPath).pipe(
          Effect.mapError(ensureError),
        );
        const snapshotContent = snapshotExists
          ? yield* readNormalizedFile(processFs, snapshotPath).pipe(
              Effect.mapError(ensureError),
            )
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
          originalContent = yield* readNormalizedFile(
            workspaceFs,
            dest.relativePath,
          ).pipe(Effect.mapError(ensureError));
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
    { concurrency: 'unbounded' },
  );

  // Phase 2: Request approval and write each file
  const results: string[] = [];
  const edits: EditRecord[] = [];
  const acceptedEntries: {
    outputPath: string;
    originalPath: string;
    destAbsolutePath: string;
  }[] = [];
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

    const approval = yield* requestToolEditApproval({
      path: entry.original,
      originalContent: entry.originalContent,
      proposedContent: entry.proposedContent,
      sourceTool: 'accept_run_files',
    });

    if (approval.action !== 'apply') {
      rejections.push({ path: entry.original, refusal: approval });
      results.push(`rejected: ${entry.original}${mappingNote}`);
      continue;
    }

    yield* writeApprovedContent(
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
    emitAppSignal('workspaceFilesWritten', {
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
  if (rejections.length === changed && acceptedEntries.length === 0) {
    const { path, refusal } = summarizeRefusals(rejections);
    return buildApprovalRejectedResult(path, 'accept_run_files', refusal);
  }

  // Phase 3: Clean up diff files from workspace for accepted files
  const cleaned = yield* cleanupAcceptedWorkspaceDiffFiles(
    call.roots.workspace,
    acceptedEntries,
  );
  for (const f of cleaned) {
    results.push(`cleaned: ${f}`);
  }

  const accepted = acceptedEntries.length;
  const strippedSuffix =
    totalStripped > 0
      ? ` (stripped ${formatResultCount(totalStripped, '\\criticize annotation')})`
      : '';
  const unchangedSuffix =
    unchanged > 0 ? ` (${formatResultCount(unchanged, 'unchanged file')})` : '';
  const summary = `Accepted ${accepted}/${changed} changed ${pluralize(changed, 'file')} from run ${runId}${strippedSuffix}${unchangedSuffix}`;
  return {
    status: 'executed',
    summary,
    output: detailedOutput(summary),
    edits,
  };
});

/**
 * Resolves a source file by checking run storage first, then workspace.
 * In run-storage mode, files live under the call's storage root. In
 * workspace mode, files are written directly to the workspace.
 */
const resolveSourceFile = Effect.fn('AcceptRunFilesTool.resolveSourceFile')(
  function* (
    runId: RunId,
    runPath: string,
    call: ToolCallShape,
  ): Effect.fn.Return<
    FileLocation,
    Error,
    FileSystem.FileSystem | WorkspaceFs
  > {
    const entry = yield* inspectRunStorageEntryUnder(
      call.roots.storage,
      runId,
      runPath,
    );
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
    const workspaceFs = yield* WorkspaceFs;
    const wsLoc = locateInWorkspace(call.roots.workspace, runPath);
    if (
      wsLoc.kind !== 'external' &&
      (yield* entryExists(workspaceFs, wsLoc.relativePath).pipe(
        Effect.mapError(ensureError),
      ))
    ) {
      return createWorkspaceLocation(wsLoc.absolutePath, wsLoc.relativePath);
    }

    throw new ToolError(
      `File not found in run storage or workspace: ${runPath}. ` +
        `Use executions tool with path /executions/${runId}/files to list available files.`,
    );
  },
);

export const AcceptRunFilesTool = defineTool({
  name: 'accept_run_files',
  requiresApproval: true,
  description: `Accept output files from a completed workflow run into the workspace.

Only workflow subagent results (category="workflow") have output files to
accept; tool-use subagents return text and have nothing for this tool.

Locates output files in run storage and writes them to the workspace.
Each file goes through an approval step before writing and may be rejected.

Parameters map directly to subagent-result delivery attributes:
  execution_id ← <subagent-result id="...">
  path         ← <file path="...">
  original     ← <file original="...">`,
  schema: AcceptRunFilesInputSchema,
  execute: executeAcceptRunFilesTool,
});
