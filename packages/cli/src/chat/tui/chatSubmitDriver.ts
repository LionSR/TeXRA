// Chat-session submission engine: slash-command dispatch, follow-up admission,
// the 25ms stream-id poll loop, queued-follow-up event emission, and
// skill-activation reservation/restore. Extracted from runChatTui so the
// submission state machine is independently testable without mounting Ink;
// runChat stays composition + rendering glue + Ink lifecycle.

import { setTimeout as sleep } from 'node:timers/promises';

import PQueue from 'p-queue';

import type { SessionHandle } from '@agent/runtime';
import { presentFollowUpResult, submitFollowUp } from '@agent/followUp';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';
import type { RunModelDecisionReason } from '@model/runModelDecision';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { FOCUSED_BACKGROUND_TASK } from '@shared/copy/nestedRuns';
import { escapeText } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { handleTuiSlashCommand } from './commands/handleSlashCommand';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './commands/handlers/slashContext';
import {
  parentStream as parentStreamSignal,
  streamMetadataFor,
} from './state/childExecutions';
import {
  activeStreamId as activeStreamIdSignal,
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
} from './state/cliState';
import {
  focusedChildFollowUpRoute,
  type FocusedChildFollowUpRoute,
} from './state/focusedChildFollowUp';
import {
  chatTuiCanStartRootRun,
  type TuiSession,
} from './state/sessionRunState';
import {
  appendLocalAssistantTranscript,
  appendLocalErrorTranscript,
  appendLocalUserTranscript,
} from './state/transcript';
import type { ChatSessionController } from '../chatSessionController';
import type { SkillActivation } from './forms/SkillsListForm';

export interface PreparedChatInstruction {
  readonly instruction: string;
  readonly displayInstruction?: string;
  readonly reservedSkillActivations: readonly SkillActivation[];
}

export function takePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  line: string,
): PreparedChatInstruction {
  if (pendingSkillActivations.size === 0) {
    return { instruction: line, reservedSkillActivations: [] };
  }

  const entries = [...pendingSkillActivations.entries()].map(
    ([name, activationPrompt]) => {
      pendingSkillActivations.delete(name);
      return { name, activationPrompt };
    },
  );

  const activations = entries
    .map(({ activationPrompt }) => activationPrompt)
    .join('\n\n');
  return {
    instruction: [
      activations,
      '<user_request>',
      escapeText(line),
      '</user_request>',
    ].join('\n'),
    displayInstruction: line,
    reservedSkillActivations: entries,
  };
}

export function restorePendingSkillActivations(
  pendingSkillActivations: Map<string, string>,
  activations: readonly SkillActivation[],
): void {
  for (const { name, activationPrompt } of activations) {
    if (!pendingSkillActivations.has(name)) {
      pendingSkillActivations.set(name, activationPrompt);
    }
  }
}

export function chatTuiFocusedChildFollowUpRoute(): FocusedChildFollowUpRoute {
  const activeStreamId = activeStreamIdSignal.get();
  return focusedChildFollowUpRoute({
    activeStreamId,
    parentStream: parentStreamSignal.get(),
    metadata: activeStreamId ? streamMetadataFor(activeStreamId) : undefined,
    streams: streamsSignal.get(),
  });
}

export interface ChatSubmitDriverDeps {
  readonly session: TuiSession;
  readonly chatController: ChatSessionController;
  readonly followUpQueue: PQueue;
  readonly runtimeSession: SessionHandle;
  /** Root agent/model resolved at startup; fallbacks when session meta is unset. */
  readonly initialAgent: string;
  readonly initialModel: string;
  readonly initialModelSource: RunModelDecisionReason;
  readonly cwd: string;
  readonly getSlashCommandContext: () => SlashCommandContext;
}

