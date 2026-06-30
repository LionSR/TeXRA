// Local imports - shared
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategoryFilter, StreamTabId } from '@shared/schemas';
import type {
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import {
  isApprovalBypassedForStream,
  proposalApprovalState,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';

// Local imports - utilities
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';

type ProgressViewMessage<C extends ProgressViewInboundMessage['command']> =
  Extract<ProgressViewInboundMessage, { command: C }>;

type SendFollowUpMessage = ProgressViewMessage<
  typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP
>;

export type ProgressViewFollowUpImage = NonNullable<
  SendFollowUpMessage['images']
>[number];

export interface ProgressViewFollowUpSubmission {
  stream: StreamTabId;
  text: string;
  mediaFiles?: readonly string[];
}

export interface ProgressViewLifecycleCommandActions {
  setActiveStream(stream: StreamTabId): Promise<void> | void;
  setAgentFilter(filter: AgentCategoryFilter): Promise<void> | void;
  deleteStream(stream: StreamTabId): Promise<void> | void;
  deleteAllStreams(): Promise<void> | void;
  stopStream(stream: StreamTabId): Promise<void> | void;
}

export interface ProgressViewRunCommandActions {
  resumeStream(stream: StreamTabId): Promise<void> | void;
  runNewStream(stream: StreamTabId): Promise<void> | void;
}

export interface ProgressViewFileCommandActions {
  openFile(file: string, line?: number): Promise<void> | void;
  openFileCompile(file: string): Promise<void> | void;
  openTaskStorage(stream: StreamTabId): Promise<void> | void;
  compareOriginal(file: string, base?: string): Promise<void> | void;
  comparePrevious(
    file: string,
    base?: string,
    previous?: string,
  ): Promise<void> | void;
  acceptFile(file: string, base?: string): Promise<void> | void;
  mergeFile(file: string, base?: string): Promise<void> | void;
  latexdiffFile(file: string, base?: string): Promise<void> | void;
  openLabel(label: string): Promise<void> | void;
}

export interface ProgressViewFollowUpCommandActions {
  sendFollowUp(
    submission: ProgressViewFollowUpSubmission,
  ): Promise<void> | void;
  reportImageSaveError(image: ProgressViewFollowUpImage, error: unknown): void;
}

export interface ProgressViewBypassCommandOptions {
  runtimeHost: AgentRuntimeHost;
  showInfo?(message: string): void | PromiseLike<unknown>;
}

export interface ProgressViewApprovalCommandActions {
  handleToolEditApprovalAction(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
    >,
  ): boolean | Promise<boolean>;
  onUnsupportedToolEditApproval?(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION
    >,
  ): void;
  handleBashApprovalAction(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION
    >,
  ): unknown;
  handlePlanApprovalAction(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION
    >,
  ): unknown;
  handleUserQuestionAction(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION
    >,
  ): unknown;
  handleAgentProposalAction(
    message: ProgressViewMessage<
      typeof PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION
    >,
  ): unknown;
}

export interface ProgressViewCommandActions {
  lifecycle: ProgressViewLifecycleCommandActions;
  run: ProgressViewRunCommandActions;
  followUp: ProgressViewFollowUpCommandActions;
  bypass: ProgressViewBypassCommandOptions;
  file: ProgressViewFileCommandActions;
  approval: ProgressViewApprovalCommandActions;
}

/**
 * Shared progress-view command handlers used by both extension and desktop.
 *
 * Host-only commands stay with each host; this factory owns the command
 * routing that should not drift across hosts. Lifecycle, run, and file
 * commands are plain action plumbing; follow-up image persistence, the
 * bypass-toggle symmetry rules, and approval routing carry shared policy so
 * hosts do not each reimplement them.
 */
export function createProgressViewCommandHandlers(
  actions: ProgressViewCommandActions,
): ProgressViewInboundHandlerRegistry {
  const { lifecycle, run, file, followUp, approval } = actions;
  const { runtimeHost, showInfo } = actions.bypass;

  // Single source of truth for the coupled edit + bash session bypass behind
  // the one Yolo concept. The shield toolbar button flips it; the inline "Yolo
  // (this session)" prompt button forces it on. Bash rides along silently (the
  // shield reflects tool-edit state), so both surfaces stay in lockstep.
  const applyCoupledBypass = async (
    stream: StreamTabId,
    enabled: boolean,
  ): Promise<void> => {
    setToolEditApprovalSessionBypass(stream, enabled, runtimeHost);
    setBashApprovalSessionBypass(stream, enabled, runtimeHost, {
      silent: true,
    });
    await showInfo?.(
      enabled
        ? 'YOLO mode enabled: Tool actions and bash commands will be auto-approved for this stream.'
        : 'YOLO mode disabled: Tool actions and bash commands will prompt for approval.',
    );
  };

  return {
    [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
      lifecycle.setActiveStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.FILTER_STREAMS]: (data) =>
      lifecycle.setAgentFilter(data.filter),
    [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: (data) =>
      lifecycle.deleteStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => lifecycle.deleteAllStreams(),
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
      lifecycle.stopStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.RESUME]: (data) => run.resumeStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) => run.runNewStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (data) =>
      file.openFile(data.file, data.line),
    [PROGRESS_VIEW_COMMANDS.OPEN_FILE_COMPILE]: (data) =>
      file.openFileCompile(data.file),
    [PROGRESS_VIEW_COMMANDS.OPEN_TASK_STORAGE]: (data) =>
      file.openTaskStorage(data.stream),
    [PROGRESS_VIEW_COMMANDS.COMPARE_ORIGINAL]: (data) =>
      file.compareOriginal(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.COMPARE_PREVIOUS]: (data) =>
      file.comparePrevious(data.file, data.base, data.prev),
    [PROGRESS_VIEW_COMMANDS.ACCEPT_FILE]: (data) =>
      file.acceptFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.MERGE_FILE]: (data) =>
      file.mergeFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.LATEXDIFF_FILE]: (data) =>
      file.latexdiffFile(data.file, data.base),
    [PROGRESS_VIEW_COMMANDS.OPEN_LABEL]: (data) => file.openLabel(data.label),

    [PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP]: async (data) => {
      const mediaFiles = await saveFollowUpImages(
        data.images ?? [],
        followUp.reportImageSaveError,
      );
      await followUp.sendFollowUp({
        stream: data.stream,
        text: data.text,
        ...(mediaFiles.length > 0 ? { mediaFiles } : {}),
      });
    },

    // The UI exposes one shield for file edits + bash and one stronger
    // delegated task auto-approval; keep the cross-approval side effects
    // symmetric here.
    [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]: (data) =>
      applyCoupledBypass(
        data.stream,
        !isApprovalBypassedForStream(data.stream),
      ),
    // Inline "Yolo (this session)" prompt button: force bypass ON. Unlike the
    // shield toggle this is idempotent, so it can never invert an already-on
    // edit bypass on a stream whose bash is still gated (e.g. a delegated child
    // where edit-YOLO and bash inheritance were granted independently).
    [PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS]: (data) =>
      applyCoupledBypass(data.stream, true),
    [PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS]: async (data) => {
      const isNowEnabled = proposalApprovalState.toggleBypass(
        data.stream,
        runtimeHost,
      );
      if (isNowEnabled) {
        if (!isApprovalBypassedForStream(data.stream)) {
          setToolEditApprovalSessionBypass(data.stream, true, runtimeHost);
        }
      } else {
        setToolEditApprovalSessionBypass(data.stream, false, runtimeHost);
      }
      setBashApprovalSessionBypass(data.stream, isNowEnabled, runtimeHost, {
        silent: true,
      });
      await showInfo?.(
        isNowEnabled
          ? 'Delegated task auto-approval enabled for this stream.'
          : 'Delegated task auto-approval disabled for this stream.',
      );
    },
    // Inline "Super Yolo (this session)" proposal button: force the
    // delegated-task auto-approval bypass ON. Idempotent like
    // ENABLE_APPROVAL_BYPASS, so selecting it (or the `a` shortcut) on a
    // still-visible proposal can never invert an already-on bypass back off the
    // way TOGGLE_SUPER_YOLO_BYPASS would (e.g. when super-yolo was turned on
    // from the stream header while this prompt was open). Mirrors the toggle's
    // enabled branch: edit bypass rides along only if not already on, bash
    // silently.
    [PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS]: async (data) => {
      proposalApprovalState.setBypass(data.stream, true, runtimeHost);
      if (!isApprovalBypassedForStream(data.stream)) {
        setToolEditApprovalSessionBypass(data.stream, true, runtimeHost);
      }
      setBashApprovalSessionBypass(data.stream, true, runtimeHost, {
        silent: true,
      });
      await showInfo?.('Delegated task auto-approval enabled for this stream.');
    },

    [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (data) => {
      const handled = approval.handleToolEditApprovalAction(data);
      if (handled instanceof Promise) {
        return handled.then((result) => {
          if (result === false) {
            approval.onUnsupportedToolEditApproval?.(data);
          }
        });
      }
      if (handled === false) {
        approval.onUnsupportedToolEditApproval?.(data);
      }
    },
    [PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION]: async (data) => {
      await approval.handleBashApprovalAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION]: async (data) => {
      await approval.handlePlanApprovalAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION]: async (data) => {
      await approval.handleUserQuestionAction(data);
    },
    [PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]: async (data) => {
      await approval.handleAgentProposalAction(data);
    },
  };
}

async function saveFollowUpImages(
  images: readonly ProgressViewFollowUpImage[],
  reportImageSaveError: ProgressViewFollowUpCommandActions['reportImageSaveError'],
): Promise<string[]> {
  const mediaFiles: string[] = [];
  for (const image of images) {
    try {
      mediaFiles.push(
        await savePastedImageBase64(image.base64, image.fileName),
      );
    } catch (error) {
      reportImageSaveError(image, error);
    }
  }
  return mediaFiles;
}
