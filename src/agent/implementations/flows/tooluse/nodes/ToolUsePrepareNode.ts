import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { buildInitialToolUsePrompts } from '@utils/prompt';

import type { ToolUseServices, ToolUseFlowParams } from '../ToolUseServices';
import type { ToolUseRunShared, PrepareResult } from './types';

type PrepareExecResult =
  | { kind: 'success'; result: PrepareResult }
  | { kind: 'error'; error: Error };

export class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  ToolUseFlowParams,
  ToolUseServices<C>
> {
  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: PrepareResult }> {
    const { userVarChannels, logger, snapshot } = this.services;
    const resolvedToolNames = this.services.resolvedTools.map((t) => t.name);
    const hasDelegationTools = this.services.resolvedTools.some((t) =>
      DELEGATION_TOOLS.has(t.name),
    );
    const promptOptions = {
      resolvedToolNames,
      hasDelegationTools,
      isSubagent: this.services.isSubagent,
      nestedDelegationBlocked: this.services.delegationTrimmed === true,
    };

    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');
      // The persisted system message may reflect stale policy (e.g. the user
      // changed Max delegation depth between sessions). Rebuild the current
      // system text and swap it into the persisted first-message slot that
      // holds the systemPrompt. For providers that pass `system` per-call
      // (Anthropic) this is a no-op: the systemPrompt was never stored in
      // messages to begin with.
      const supportsSystemPrompt =
        this.services.modelHandler.capabilities?.supportsSystemPrompt !== false;
      const messages = await refreshPersistedSystemMessage(
        snapshot.messages,
        () =>
          buildInitialToolUsePrompts(
            this.services.prompt,
            userVarChannels.transient,
            logger,
            promptOptions,
          ),
        supportsSystemPrompt,
      );
      return {
        kind: 'success',
        result: {
          messages,
          runState: snapshot.run,
          workspaceState: AgentWorkspaceState.fromSnapshot(snapshot.workspace),
          userChannels: {
            input: Object.freeze({ ...snapshot.user.input }),
            transient: { ...snapshot.user.transient },
          },
          shouldSkipCycle: true,
        },
      };
    }

    const runState = createRunState();
    const workspaceState = AgentWorkspaceState.create();

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.services.prompt,
        userVarChannels.transient,
        logger,
        promptOptions,
      );

    const systemMessage = systemPrompt
      ? `${systemPrompt}\n${instructionSuffix}`
      : instructionSuffix;
    const messages = await this.services.modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      undefined,
      systemMessage,
    );

    return {
      kind: 'success',
      result: {
        messages,
        runState,
        workspaceState,
        userChannels: userVarChannels,
        shouldSkipCycle: false,
      },
    };
  }

  async execFallback(
    _prepRes: unknown,
    error: Error,
  ): Promise<{ kind: 'error'; error: Error }> {
    return { kind: 'error', error };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: PrepareExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'error') {
      throw execRes.error;
    }

    const {
      messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle,
    } = execRes.result;
    shared.messages = [...messages];
    shared.shouldSkipCycle = shouldSkipCycle;
    shared.stateSlices = {
      runStateSnapshot: runState,
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels,
    };

    // Notify orchestrator that initialization is done and model call is about to start.
    // Without this, long initial prompts produce no progress updates, leaving
    // the orchestrator unaware that the subagent is working.
    this.services.onProgress?.({ kind: 'started' });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Rebuild the persisted system message on resume so it reflects the current
 * policy (e.g. Max delegation depth) rather than whatever was frozen at
 * snapshot time.
 *
 * Two message-shape conventions are handled, keyed on the model's
 * supportsSystemPrompt capability:
 *
 * - `supportsSystemPrompt !== false` (OpenAI Chat/Responses/OpenRouter
 *   with a real system role): the persisted systemPrompt is at
 *   `messages[0]` with role='system'. Later role='system' entries
 *   (the OpenAI supportsIntermDevMsgs developer-message path at
 *   index 1) must NOT be touched — they hold the task userRequest.
 *
 * - `supportsSystemPrompt === false` (o1-mini, o1-preview): the
 *   systemPrompt is the FIRST CONTENT BLOCK of `messages[0]` with
 *   role='user'. We replace only that block's text and leave any
 *   subsequent blocks (userPrefix, userRequest) untouched.
 *
 * Providers that pass `system` per-call (Anthropic) never store the
 * systemPrompt in `messages`, so both branches are a no-op there.
 */
async function refreshPersistedSystemMessage(
  persisted: ProviderMessage[],
  rebuild: () => Promise<{ systemPrompt: string; instructionSuffix: string }>,
  supportsSystemPrompt: boolean,
): Promise<ProviderMessage[]> {
  const first = persisted[0];
  if (!first || typeof first !== 'object') return persisted;

  const role = (first as { role?: unknown }).role;
  const expectedRole = supportsSystemPrompt ? 'system' : 'user';
  if (role !== expectedRole) return persisted;

  const { systemPrompt, instructionSuffix } = await rebuild();
  const systemText = systemPrompt
    ? `${systemPrompt}\n${instructionSuffix}`
    : instructionSuffix;

  const existing = first as Record<string, unknown>;
  const updated = [...persisted];
  updated[0] = (
    supportsSystemPrompt
      ? {
          ...existing,
          content: buildSystemContent(existing.content, systemText),
        }
      : withFirstBlockReplaced(existing, systemText)
  ) as ProviderMessage;
  return updated;
}

/**
 * For system-role messages: replace the whole content. Preserves the
 * existing content shape AND block type (OpenAI Chat uses `'text'`,
 * OpenAI Responses uses `'input_text'`); stamping the wrong type would
 * make the resumed snapshot invalid for Responses providers.
 */
function buildSystemContent(prevContent: unknown, systemText: string): unknown {
  const firstBlockType = readFirstBlockType(prevContent);
  return firstBlockType
    ? [{ type: firstBlockType, text: systemText }]
    : systemText;
}

/**
 * For the o1-style user-role case: replace the text of just the first
 * content block, leaving userPrefix / userRequest blocks alongside it
 * untouched. If the content isn't a shape we recognize (e.g. string
 * content, empty array, non-text first block), leave the message alone.
 */
function withFirstBlockReplaced(
  existing: Record<string, unknown>,
  systemText: string,
): Record<string, unknown> {
  const content = existing.content;
  if (!Array.isArray(content) || content.length === 0) return existing;
  const firstBlock = content[0];
  if (typeof firstBlock !== 'object' || firstBlock === null) return existing;
  const type = (firstBlock as { type?: unknown }).type;
  if (typeof type !== 'string') return existing;
  const newContent = [
    { ...(firstBlock as Record<string, unknown>), text: systemText },
    ...content.slice(1),
  ];
  return { ...existing, content: newContent };
}

function readFirstBlockType(prevContent: unknown): string | null {
  if (!Array.isArray(prevContent) || prevContent.length === 0) return null;
  const first = prevContent[0];
  if (typeof first !== 'object' || first === null) return null;
  const type = (first as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}
