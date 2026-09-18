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
 * `src/controllers/progressView/ChatExportController.ts`).
 *
 * The conversation comes from the completed-run archive facade
 * (`readCompletedRunConversation`): the canonical transcript fold owns completed-run
 * display/export per #7246 Decision 1.
 *
 */

import { Data, Effect } from 'effect';

import { getRunRecords } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ChatExportInput, ExportNode } from '@agent/export/schemas';
import { redactDisplayValue } from '@logger/redaction';
import type { RunId } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
} from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  /** Normalized: `null` when absent *or* empty — an empty array never counts
   *  as "a conversation is present" (see module doc). */
  readonly conversation: readonly ExportNode[] | null;
  /** Host-neutral storage evidence used to distinguish incomplete from absent. */
  readonly hasTranscriptEvidence: boolean;
  readonly exportInput: ChatExportInput | null;
}

/**
 * A stored conversation is only "present" when it has at least one message.
 * The archive facade already normalizes an empty read to `null`, so this
 * check is defensive rather than the primary fix — but it keeps the
 * "non-empty array only" contract explicit for this module's callers (and
 * for tests, which mock the facade directly and can return `[]` without
 * going through that normalization). Without it, a plain truthiness check
 * (`!conversation`) would treat `[]` as "present" — `![]` is `false` in JS —
 * and every existence check downstream (this module's `exportInput`, and
 * each host's own not-found/incomplete classification) would disagree with
 * `readCliHistoryDetails`, which builds no preview from an empty array
 * either.
 */
function hasConversationMessages(
  conversation: readonly ExportNode[] | null,
): conversation is readonly ExportNode[] {
  return Array.isArray(conversation) && conversation.length > 0;
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
  session: SessionHandle,
): Effect.fn.Return<ChatExportLoadResult, ChatExportInputUnreadable> {
  const [config, conversationResult, view] = yield* Effect.all(
    [
      getRunRecords(session, id)
        .readConfig()
        .pipe(Effect.mapError((cause) => unreadable('config', cause))),
      readCompletedRunConversation(id, session).pipe(
        Effect.mapError((cause) => unreadable('conversation', cause)),
      ),
      session.readView([]),
    ],
    { concurrency: 3 },
  );
  const run = view.runs.get(id) ?? null;
  const conversation = hasConversationMessages(conversationResult.conversation)
    ? conversationResult.conversation
    : null;
  const hasTranscriptEvidence =
    hasCompletedRunConversationEvidence(conversationResult);

  if (!config || !conversation) {
    return {
      run,
      config,
      conversation,
      hasTranscriptEvidence,
      exportInput: null,
    };
  }

  return {
    run,
    config,
    conversation,
    hasTranscriptEvidence,
    exportInput: redactDisplayValue({
      timestamp: run
        ? new Date(run.launchedAt).toISOString()
        : new Date().toISOString(),
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
    }),
  };
});
