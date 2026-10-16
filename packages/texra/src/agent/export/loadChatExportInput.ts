/**
 * Host-neutral loader for a stored run's chat export input.
 *
 * Both the CLI (`texra history show <id> --export`) and the progress-view
 * toolbar export need to read the same run triple (config,
 * conversation, meta) and assemble the same format-agnostic
 * {@link ChatExportInput} the markdown and LaTeX formatters consume (the HTML
 * export path uses `assembleTrace` instead), so the two hosts render a stored
 * conversation identically. This module is the single place that does that
 * read + assemble; each host wraps it with its own status vocabulary (see
 * `readCliHistoryExportInput` in
 * `packages/cli/src/runtime/history.ts` and
 * `ChatExportController.buildExportInput` in
 * `packages/texra/src/controllers/progressView/ChatExportController.ts`).
 *
 * The conversation comes from the completed-run archive facade
 * (`readCompletedRunConversation`): the canonical transcript fold owns completed-run
 * display/export per #7246 Decision 1.
 *
 */

import { Data, DateTime, Effect } from 'effect';

import type { ChatExportInput, ExportNode } from '@agent/export/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { LocalSession } from '@texra-ai/harness';
import type { RunView } from '@texra-ai/harness';
import type { RunId, AgentConfig } from '@texra-ai/harness/schemas';

/**
 * A stored run's export input could not be read: the run record read or the
 * completed-run conversation read failed. Both still answer with a bare
 * `Error` squashed from the database read below them, so this is the one tag
 * that names the fact for this module's callers; `cause` is that value
 * unchanged, so a caller's dialog classifies and words what the read
 * produced, exactly as it did when the bare error reached it.
 */
export class ChatExportInputUnreadable extends Data.TaggedError(
  'ChatExportInputUnreadable',
)<{
  readonly part: 'config' | 'conversation';
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Facts read from the run store and the session's fold, plus the assembled
 * {@link ChatExportInput} when both `config` and a non-empty `conversation`
 * are present. `exportInput` is `null` whenever there is nothing (or not
 * enough) to export; callers distinguish "nothing at all" from "something is
 * missing" using `run`/`config`/`conversation` themselves.
 */
export interface ChatExportLoadResult {
  readonly run: RunView | null;
  readonly config: AgentConfig | null;
  /** Empty when the run holds no conversation. */
  readonly conversation: readonly ExportNode[];
  readonly exportInput: ChatExportInput | null;
}

function unreadable(
  part: 'config' | 'conversation',
  cause: unknown,
): ChatExportInputUnreadable {
  return new ChatExportInputUnreadable({
    part,
    message: toErrorMessage(cause),
    cause,
  });
}

export const loadChatExportInput = Effect.fn('loadChatExportInput')(function* (
  id: RunId,
  session: LocalSession,
): Effect.fn.Return<ChatExportLoadResult, ChatExportInputUnreadable> {
  const records = session.records(id);
  const [config, conversation, view] = yield* Effect.all(
    [
      records
        .readConfig()
        .pipe(Effect.mapError((cause) => unreadable('config', cause))),
      records
        .readConversation()
        .pipe(Effect.mapError((cause) => unreadable('conversation', cause))),
      session.view.read([]),
    ],
    { concurrency: 3 },
  );
  const run = view.runs.get(id) ?? null;

  if (!config || conversation.length === 0) {
    return { run, config, conversation, exportInput: null };
  }

  return {
    run,
    config,
    conversation,
    exportInput: {
      timestamp: run
        ? new Date(run.launchedAt).toISOString()
        : DateTime.formatIso(yield* DateTime.now),
      description: run?.description ?? undefined,
      config: {
        agent: config.agent,
        model: config.model,
        instruction: config.instruction,
        inputFiles: config.inputFiles,
        mediaFiles: config.mediaFiles,
        contextFiles: config.contextFiles,
        outputFiles: config.outputFiles,
      },
      nodes: conversation,
    },
  };
});
