import { Node } from '@agent/node';
import { logUserMessage } from '@agent/trace';
import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { USER_VAR_MODEL } from '@agent/utils/userVars';
import { hasDelegationTool } from '@shared/constants/delegationTools';

import type { ToolUseServices } from '../ToolUseServices';
import type { ToolUseRunShared, CyclePrepResult } from './types';

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
  ToolUseServices<C>
> {
  async exec(_prepRes: void): Promise<CyclePrepResult> {
    const {
      userVarChannels,
      logger,
      resumeShared,
      config,
      fileService,
      setting,
    } = this.services;
    const resolvedToolNames = setting.tools.map((tool) => tool.name);
    const hasDelegationTools = hasDelegationTool(resolvedToolNames);
    const promptOptions = {
      resolvedToolNames,
      hasDelegationTools,
      isSubagent: this.services.isSubagent,
    };
    // `MODEL` comes from the run's ModelCell rather than the launch snapshot
    // baked into the channel, so a resume that rebuilds this prompt states the
    // model the run is actually on.
    const promptVars = {
      ...userVarChannels.transient,
      [USER_VAR_MODEL]: this.services.modelCell.modelId,
    };

    if (resumeShared) {
      logger.debug('Resuming tool-use session from saved state.');
      // The persisted messages are used verbatim -- including `messages[0]`
      // for providers that embed the system prompt into `messages` (OpenAI,
      // OpenRouter). Rewriting that text on every resume to reflect current
      // workspace/tool state would change the leading bytes of the request
      // and invalidate the provider's prefix-based prompt cache; per
      // maintainer ruling, staleness is preferable to that cache miss. A
      // system-prompt edit made between suspend and resume therefore does
      // not propagate into an already-suspended run.
      //
      // `systemPrompt` below is still rebuilt fresh: for providers that pass
      // `system` per-call instead of storing it in `messages` (Anthropic,
      // Google), it isn't part of the cached prefix at all -- the round flow
      // resupplies it on every model call regardless of resume, so rebuilding
      // it here is orthogonal to the caching concern above.
      const rebuiltPrompts = await buildInitialToolUsePrompts(
        this.services.prompt,
        promptVars,
        logger,
        promptOptions,
      );
      const systemMessage = buildSystemText(
        rebuiltPrompts.systemPrompt,
        rebuiltPrompts.instructionSuffix,
      );
      const workspaceState = AgentWorkspaceState.fromSnapshot(
        resumeShared.stateSlices.workspaceSnapshot,
      );
      return {
        messages: resumeShared.messages,
        runState: resumeShared.stateSlices.runStateSnapshot,
        workspaceState,
        cycleStartLastResponse: workspaceState.assembly.lastResponse,
        userChannels: {
          input: Object.freeze({
            ...resumeShared.stateSlices.userChannels.input,
          }),
          transient: {
            ...resumeShared.stateSlices.userChannels.transient,
          },
        },
        shouldSkipCycle: true,
        systemPrompt: systemMessage,
      };
    }

    const runState = AgentRunStateSnapshotSchema.parse({});
    const workspaceState = AgentWorkspaceState.create();

    const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
      await buildInitialToolUsePrompts(
        this.services.prompt,
        promptVars,
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
    // The transcript's opening row must be logged whether initializeMessages
    // succeeds or throws (e.g. a corrupt/oversized media file) -- otherwise a
    // failed first turn leaves no record of what the user asked for. `finally`
    // preserves the throw so the run still fails as before; a throw before any
    // attachment was inserted just yields an empty attachments list, which is
    // accurate (nothing was actually inserted).
    let messages: ProviderMessage[];
    try {
      messages = await this.services.modelCell.handler.initializeMessages(
        userPrefix,
        userRequest,
        mediaFiles,
        systemMessage,
      );
    } finally {
      if (this.services.initialUserMessageForTranscript) {
        logUserMessage(
          logger,
          this.services.initialUserMessageForTranscript,
          this.services.modelCell.handler.consumeInsertedAttachmentKinds(
            'initial',
          ),
        );
      }
    }

    return {
      messages,
      runState,
      workspaceState,
      cycleStartLastResponse: workspaceState.assembly.lastResponse,
      userChannels: userVarChannels,
      shouldSkipCycle: false,
      systemPrompt: systemMessage,
    };
  }

  async post(
    shared: ToolUseRunShared,
    _prepRes: void,
    execRes: CyclePrepResult,
  ): Promise<string | undefined> {
    const {
      messages,
      runState,
      workspaceState,
      userChannels,
      shouldSkipCycle,
      systemPrompt,
    } = execRes;
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
