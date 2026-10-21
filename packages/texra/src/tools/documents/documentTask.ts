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
import {
  agentBlockOf,
  errorResult,
  AGENT_TOOL_NAME,
  buildTemplatePassthrough,
} from '@texra-ai/harness/plugins';
import { readNormalizedFile } from '@texra-ai/harness/node';
import {
  withLogChannel,
  hasExtension,
  type ToolResult,
  AgentCatalog,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness';
import {
  toErrorMessage,
  agentKeyOf,
  DEFAULT_WORKFLOW_AGENT,
  type AgentOptionData,
  type FileListEntry,
} from '@texra-ai/harness/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';
import {
  DOCUMENT_TASK_BLOCK,
  type DocumentAgentOption,
  type DocumentTask,
} from '@texra/shared/plugins/documents';

/** The document task `entry` defines, or null for a chat agent. */
export const documentTaskOf = (
  entry: Pick<AgentEntry, 'blocks'>,
): DocumentTask | null => agentBlockOf(entry, DOCUMENT_TASK_BLOCK) ?? null;

/** The agents a launcher lists first, in this order; the rest follow by
 *  name. */
const PREFERRED_AGENTS: readonly string[] = [
  ...PREFERRED_TOOL_USE_AGENTS,
  DEFAULT_WORKFLOW_AGENT,
];
const preferredRank = ({ name }: AgentEntry) => {
  const rank = PREFERRED_AGENTS.indexOf(name);
  return rank < 0 ? PREFERRED_AGENTS.length : rank;
};

/**
 * The agent options every launcher lists: the workspace's visible agents,
 * the preferred ones first, each document task carrying its revision count
 * (`rounds`).
 */
export const agentOptionsData = (stores: WorkspaceAgentsStores) =>
  Effect.map(
    Effect.flatMap(AgentCatalog, (catalog) => catalog.visible(stores)),
    (entries) =>
      entries
        .toSorted(
          (a, b) =>
            preferredRank(a) - preferredRank(b) || a.name.localeCompare(b.name),
        )
        .map((entry): DocumentAgentOption => {
          const option: AgentOptionData = {
            value: agentKeyOf(entry),
            label: entry.name,
            isOrchestrator: entry.tools?.includes(AGENT_TOOL_NAME) === true,
            source: entry.source,
          };
          const task = documentTaskOf(entry);
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
    .filter((file) => file.trim() !== '')
    .filter((file) => hasExtension(file, '.bib'));

  for (const bibFile of bibFiles) {
    // A relative path names a workspace file, which needs a folder open.
    let absolute = bibFile;
    if (!path.isAbsolute(bibFile)) {
      if (!workspaceRoot) {
        return yield* Effect.fail(
          new Error('Workspace path is not available.'),
        );
      }
      absolute = path.join(workspaceRoot, bibFile);
    }
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
    const message = `${bibFile} is ${sizeBytes} bytes, over the ${LARGE_BIB_LIMIT_BYTES} byte limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`;
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
