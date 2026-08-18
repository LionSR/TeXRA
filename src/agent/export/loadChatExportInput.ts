/**
 * Host-neutral loader for a stored execution's chat export input.
 *
 * Both the CLI (`texra history show <id> --export`) and the progress-view
 * toolbar export need to read the same execution triple (config,
 * conversation, meta) and assemble the same format-agnostic
 * {@link ChatExportInput} the html/markdown/LaTeX formatters consume, so the
 * two hosts render a stored conversation identically. This module is the
 * single place that does that read + assemble; each host wraps it with its
 * own status vocabulary (see `readCliHistoryExportInput` in
 * `packages/cli/src/runtime/history.ts` and
 * `ChatExportController.buildExportInput` in
 * `src/controllers/progressView/ChatExportController.ts`).
 *
 * The conversation comes from the completed-run archive facade
 * (`readCompletedRunConversation`): the transcript sidecar owns completed-run
 * display/export per #7246 Decision 1.
 *
 * `store.readConfig()` already validates against `AgentConfigSchema`
 * internally and falls back to `null` on a schema mismatch (see the private
 * `readValidated` helper on `StorageFSKVStore` in `ExecutionKVStore.ts`), so
 * `config` here is never a raw, unvalidated value — no redundant re-parse
 * (and no risk of it throwing on a corrupt record) is needed.
 */

import { getExecutionStore } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ChatExportInput } from '@agent/export/schemas';
import type { ExecutionId, ExecutionMeta } from '@shared/schemas';
import {
  hasCompletedRunConversationEvidence,
  readCompletedRunConversation,
} from '@transcript';

/**
 * Facts read from the execution store, plus the assembled
 * {@link ChatExportInput} when both `config` and a non-empty `conversation`
 * are present. `exportInput` is `null` whenever there is nothing (or not
 * enough) to export; callers distinguish "nothing at all" from "something is
 * missing" using `meta`/`config`/`conversation` themselves.
 */
export interface ChatExportLoadResult {
  readonly meta: ExecutionMeta | null;
  readonly config: AgentConfig | null;
  /** Normalized: `null` when absent *or* empty — an empty array never counts
   *  as "a conversation is present" (see module doc). */
  readonly conversation: readonly unknown[] | null;
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
  conversation: readonly unknown[] | null,
): conversation is readonly unknown[] {
  return Array.isArray(conversation) && conversation.length > 0;
}

export async function loadChatExportInput(
  id: ExecutionId,
): Promise<ChatExportLoadResult> {
  const store = getExecutionStore(id);
  const [config, conversationResult, meta] = await Promise.all([
    store.readConfig(),
    readCompletedRunConversation(id),
    store.readMeta(),
  ]);
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
    exportInput: {
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
      messages: conversation,
    },
  };
}
