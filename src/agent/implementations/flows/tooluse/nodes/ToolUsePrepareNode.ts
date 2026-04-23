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
    const memoryEnabled = this.services.resolvedTools.some(
      (t) => t.name === 'memory',
    );
    const hasDelegationTools = this.services.resolvedTools.some((t) =>
      DELEGATION_TOOLS.has(t.name),
    );
    const promptOptions = {
      memoryEnabled,
      hasDelegationTools,
      isSubagent: this.services.isSubagent,
      nestedDelegationBlocked: this.services.delegationTrimmed === true,
    };

    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');
      // The persisted system message may reflect stale policy (e.g. the user
      // changed Max delegation depth between sessions). Rebuild the current
      // system text and swap it into any role='system' entry in the message
      // list. Providers that pass `system` per-call (Anthropic) don't store
      // it in messages, so this is a no-op there — the tool-use flow for
      // those providers doesn't currently persist the system prompt at all.
      const messages = await refreshPersistedSystemMessage(
        snapshot.messages,
        () =>
          buildInitialToolUsePrompts(
            this.services.prompt,
            userVarChannels.transient,
            logger,
            promptOptions,
          ),
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
 * snapshot time. Only OpenAI-family providers keep system in the messages
 * array; everything else is a no-op on the message list.
 */
async function refreshPersistedSystemMessage(
  persisted: ProviderMessage[],
  rebuild: () => Promise<{ systemPrompt: string; instructionSuffix: string }>,
): Promise<ProviderMessage[]> {
  const systemIdx = persisted.findIndex(
    (m) =>
      typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'system',
  );
  if (systemIdx < 0) return persisted;

  const { systemPrompt, instructionSuffix } = await rebuild();
  const systemText = systemPrompt
    ? `${systemPrompt}\n${instructionSuffix}`
    : instructionSuffix;

  const updated = [...persisted];
  const existing = updated[systemIdx] as Record<string, unknown>;
  const prevContent = existing.content;
  // Preserve the existing content shape: if it was an array of text blocks,
  // keep the array form; otherwise use a plain string. This keeps us
  // compatible across OpenAI / OpenAI Responses / OpenRouter without
  // hard-coding any one shape.
  let content: unknown;
  if (
    Array.isArray(prevContent) &&
    prevContent.length > 0 &&
    typeof prevContent[0] === 'object' &&
    prevContent[0] !== null &&
    'type' in (prevContent[0] as object)
  ) {
    content = [{ type: 'text', text: systemText }];
  } else {
    content = systemText;
  }
  updated[systemIdx] = { ...existing, content } as ProviderMessage;
  return updated;
}
