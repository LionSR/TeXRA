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

import { Effect } from 'effect';

import { getRunRecords } from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ChatExportInput, ExportNode } from '@agent/export/schemas';
import { redactDisplayValue } from '@logger/redaction';
import type { RunId, RunMeta } from '@shared/schemas';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
} from '@transcript';

/**
 * Facts read from the run store, plus the assembled
 * {@link ChatExportInput} when both `config` and a non-empty `conversation`
 * are present. `exportInput` is `null` whenever there is nothing (or not
 * enough) to export; callers distinguish "nothing at all" from "something is
 * missing" using `meta`/`config`/`conversation` themselves.
 */
export interface ChatExportLoadResult {
  readonly meta: RunMeta | null;
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

export const loadChatExportInput = Effect.fn('loadChatExportInput')(function* (
  id: RunId,
  session: SessionHandle,
): Effect.fn.Return<ChatExportLoadResult, Error> {
  const [config, conversationResult, meta] = yield* Effect.all(
    [
      getRunRecords(session, id).readConfig(),
      readCompletedRunConversation(id, session),
      getRunRecords(session, id).readMeta(),
    ],
    { concurrency: 3 },
  );
  const conversation = hasConversationMessages(conversationResult.conversation)
    ? conversationResult.conversation
    : null;
  const hasTranscriptEvidence =
    hasCompletedRunConversationEvidence(conversationResult);

  if (!config || !conversation) {
    return {
      meta,
      config,
      conversation,
      hasTranscriptEvidence,
      exportInput: null,
    };
  }

  return {
    meta,
    config,
    conversation,
    hasTranscriptEvidence,
    exportInput: redactDisplayValue({
      timestamp: meta?.timestamp ?? new Date().toISOString(),
      description: meta?.description,
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
