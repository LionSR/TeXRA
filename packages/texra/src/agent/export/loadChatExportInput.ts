/**
 * Host-neutral loader for a stored run's chat export input.
 *
 * Both the CLI (`texra history show <id> --export`) and the progress-view
 * toolbar export need to read the same run triple (config,
 * conversation, meta) and assemble the same format-agnostic
 * {@link ChatExportInput} the markdown and LaTeX formatters consume (the HTML
 * export path uses `assembleTrace` instead), so the two hosts render a stored
 * conversation identically. This module is the single place that does that
 * read + assemble; each host presents missing data to its own surface (see
 * `readCliHistoryExportInput` in
 * `packages/cli/src/runtime/history.ts` and
 * `writeTranscript` in
 * `packages/texra/src/controllers/progressView/ChatExportController.ts`).
 *
 * The conversation comes from the completed-run archive facade
 * (`readCompletedRunConversation`): the canonical transcript view owns completed-run
 * display and export.
 *
 */

import { DateTime, Effect, Schema } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { ChatExportInput } from '@texra/agent/export/schemas';
import type { Session } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/**
 * A stored run's export input could not be read: the run record read or the
 * completed-run conversation read failed. Both still answer with a bare
 * `Error` squashed from the database read below them, so this is the one tag
 * that names the fact for this module's callers; `cause` is that value
 * unchanged, so a caller's dialog classifies and words what the read
 * produced, exactly as it did when the bare error reached it.
 */
class ChatExportInputUnreadable extends Schema.TaggedError<ChatExportInputUnreadable>()(
  'ChatExportInputUnreadable',
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Whether a stored run can be exported: its {@link ChatExportInput}, or
 *  which part an export needs the run does not hold. */
type ChatExportLoad =
  | { readonly _tag: 'ready'; readonly input: ChatExportInput }
  | { readonly _tag: 'noConfig' }
  | { readonly _tag: 'noConversation' };

function unreadable(cause: unknown): ChatExportInputUnreadable {
  return new ChatExportInputUnreadable({
    message: toErrorMessage(cause),
    cause,
  });
}

export const loadChatExportInput = Effect.fn('loadChatExportInput')(function* (
  id: RunId,
  session: Session,
): Effect.fn.Return<ChatExportLoad, ChatExportInputUnreadable> {
  const records = session.records(id);
  const [config, conversation, view] = yield* Effect.all(
    [records.readConfig, records.readConversation, session.view.read([])],
    { concurrency: 3 },
  ).pipe(Effect.mapError(unreadable));
  if (!config) return { _tag: 'noConfig' };
  if (conversation.length === 0) return { _tag: 'noConversation' };

  const run = view.runs.get(id);
  return {
    _tag: 'ready',
    input: {
      timestamp: run
        ? new Date(run.launchedAt).toISOString()
        : DateTime.formatIso(yield* DateTime.now),
      description: run?.description ?? undefined,
      config,
      nodes: conversation,
    },
  };
});
