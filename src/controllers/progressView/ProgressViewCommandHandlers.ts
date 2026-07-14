// Local imports - shared
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentCategoryFilter, StreamTabId } from '@shared/schemas';
import type {
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
} from '@shared/schemas/progressView';
import {
  isApprovalBypassedForStream,
  proposalApprovals,
  setBashApprovalSessionBypass,
  setDelegatedWorkApprovalBypasses,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import { handleExternalInquiryAction } from '@tools/inquiry';
import { persistOpenTurnDraft } from '@tools/inquiry/externalInquiryStorage';

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

interface ProgressViewFollowUpSubmission {
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
  /**
   * Session that owns the approval bypass state. Desktop scopes it to its
   * window session; the extension omits it so the default session applies.
   */
  session?: SessionHandle;
  /** Resolve a retained stream's durable approval owner. */
  sessionForStream?(stream: StreamTabId): SessionHandle | undefined;
  showInfo?(message: string): void | PromiseLike<unknown>;
}

export interface ProgressViewApprovalCommandActions {
  approvePendingDelegatedWork(
    stream: StreamTabId,
    initiatingProposalId: string,
  ): Promise<void>;
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

export interface ProgressViewExternalInquiryCommandActions {
  /**
   * Forwarded to the inquiry submit/drop settle path. Desktop scopes it to its
   * window session; the extension omits it so the module default applies.
   */
  session?: SessionHandle;
}

export interface ProgressViewCommandActions {
  lifecycle: ProgressViewLifecycleCommandActions;
  run: ProgressViewRunCommandActions;
  followUp: ProgressViewFollowUpCommandActions;
  bypass: ProgressViewBypassCommandOptions;
  file: ProgressViewFileCommandActions;
  approval: ProgressViewApprovalCommandActions;
  externalInquiry: ProgressViewExternalInquiryCommandActions;
}

/**
 * Shared progress-view command handlers used by both extension and desktop.
 *
 * Host-only commands stay with each host; this factory owns the command
 * routing that should not drift across hosts. Lifecycle, run, and file
 * commands are plain action plumbing; follow-up image persistence, the
 * bypass-toggle symmetry rules, and approval routing carry shared policy so
 * hosts do not each reimplement them.
 *
 * Returns only the subset of commands this factory owns (not the full
 * exhaustive registry) via `satisfies Partial<...>`: `satisfies` still gives
 * each handler below its correct per-command parameter type, but keeps the
 * function's real return type to exactly the keys present here. Each host
 * spreads this into its own registry alongside its host-specific commands
 * (including `unsupported(...)` for anything it doesn't implement); that
 * final spread is what TypeScript checks for full command coverage.
 */
export function createProgressViewCommandHandlers(
  actions: ProgressViewCommandActions,
) {
  const { lifecycle, run, file, followUp, approval, externalInquiry } = actions;
  const { runtimeHost, session, sessionForStream, showInfo } = actions.bypass;
  const bypassSession = (stream: StreamTabId): SessionHandle | undefined =>
    sessionForStream?.(stream) ?? session;

  // Single source of truth for the coupled edit + bash session bypass behind
  // the one Yolo concept. The shield toolbar button flips it; the inline "Yolo
  // (this session)" prompt button forces it on. Bash rides along silently (the
  // shield reflects tool-edit state), so both surfaces stay in lockstep.
  const applyCoupledBypass = async (
    stream: StreamTabId,
    enabled: boolean,
  ): Promise<void> => {
    const ownerSession = bypassSession(stream);
    setToolEditApprovalSessionBypass(stream, enabled, runtimeHost, {
      session: ownerSession,
    });
    setBashApprovalSessionBypass(stream, enabled, runtimeHost, {
      silent: true,
      session: ownerSession,
    });
    await showInfo?.(
      enabled
        ? 'YOLO mode enabled: Tool actions and bash commands will be auto-approved for this stream.'
        : 'YOLO mode disabled: Tool actions and bash commands will prompt for approval.',
    );
  };

  const reportDelegatedWorkApproval = async (
    enabled: boolean,
  ): Promise<void> => {
    await showInfo?.(
      enabled
        ? 'Task, file-edit, and command auto-approval enabled for this stream.'
        : 'Task, file-edit, and command auto-approval disabled for this stream.',
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
        !isApprovalBypassedForStream(data.stream, bypassSession(data.stream)),
      ),
    // Inline "Yolo (this session)" prompt button: force bypass ON. Unlike the
    // shield toggle this is idempotent, so it can never invert an already-on
    // edit bypass on a stream whose bash is still gated (e.g. a delegated child
    // where edit-YOLO and bash inheritance were granted independently).
    [PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS]: (data) =>
      applyCoupledBypass(data.stream, true),
    [PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS]: (data) => {
      const ownerSession = bypassSession(data.stream);
      const enabled = !proposalApprovals(ownerSession).isBypassed(data.stream);
      setDelegatedWorkApprovalBypasses(
        data.stream,
        enabled,
        runtimeHost,
        ownerSession,
      );
      return reportDelegatedWorkApproval(enabled);
    },
    // The inline proposal action forces the complete delegated-task approval
    // mode on. It is idempotent, so it cannot invert a grant made from the
    // stream header while the proposal was open.
    [PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS]: async (data) => {
      setDelegatedWorkApprovalBypasses(
        data.stream,
        true,
        runtimeHost,
        bypassSession(data.stream),
      );
      await approval.approvePendingDelegatedWork(
        data.stream,
        data.initiatingProposalId,
      );
      await reportDelegatedWorkApproval(true);
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

    // Draft persists the open turn; the canonical submit/drop union settles it.
    [PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION]: async (data) => {
      if (data.action === 'draft') {
        await persistOpenTurnDraft({
          threadId: data.threadId,
          draft: data.draft,
        });
        return;
      }
      await handleExternalInquiryAction(data, externalInquiry);
    },
  } satisfies Partial<ProgressViewInboundHandlerRegistry>;
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
