/**
 * Tool for accepting output files from a completed run into the workspace.
 *
 * After a workflow agent completes, its output files live in task-run storage
 * (executions/{executionId}/). This tool copies those files into the workspace
 * — the programmatic equivalent of the "Accept" button in the progress view.
 *
 * Each file goes through the standard tool edit approval flow (same diff
 * panel as write_file), so the user can review, edit, or reject each file.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import { getExecutionStore } from '@agent/storage';
import { appSignals } from '@eventBus/AppSignals';
import { diffFileLocation } from '@latex/acceptedFileTarget';
import { stripCriticizeAnnotations } from '@replacement/advanced';
import { ExecutionIdSchema } from '@shared/schemas';
import type { ExecutionId, FileLocation } from '@shared/schemas';
import {
  ToolError,
  type EditRecord,
  type ToolResult,
} from '@shared/schemas/toolResult';
import { assertNoParentTraversal } from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
  getApprovedContent,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import {
  AbsoluteFS,
  WorkspaceFS,
  FlexibleFS,
  createWorkspaceLocation,
} from '@utils/files';
import { filterNotNull } from '@utils/core';
import { formatResultCount, pluralize } from '@utils/text/stringUtils';
import {
  findExistingRunStoragePath,
  getOriginalSnapshotPath,
  inspectRunStorageEntry,
} from '@utils/files/taskRunStorage';

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
  /** Execution ID (matches `id` attribute in subagent-result XML). */
  execution_id: ExecutionIdSchema.describe(
    'Execution ID (matches id attribute in subagent-result delivery)',
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

Use this tool ONLY for workflow subagent results (category="workflow").
Do NOT use it for tool-use subagent results — those produce text responses,
not output files.

Locates output files in task-run storage and writes them to the workspace.
Each file goes through an approval step before writing and may be rejected.

Parameters map directly to subagent-result delivery attributes:
  execution_id ← <subagent-result id="...">
  path         ← <file path="...">
  original     ← <file original="...">

Example — given delivery:
  <subagent-result id="a1b2c3d4" agent="correct" category="workflow" status="completed">
    <file path="paper__correct__r0_gemini.tex" original="paper.tex" added="42" removed="15" />
  </subagent-result>

Call:
  execution_id: "a1b2c3d4"
  files: [{path: "paper__correct__r0_gemini.tex", original: "paper.tex"}]

Optional:
  strip_criticize  when true, remove all \\criticize{...}{...}{...} annotations from accepted files before the approval diff`,
  schema: AcceptRunFilesInputSchema,
}) {
  protected async execute(input: AcceptRunFilesInput): Promise<ToolResult> {
    const { execution_id: executionId, files, strip_criticize } = input;

    const runDir = await findExistingRunStoragePath(executionId);
    const runDirExists = runDir !== undefined;

    // Verify execution exists — run dir may not exist in workspace storage mode
    if (!runDirExists) {
      const exists = await getExecutionStore(executionId as ExecutionId).exists(
        'meta',
      );
      if (!exists) {
        throw new ToolError(
          `Run not found: ${executionId}. Use /executions to list available executions.`,
        );
      }
    }

    // Phase 1: Validate all source paths and read content before any approvals
    const prepared = await Promise.all(
      files.map(async (mapping) => {
        assertNoParentTraversal(mapping.path);

        const { sourceAbsolute, sourceLocation } = await this.resolveSourceFile(
          executionId,
          mapping.path,
        );

        const destPath = mapping.original ?? mapping.path;
        const dest = WorkspaceFS.locatePath(destPath);
        if (dest.kind === 'external') {
          throw new ToolError(
            `original must be inside the workspace: ${destPath}`,
          );
        }

        const rawContent = await FlexibleFS.read(sourceLocation);
        const { content: proposedContent, count: strippedCount } =
          strip_criticize
            ? stripCriticizeAnnotations(rawContent)
            : { content: rawContent, count: 0 };
        const destExists = await WorkspaceFS.exists(dest.relativePath);

        // Determine original content for diff display. In-place workflow
        // outputs can make source and destination the same workspace file, so
        // the pre-run snapshot is the only reliable "before" image.
        const snapshotPath = getOriginalSnapshotPath(
          executionId,
          dest.relativePath,
        );
        const snapshotContent = (await AbsoluteFS.isFile(snapshotPath))
          ? await AbsoluteFS.read(snapshotPath)
          : undefined;
        const isSameFile =
          sourceLocation.kind === 'workspace' &&
          sourceAbsolute === dest.absolutePath;
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
    let firstRejectedPath: string | undefined;
    const rejectionMessages: string[] = [];

    let totalStripped = 0;

    for (const entry of prepared) {
      const mappingNote =
        entry.path !== entry.original ? ` (from ${entry.path})` : '';

      if (entry.originalContent === entry.proposedContent) {
        unchanged++;
        results.push(`unchanged: ${entry.original}${mappingNote}`);
        continue;
      }

      const approval = await requestToolEditApproval({
        path: entry.original,
        originalContent: entry.originalContent,
        proposedContent: entry.proposedContent,
        sourceTool: 'accept_run_files',
      });

      if (!approval.accepted) {
        rejected++;
        firstRejectedPath ??= entry.original;
        if (approval.userMessage) rejectionMessages.push(approval.userMessage);
        results.push(`rejected: ${entry.original}${mappingNote}`);
        continue;
      }

      const finalContent = getApprovedContent(approval, entry.proposedContent);
      await writeApprovedContent(
        entry.original,
        entry.originalContent,
        finalContent,
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

    if (changed === 0) {
      const summary = `No changes to accept from run ${executionId}`;
      return {
        status: 'executed',
        summary,
        output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
        edits,
      };
    }

    // All changed files rejected → return rejection result
    if (rejected === changed && acceptedEntries.length === 0) {
      return buildApprovalRejectedResult(
        firstRejectedPath ?? prepared[0].original,
        'accept_run_files',
        rejectionMessages.join('\n'),
      );
    }

    // Phase 3: Clean up diff files from workspace for accepted files
    const cleaned = await this.cleanupDiffFiles(acceptedEntries);
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
    const summary = `Accepted ${accepted}/${changed} changed ${pluralize(changed, 'file')} from run ${executionId}${strippedSuffix}${unchangedSuffix}`;
    return {
      status: 'executed',
      summary,
      output: `${summary}:\n${results.map((r) => `  - ${r}`).join('\n')}`,
      edits,
    };
  }

  /**
   * Resolves a source file by checking run storage first, then workspace.
   * In taskRunStorage mode, files live under StorageFS. In workspace mode,
   * files are written directly to the workspace.
   */
  private async resolveSourceFile(
    executionId: ExecutionId,
    runPath: string,
  ): Promise<{ sourceAbsolute: string; sourceLocation: FileLocation }> {
    const entry = await inspectRunStorageEntry(executionId, runPath);
    switch (entry.kind) {
      case 'file':
        return {
          sourceAbsolute: entry.location.absolutePath,
          sourceLocation: entry.location,
        };
      case 'symlink':
        throw new ToolError(
          `Cannot accept ${runPath} from run ${executionId}: the run-storage entry is a symlink, meaning this round did not emit the file. Accepting it would propagate snapshot or workspace content rather than agent output.`,
        );
      case 'directory':
      case 'unsupported':
        throw new ToolError(
          `Cannot accept ${runPath} from run ${executionId}: the run-storage entry is not a regular file.`,
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
      return {
        sourceAbsolute: wsLoc.absolutePath,
        sourceLocation: createWorkspaceLocation(
          wsLoc.absolutePath,
          wsLoc.relativePath,
        ),
      };
    }

    throw new ToolError(
      `File not found in run storage or workspace: ${runPath}. ` +
        `Use executions tool with path /executions/${executionId}/files to list available files.`,
    );
  }

  /**
   * Remove diff files from the workspace that correspond to accepted output
   * files, using the same diff-naming convention as the manual "Accept" flow
   * (see {@link diffFileLocation}) so both paths stay in sync.
   */
  private async cleanupDiffFiles(
    entries: { outputPath: string; originalPath: string }[],
  ): Promise<string[]> {
    const results = await Promise.all(
      entries.map(async ({ outputPath, originalPath }) => {
        const originalLocation = WorkspaceFS.locatePath(originalPath);
        if (originalLocation.kind === 'external') return null;

        // diffFileLocation's return type is the full FileLocation union
        // (siblingLocation isn't generic over the input's kind), so this
        // narrows for relativePath access below even though, given a
        // 'workspace' input, it can only ever resolve to 'workspace'.
        const loc = diffFileLocation(originalLocation, outputPath);
        if (loc.kind === 'external') return null;

        // Never delete the file we just accepted into — possible when
        // originalPath's own name already matches the generated diff-name
        // pattern for outputPath (see cleanupStaleDiffFile's docstring).
        if (loc.absolutePath === originalLocation.absolutePath) return null;

        try {
          await WorkspaceFS.delete(loc.relativePath);
          return loc.relativePath;
        } catch {
          // Non-fatal: file may not exist or may be locked
          return null;
        }
      }),
    );

    return results.filter(filterNotNull);
  }
}
