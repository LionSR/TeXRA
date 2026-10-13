/**
 * What the documents plugin reads of an agent's `task:` block
 * (`DOCUMENT_TASK_BLOCK`, `@texra/shared/plugins/documents`): the task, its
 * `files` template variables, the options every launcher lists with their
 * revision counts, and the `.bib` check its first revision runs. An agent
 * with the block is also launchable as a document task, which its recipe
 * (`documentRecipe.ts`) runs over the persona; nothing outside this plugin
 * reads inside it.
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';
import { agentBlockOf } from '@texra-ai/harness/plugins';
import {
  computeAgentOptionsData,
  getCatalogAgent,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@agent/index';
import { buildTemplatePassthrough } from '@agent/prompt/templateInputs';
import { withLogChannel } from '@logger/effectLog';
import type { FileListEntry, ToolResult } from '@shared/schemas';
import {
  DOCUMENT_TASK_BLOCK,
  type DocumentTask,
} from '@texra/shared/plugins/documents';
import { errorResult } from '@tools/core/result';
import { hasExtension } from '@utils/core/pathCore';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { formatBytes, isNonEmptyString } from '@utils/text/stringUtils';

/** The document task `entry` defines, or null for a chat agent. */
export const documentTaskOf = (
  entry: Pick<AgentEntry, 'blocks'>,
): DocumentTask | null => agentBlockOf(entry, DOCUMENT_TASK_BLOCK) ?? null;

/**
 * The agent options every launcher lists (`computeAgentOptionsData`), each
 * document task carrying its revision count (`rounds`).
 */
export const agentOptionsData = (stores: WorkspaceAgentsStores) =>
  Effect.map(computeAgentOptionsData(stores), (options) =>
    options.map((option) => {
      const entry = getCatalogAgent(option.value);
      const task = entry && documentTaskOf(entry);
      return task ? { ...option, rounds: task.requests.length } : option;
    }),
  );

/**
 * The template variables a task's `files` bind (`X` to `X_FILE` and
 * `X_CONTENT`), read from beside the agent's file at `agentPath`, and the
 * files-loaded card entries of the read. A name that would shadow a fixed
 * variable fails loudly; an unreadable file leaves its pair out and its
 * entry not ok, and is logged.
 */
export const taskFileVars = Effect.fn('documents.taskFileVars')(function* (
  task: DocumentTask,
  agentPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // The fixed variables a task's `files` names must not shadow.
  const fixed = buildTemplatePassthrough();
  const vars: Record<string, string> = {};
  const entries: FileListEntry[] = [];
  for (const [varName, filePath] of Object.entries(task.files)) {
    if (!filePath) continue;
    for (const generated of [`${varName}_FILE`, `${varName}_CONTENT`])
      if (generated in fixed)
        return yield* Effect.fail(
          new Error(
            `task.files name "${varName}" generates "${generated}", which collides with a fixed template variable. Rename the variable.`,
          ),
        );
    // Resolved against the agent's own directory; an absolute path as
    // written.
    const fullPath = path.resolve(path.dirname(agentPath), filePath);
    const content = yield* readNormalizedFile(fs, fullPath).pipe(
      Effect.catch((error) =>
        // The variable is simply absent from the prompt after this, so a
        // mistyped path and a permission error must not read like a real
        // absence.
        Effect.logWarning(
          `Failed to read ${varName} from file ${fullPath}: ${toErrorMessage(error)}`,
        ).pipe(
          withLogChannel('DocumentTask'),
          Effect.annotateLogs({ data: error }),
          Effect.as(null),
        ),
      ),
    );
    if (content !== null) {
      vars[`${varName}_FILE`] = fullPath;
      vars[`${varName}_CONTENT`] = content;
    }
    entries.push({
      path: fullPath,
      ok: content !== null,
      varName,
      source: 'task.files',
    });
  }
  return { vars, entries };
});

/** The largest `.bib` a task attaches whole as context. */
const LARGE_BIB_LIMIT_BYTES = 100 * 1024;

/**
 * Reject a task's context that attaches an oversized bibliography file.
 * `workspaceRoot` is the owning session's workspace folder, handed in as
 * data so a relative path resolves against its own session.
 */
export const rejectOversizedBibAttachments = Effect.fn(
  'rejectOversizedBibAttachments',
)(function* (
  workspaceRoot: string | undefined,
  contextFiles: readonly string[],
): Effect.fn.Return<
  Extract<ToolResult, { status: 'error' }> | null,
  Error,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const bibFiles = contextFiles
    .filter(isNonEmptyString)
    .filter((file) => hasExtension(file, '.bib'));

  for (const bibFile of bibFiles) {
    const absolute = yield* Effect.try({
      try: () => workspaceAbsolutePath(workspaceRoot, bibFile),
      catch: ensureError,
    });
    // `FileSystem.stat` follows a link; a link whose target does not
    // resolve is measured as no file, as a path `readLink` cannot name is
    // no entry at all.
    const stats = yield* fs.stat(absolute).pipe(
      Effect.catch((error) =>
        fs.readLink(absolute).pipe(
          Effect.as(undefined),
          Effect.mapError(() => error),
        ),
      ),
    );
    if (stats === undefined) continue;
    if (Number(stats.size) <= LARGE_BIB_LIMIT_BYTES) continue;

    const sizeBytes = Number(stats.size);
    const message = `${bibFile} is ${sizeBytes} bytes (${formatBytes(sizeBytes)}), over the ${LARGE_BIB_LIMIT_BYTES} byte (${formatBytes(LARGE_BIB_LIMIT_BYTES)}) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
    return errorResult(message, {
      summary: `Rejected oversized BibTeX attachment`,
      diagnostics: {
        type: 'oversized_bib_attachment',
        path: bibFile,
        sizeBytes,
        limitBytes: LARGE_BIB_LIMIT_BYTES,
      },
    });
  }

  return null;
});
