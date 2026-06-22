import type { AgentTrace } from '@agent/trace';
import type { AgentSetting } from '@agent/core/definition/AgentDataclass';
import { hasEndTag } from '@agent/core/definition/AgentDataclass';
import type { AgentWorkspaceState } from '@agent/core/execution/AgentWorkspaceState';
import type { FileLocation } from '@shared/schemas';
import { flexibleFS } from '@utils/files';

import { prepareExistingOutputContent } from '../utils/fileContentUtils';
import type { ProviderMessage } from '../types/ProviderMessage';

/**
 * Provider-specific message operations needed by the OpenAI-compatible prefill
 * flow. Each operation differs only in the concrete provider message shape
 * (e.g. array-content vs string-content, SDK-specific casts); the control flow,
 * pseudo-prefill instruction, end-tag handling, and resume write-back below are
 * identical across the Chat Completions-style handlers, so they live here.
 */
export interface OpenAiCompatiblePrefillAdapter<M extends ProviderMessage> {
  readonly logger: AgentTrace;
  /** Append the pseudo-prefill instruction to the last (user) message in place. */
  appendPseudoPrefill(messages: M[], pseudoPrefillMsg: string): void;
  /** Push an assistant message carrying the given text as array content. */
  pushAssistantText(messages: M[], text: string): void;
  /** Append a continuation prompt for models without assistant prefill support. */
  addContinue(
    messages: M[],
    workspaceState: AgentWorkspaceState,
    agentSetting: AgentSetting,
  ): void;
}

/**
 * Shared `initializeOutputAndPrefill` body for Chat Completions-style handlers
 * (OpenAI native, OpenRouter native). Sets up the output file and prefills the
 * conversation, returning `[isComplete, messages]`.
 *
 * The three provider message shapes that differ between handlers are injected
 * via {@link OpenAiCompatiblePrefillAdapter}; everything else (existence check,
 * the pseudo-prefill instruction text, end-tag short-circuit, and the resume
 * write-back) is provider-agnostic.
 */
export async function initializeOpenAiCompatibleOutputAndPrefill<
  M extends ProviderMessage,
>(
  adapter: OpenAiCompatiblePrefillAdapter<M>,
  agentSetting: AgentSetting,
  messages: M[],
  workspaceState: AgentWorkspaceState,
  outputLocation: FileLocation,
  prefill: string,
): Promise<[boolean, M[]]> {
  if (!(await flexibleFS.existsAndNonTrivial(outputLocation))) {
    if (prefill.length === 0) {
      adapter.logger.debug(
        'No prefill provided; skipping pseudo-prefill instruction',
      );
      return [false, messages];
    }
    const pseudoPrefillMsg = `Organize your response with xml tags. Start your response with:\n${prefill}`;
    adapter.appendPseudoPrefill(messages, pseudoPrefillMsg);
    adapter.logger.debug(`Added pseudo prefill: "${pseudoPrefillMsg}"`);
    return [false, messages];
  }

  // Prepare existing file content (read, clean, extract scratchpad, update state)
  const { fileContent } = await prepareExistingOutputContent(
    outputLocation,
    workspaceState,
    adapter.logger,
  );

  adapter.pushAssistantText(messages, fileContent);

  if (hasEndTag(agentSetting, fileContent)) {
    adapter.logger.debug(
      'End tag detected - skipping model call (response already added above)',
    );
    return [true, messages];
  }

  adapter.logger.warn(
    'Output file exists but no end tag found - continuing from file',
  );
  // Only need to handle case where prefill needs to be prepended
  // (workspace state was already updated above with file content)
  if (!fileContent.includes(prefill)) {
    workspaceState.assembly.accumulatedOutput = prefill + fileContent;
    await flexibleFS.write(
      outputLocation,
      workspaceState.assembly.accumulatedOutput,
    );
  }
  adapter.addContinue(messages, workspaceState, agentSetting);

  return [false, messages];
}