export interface ChatSubmitDriver {
  readonly handleSubmittedLine: (
    line: string,
    mediaFiles?: readonly string[],
  ) => Promise<void>;
  /** Reserve a skill activation for the next submitted message. */
  readonly activateSkill: (selection: SkillActivation) => void;
  /** Clear the pending-skill reservation state (used on `/clear`). */
  readonly clearPendingSkills: () => void;
}

export function createChatSubmitDriver(
  deps: ChatSubmitDriverDeps,
): ChatSubmitDriver {
  const {
    session,
    chatController,
    followUpQueue,
    runtimeSession,
    initialAgent,
    initialModel,
    initialModelSource,
    cwd,
    getSlashCommandContext,
  } = deps;

  // Skill activations are reserved for the next submitted line; a `/clear`
  // bumps the epoch so stale restore callbacks become no-ops.
  const pendingSkillActivations = new Map<string, string>();
  let pendingSkillActivationClearEpoch = 0;

  const startSession = async (
    instruction: string,
    mediaFiles?: readonly string[],
    displayInstruction?: string,
  ): Promise<boolean> => {
    followUpQueue.clear();
    session.executionId = undefined;
    let started = false;
    // Queue the async startup body after the reservation below so a second
    // submit cannot pass chatTuiCanStartRootRun during model/auth resolution.
    const pendingStart = Promise.resolve().then(async (): Promise<void> => {
      try {
        const meta = sessionMetaSignal.get();
        const currentAgent = meta.agent || initialAgent;
        const currentModel = meta.model || initialModel;
        const selection = await selectCliRunnableModel(currentModel, {
          fallbackReason: meta.model ? meta.modelSource : initialModelSource,
          apiMode: meta.apiMode,
          noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
            meta.apiMode,
            // In-session root starts (not process startup): guide `/api` and
            // `/login` rather than relaunching `texra chat --api-mode …`.
            CHAT_API_MODE_MODEL_RECOVERY,
          ),
        });
        await setCliHelperModel(selection.model);
        if (session.stopRequested) {
          session.markRunCompleted();
          return;
        }

        chatController.startRootRun({
          agent: currentAgent,
          model: selection.model,
          instruction,
          ...(displayInstruction !== undefined ? { displayInstruction } : {}),
          agentCategory: AgentCategory.ToolUse,
          workingDirectory: cwd,
          ...(mediaFiles?.length ? { mediaFiles: [...mediaFiles] } : {}),
          ...(meta.cliMultiAgentPresetId
            ? { cliMultiAgentPresetId: meta.cliMultiAgentPresetId }
            : {}),
          ...(meta.delegationAgentScope
            ? { delegationAgentScope: meta.delegationAgentScope }
            : {}),
        });
        started = true;
      } catch (error: unknown) {
        if (!session.stopRequested) {
          appendLocalUserTranscript(displayInstruction ?? instruction);
          appendLocalErrorTranscript(toErrorMessage(error));
        }
        session.runExitCode = session.stopRequested
          ? CliExitCode.Success
          : CliExitCode.AgentError;
        session.markRunCompleted();
      }
    });
    session.markRunPending(pendingStart);
    await pendingStart;
    return started;
  };

  const submitChatMessage = async (
    line: string,
    mediaFiles?: readonly string[],
  ): Promise<void> => {
    const focusedChildRoute = chatTuiFocusedChildFollowUpRoute();
    if (focusedChildRoute.kind === 'reject') {
      appendLocalAssistantTranscript(
        FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
        focusedChildRoute.streamId,
      );
      return;
    }
    const childFollowUpTarget =
      focusedChildRoute.kind === 'accept'
        ? focusedChildRoute.streamId
        : undefined;
    const prepared = takePendingSkillActivations(pendingSkillActivations, line);
    const skillActivationClearEpoch = pendingSkillActivationClearEpoch;
    const restoreReservedSkillActivations = (): void => {
      if (skillActivationClearEpoch !== pendingSkillActivationClearEpoch) {
        return;
      }
      restorePendingSkillActivations(
        pendingSkillActivations,
        prepared.reservedSkillActivations,
      );
    };
    if (!childFollowUpTarget) {
      const interruptedAdmission = chatController.admitInterruptedFollowUp({
        text: prepared.instruction,
        mediaFiles,
        displayText: prepared.displayInstruction,
      });
      if (interruptedAdmission.kind === 'accepted') {
        const resumed = await interruptedAdmission.completion;
        if (resumed) return;
        restoreReservedSkillActivations();
        appendLocalAssistantTranscript(
          'The interrupted conversation could not be restored. Use /resume to retry it, or /clear to start a new conversation.',
          interruptedAdmission.streamId,
        );
        return;
      }
    }
    if (!childFollowUpTarget && chatTuiCanStartRootRun(session)) {
      const started = await startSession(
        prepared.instruction,
        mediaFiles,
        prepared.displayInstruction,
      );
      if (!started) {
        restoreReservedSkillActivations();
      }
      return;
    }
    // PRD success criterion: follow-ups must not be silently dropped when the
    // user submits before `onStreamResolved` populates `session.streamId`.
    // p-queue serializes work but doesn't have an "await predicate" primitive,
    // so the task itself waits for the stream id via a tiny poll loop.
    void followUpQueue.add(async () => {
      let delivered = false;
      let followUpTarget = childFollowUpTarget;
      const emitQueuedFollowUpsChanged = (streamId: StreamTabId): void => {
        runtimeSession.events.emit({
          scope: 'session',
          event: {
            type: 'updateQueuedFollowUps',
            payload: { streamId },
          },
        });
      };
      try {
        while (
          !followUpTarget &&
          !session.stopRequested &&
          !session.runCompleted
        ) {
          await sleep(25);
          followUpTarget = session.streamId;
        }
        if (!followUpTarget || session.stopRequested) return;
        const result = await submitFollowUp(followUpTarget, {
          text: prepared.instruction,
          mediaFiles,
          displayText: prepared.displayInstruction,
        });
        if (result.status === 'sent') {
          emitQueuedFollowUpsChanged(followUpTarget);
          delivered = true;
        } else if (result.status === 'queued') {
          emitQueuedFollowUpsChanged(followUpTarget);
          const presentation = presentFollowUpResult(result);
          if (presentation.severity !== 'none') {
            if (presentation.refreshQueuedFollowUps) {
              emitQueuedFollowUpsChanged(followUpTarget);
            }
            appendLocalAssistantTranscript(
              presentation.message,
              followUpTarget,
            );
          }
          delivered = result.continuation !== 'resume_failed';
        }
        if (result.status === 'no_session' || result.status === 'dropped') {
          // Child stream ids are keys in parentStream; the root session id is not.
          if (followUpTarget === session.streamId) {
            session.stopRequested = true;
          } else {
            appendLocalAssistantTranscript(
              FOCUSED_BACKGROUND_TASK.selectedNoLongerAccepting,
              followUpTarget,
            );
          }
        }
      } finally {
        if (!delivered) {
          restoreReservedSkillActivations();
        }
      }
    });
  };

  const handleSubmittedLine = async (
    line: string,
    mediaFiles?: readonly string[],
  ): Promise<void> => {
    if (await handleTuiSlashCommand(line, getSlashCommandContext())) {
      return;
    }
    await submitChatMessage(line, mediaFiles);
  };

  const activateSkill = (selection: SkillActivation): void => {
    const wasPending = pendingSkillActivations.has(selection.name);
    pendingSkillActivations.set(selection.name, selection.activationPrompt);
    appendLocalAssistantTranscript(
      [
        `Skill ${wasPending ? 'refreshed' : 'activated'}: ${selection.name}.`,
        'It will be applied to your next message.',
      ].join(' '),
    );
  };

  const clearPendingSkills = (): void => {
    pendingSkillActivationClearEpoch += 1;
    pendingSkillActivations.clear();
  };

  return { handleSubmittedLine, activateSkill, clearPendingSkills };
}
