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
 *
 * Only the FIRST message is examined: when the persisted prompt exists it
 * always lives at index 0 (see `initializeMessages` across providers).
 * Later role='system' entries — e.g. the OpenAI `supportsIntermDevMsgs`
 * path stores the user request as a developer/system message at index 1 —
 * must not be touched, otherwise resume would overwrite the task with
 * system text.
 */
async function refreshPersistedSystemMessage(
  persisted: ProviderMessage[],
  rebuild: () => Promise<{ systemPrompt: string; instructionSuffix: string }>,
): Promise<ProviderMessage[]> {
  const first = persisted[0];
  if (
    !first ||
    typeof first !== 'object' ||
    (first as { role?: unknown }).role !== 'system'
  ) {
    return persisted;
  }

  const { systemPrompt, instructionSuffix } = await rebuild();
  const systemText = systemPrompt
    ? `${systemPrompt}\n${instructionSuffix}`
    : instructionSuffix;

  const existing = first as Record<string, unknown>;
  // Preserve the existing content shape AND block type: OpenAI Chat uses
  // { type: 'text' }, OpenAI Responses uses { type: 'input_text' }. If we
  // unconditionally stamped 'text', resumed Responses snapshots would be
  // rejected by the API.
  const content = buildSystemContent(existing.content, systemText);
  const updated = [...persisted];
  updated[0] = { ...existing, content } as ProviderMessage;
  return updated;
}

function buildSystemContent(prevContent: unknown, systemText: string): unknown {
  const firstBlockType = readFirstBlockType(prevContent);
  return firstBlockType
    ? [{ type: firstBlockType, text: systemText }]
    : systemText;
}

function readFirstBlockType(prevContent: unknown): string | null {
  if (!Array.isArray(prevContent) || prevContent.length === 0) return null;
  const first = prevContent[0];
  if (typeof first !== 'object' || first === null) return null;
  const type = (first as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}
