import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { FlowParams } from '@agent/core/flows/BaseFlowServices';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { buildInitialToolUsePrompts } from '@utils/prompt';

import type { ToolUseServices } from '../ToolUseServices';
import type { ToolUseRunShared, CyclePrepResult } from './types';

type PrepareExecResult =
  | { kind: 'success'; result: CyclePrepResult }
  | { kind: 'error'; error: Error };

/**
 * Session-init node: runs **once per tool-use session** to build the initial
 * message array or restore from a persisted snapshot.
 *
 * This is the outer session-level prep. Compare `ToolUseRoundPrepNode` in
 * `core/flows/toolUseRound/`, which is the inner per-LLM-call prep node that
 * runs at the start of every model invocation inside `ToolUseRoundFlow`.
 */
export class ToolUsePrepareNode<C> extends Node<
  ToolUseRunShared,
  FlowParams,
  ToolUseServices<C>
> {
  async exec(
    _prepRes: void,
  ): Promise<{ kind: 'success'; result: CyclePrepResult }> {
    const { userVarChannels, logger, snapshot, config, fileService } =
      this.services;
    const resolvedToolNames = this.services.resolvedTools.map((t) => t.name);
    const hasDelegationTools = hasDelegationTool(resolvedToolNames);
    const promptOptions = {
      resolvedToolNames,
      hasDelegationTools,
      isSubagent: this.services.isSubagent,
    };

    if (snapshot) {
      logger.debug('Resuming tool-use session from saved state.');
      // Rebuild the current system text: for providers that embed it into
      // `messages` (OpenAI, OpenRouter), swap it into the persisted
      // first-message slot. For providers that pass `system` per-call
      // instead (Anthropic, Google), it's returned as `systemPrompt` so the
      // round flow can resupply it on every subsequent model call.
      const supportsSystemPrompt =
        this.services.modelHandler.capabilities?.supportsSystemPrompt !== false;
      const rebuiltPrompts = await buildInitialToolUsePrompts(
        this.services.prompt,
        userVarChannels.transient,
        logger,
        promptOptions,
      );
      const systemMessage = buildSystemText(
        rebuiltPrompts.systemPrompt,
        rebuiltPrompts.instructionSuffix,
      );
      const messages = refreshPersistedSystemMessage(
        snapshot.messages,
        systemMessage,
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
          systemPrompt: systemMessage,
        },
      };
    }

    const runState = AgentRunStateSnapshotSchema.parse({});
    const workspaceState = AgentWorkspaceState.create();

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.services.prompt,
        userVarChannels.transient,
        logger,
        promptOptions,
      );

    const systemMessage = buildSystemText(systemPrompt, instructionSuffix);
    // Attach any media files (CLI `--media`, an image pasted on the first
    // message) to the initial user message via the shared media slot. No-ops
    // when empty or the model lacks vision.
    const mediaFiles = config.mediaFiles.length
      ? config.mediaFiles.map((p) => fileService.createLocation(p))
      : undefined;
    const messages = await this.services.modelHandler.initializeMessages(
      userPrefix,
      userRequest,
      mediaFiles,
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
        systemPrompt: systemMessage,
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
      systemPrompt,
    } = execRes.result;
    shared.messages = [...messages];
    shared.shouldSkipCycle = shouldSkipCycle;
    shared.systemPrompt = systemPrompt;
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
 * Combine the system prompt with the instruction suffix into the single text
 * block used for the system message. Falls back to the suffix alone when there
 * is no system prompt.
 */
function buildSystemText(
  systemPrompt: string,
  instructionSuffix: string,
): string {
  return systemPrompt
    ? `${systemPrompt}\n${instructionSuffix}`
    : instructionSuffix;
}

/**
 * Rebuild the persisted system message on resume so it reflects current
 * workspace/tool state rather than whatever was frozen at snapshot time.
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
 * Providers that pass `system` per-call (Anthropic, Google) never store the
 * systemPrompt in `messages`, so both branches are a no-op there — those
 * providers get the rebuilt text via the returned `systemPrompt` field
 * instead (see caller).
 */
function refreshPersistedSystemMessage(
  persisted: ProviderMessage[],
  systemText: string,
  supportsSystemPrompt: boolean,
): ProviderMessage[] {
  const first = persisted[0];
  if (!first || typeof first !== 'object') return persisted;

  const role = (first as { role?: unknown }).role;
  const expectedRole = supportsSystemPrompt ? 'system' : 'user';
  if (role !== expectedRole) return persisted;

  const existing = first as Record<string, unknown>;
  const updated = [...persisted];

  // For system-role messages: preserve existing content block type (OpenAI Chat
  // uses 'text', OpenAI Responses uses 'input_text') so the resumed snapshot
  // stays valid across providers.
  const prevContent = existing.content;
  let firstBlockType: string | null = null;
  if (Array.isArray(prevContent) && prevContent.length > 0) {
    const firstBlock = prevContent[0];
    if (typeof firstBlock === 'object' && firstBlock !== null) {
      const type = (firstBlock as { type?: unknown }).type;
      if (typeof type === 'string') firstBlockType = type;
    }
  }
  const systemContent = firstBlockType
    ? [{ type: firstBlockType, text: systemText }]
    : systemText;

  updated[0] = (
    supportsSystemPrompt
      ? { ...existing, content: systemContent }
      : withFirstBlockReplaced(existing, systemText)
  ) as ProviderMessage;
  return updated;
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
