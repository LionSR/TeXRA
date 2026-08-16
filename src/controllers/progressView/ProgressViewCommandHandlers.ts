// Local imports
import type { DeleteStreamResult } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { notifyFollowUpSent } from '@agent/followUp/ToolUseFollowUp';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { isApiProvider } from '@model/apiProviders';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  AgentProposal,
  ProgressViewInboundHandlerRegistry,
  ProgressViewInboundMessage,
  ProgressViewOutboundMessage,
  StreamTabId,
} from '@shared/schemas';
import { isPlainAgentIdentity } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';
import {
  isApprovalBypassedForStream,
  setBashApprovalSessionBypass,
  setToolEditApprovalSessionBypass,
} from '@tools/approval';
import {
  continueExternalInquiryAction,
  persistExternalInquiryAction,
} from '@tools/inquiry/inquiryActions';
import { persistOpenTurnDraft } from '@tools/inquiry/externalInquiryStorage';
import type { RunMetadata } from '@transcript/StreamSnapshotStore';
import { savePastedImageBase64 } from '@utils/files/pastedImageUtils';
import type { ProgressWorkflowActionsController } from './ProgressWorkflowActionsController';
import type { ProgressApiKeyRetryController } from './ProgressApiKeyRetryController';
import type {
  ProgressFollowUpController,
  ProgressFollowUpPlan,
} from './ProgressFollowUpController';
import type {
  ProgressFollowUpPolishController,
  ProgressFollowUpPolishResult,
} from './ProgressFollowUpPolishController';

/**
 * Shared native-agent-run gate for the resume / re-run / restore affordances:
 * resolve the stream's run metadata, refuse with a user-facing message when
 * the run is not a native TeXRA agent run, and require a persisted config.
 * Workflow-script configs are borrowed, process configs are synthetic, and
 * external CLI sessions resume through their own tool, so relaunching any of
 * those stored configs would run the wrong thing.
 * Returns the resolved metadata when the action may proceed, else null.
 */
export async function resolveNativeAgentRun(
  getRunMetadata: (stream: StreamTabId) => RunMetadata,
  stream: StreamTabId,
  showInfo: (message: string) => void | PromiseLike<unknown>,
  action: string,
  preload?: (stream: StreamTabId) => Promise<void>,
): Promise<
  (RunMetadata & { config: NonNullable<RunMetadata['config']> }) | null
> {
  await preload?.(stream);
  const metadata = getRunMetadata(stream);
  if (!isPlainAgentIdentity(metadata.identity)) {
    await showInfo(
      `Only TeXRA agent runs can be ${action} from here; this stream's run is ` +
        'not one.',
    );
    return null;
  }
  const { config, ...rest } = metadata;
  if (!config) return null;
  // The config guard above guarantees the resolved metadata carries a config,
  // so the return type narrows `config` to defined for callers.
  return { ...rest, config };
}

type ProgressViewMessage<C extends ProgressViewInboundMessage['command']> =
  Extract<ProgressViewInboundMessage, { command: C }>;

type SendFollowUpMessage = ProgressViewMessage<
  typeof PROGRESS_VIEW_COMMANDS.SEND_FOLLOW_UP
>;

type ProgressViewFollowUpImage = NonNullable<
  SendFollowUpMessage['images']
>[number];

interface ProgressViewFollowUpSubmission {
  stream: StreamTabId;
  text: string;
  mediaFiles?: readonly string[];
}

export interface ProgressViewLifecycleCommandActions {
  setActiveStream(
    stream: StreamTabId | '',
    requestId: string,
  ): Promise<void> | void;
  deleteStream(
    stream: StreamTabId,
  ): Promise<DeleteStreamResult | undefined> | void;
  deleteAllStreams(): Promise<void> | void;
  stopStream(stream: StreamTabId): Promise<void> | void;
}

interface ProgressViewRunCommandActions {
  resumeStream(stream: StreamTabId): Promise<void> | void;
  runNewStream(stream: StreamTabId): Promise<void> | void;
}

export interface ProgressViewFileCommandActions {
  openFile(file: string, line?: number): Promise<void> | void;
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
  /**
   * Session that owns the approval bypass state. Desktop scopes it to its
   * window session; the extension omits it so the default session applies.
   */
  session?: SessionHandle;
  /** Host info-notification port: confirms the new auto-approval state after
   *  a toggle, and reports refused resume/re-run requests. */
  showInfo(message: string): void | PromiseLike<unknown>;
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
  ): void | Promise<void>;
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
   * Continuation owner. Desktop scopes it to its window session; the extension
   * omits it so the module default applies.
   */
  session?: SessionHandle;
  /** Remove the completed inquiry from progress presentation state. */
  dismiss(threadId: string): void;
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
 * per-kind bypass grant rules, and approval routing carry shared policy so
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
  const { session, showInfo } = actions.bypass;

  const reportDelegatedWorkApproval = async (
    enabled: boolean,
  ): Promise<void> => {
    await showInfo(
      enabled
        ? 'Agent tasks, file edits, and shell commands will be auto-approved for this run.'
        : 'Agent tasks, file edits, and shell commands will require approval for this run.',
    );
  };

  return {
    [PROGRESS_VIEW_COMMANDS.SWITCH_STREAM]: (data) =>
      lifecycle.setActiveStream(data.stream, data.requestId),
    [PROGRESS_VIEW_COMMANDS.DELETE_STREAM]: async (data) => {
      // The outcome matters to the session-fact applier, not the dispatcher.
      await lifecycle.deleteStream(data.stream);
    },
    [PROGRESS_VIEW_COMMANDS.DELETE_ALL]: () => lifecycle.deleteAllStreams(),
    [PROGRESS_VIEW_COMMANDS.STOP_STREAM]: (data) =>
      lifecycle.stopStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.RESUME]: (data) => run.resumeStream(data.stream),
    [PROGRESS_VIEW_COMMANDS.RUN_NEW]: (data) => run.runNewStream(data.stream),

    [PROGRESS_VIEW_COMMANDS.OPEN_FILE]: (data) =>
      file.openFile(data.file, data.line),
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

    // The shield is the explicit both-kinds preset: one click sets file edits
    // and shell commands together, and its label says so. Its on/off reading
    // comes from the tool-edit state.
    [PROGRESS_VIEW_COMMANDS.TOGGLE_TOOL_EDIT_APPROVAL_BYPASS]: async (data) => {
      const enabled = !isApprovalBypassedForStream(data.stream, session);
      setToolEditApprovalSessionBypass(data.stream, enabled, { session });
      setBashApprovalSessionBypass(data.stream, enabled, { session });
      await showInfo(
        enabled
          ? 'File edits and shell commands will be auto-approved for this run.'
          : 'File edits and shell commands will require approval for this run.',
      );
    },
    // Inline prompt button: force the prompt's own kind ON and nothing else.
    // Approving always from an edit prompt leaves shell commands gated, and
    // vice versa. Set-on (not toggle) keeps it from inverting a grant the
    // shield or an inherited delegated child already made.
    [PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS]: async (data) => {
      if (data.kind === PERMISSION_KIND.TOOL_EDIT) {
        setToolEditApprovalSessionBypass(data.stream, true, { session });
        await showInfo('File edits will be auto-approved for this run.');
        return;
      }
      setBashApprovalSessionBypass(data.stream, true, { session });
      await showInfo('Shell commands will be auto-approved for this run.');
    },
    [PROGRESS_VIEW_COMMANDS.TOGGLE_SUPER_YOLO_BYPASS]: (data) => {
      const { approvals } = session ?? currentSession();
      const enabled = !approvals.proposal.isBypassed(data.stream);
      approvals.setDelegatedWorkBypasses(data.stream, enabled);
      return reportDelegatedWorkApproval(enabled);
    },
    // The inline proposal action forces the complete delegated-task approval
    // mode on. It is idempotent, so it cannot invert a grant made from the
    // stream header while the proposal was open.
    [PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS]: async (data) => {
      (session ?? currentSession()).approvals.setDelegatedWorkBypasses(
        data.stream,
        true,
      );
      await approval.approvePendingDelegatedWork(
        data.stream,
        data.initiatingProposalId,
      );
      await reportDelegatedWorkApproval(true);
    },

    [PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION]: (data) =>
      approval.handleToolEditApprovalAction(data),
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
      const transition = await persistExternalInquiryAction(data);
      externalInquiry.dismiss(data.threadId);
      await continueExternalInquiryAction(transition, externalInquiry);
    },
  } satisfies Partial<ProgressViewInboundHandlerRegistry>;
}

// ── Second-tier handler deps ──────────────────────────────────────────────

export interface ProgressViewSecondTierActions {
  /** Shared controllers (host-neutral; created once per host with injected deps). */
  readonly workflowActions: ProgressWorkflowActionsController;
  readonly apiKeyRetry: ProgressApiKeyRetryController;
  readonly followUp: ProgressFollowUpController;
  readonly followUpPolish: ProgressFollowUpPolishController;
  /** Host-level user messaging. */
  readonly host: {
    readonly showInfo: (message: string) => Promise<void> | void;
  };
  /** Session handle (for manual compaction). */
  readonly session: SessionHandle;
  /** Look up one coherent run record for operations that need several facts. */
  readonly getRunMetadata: (stream: StreamTabId) => RunMetadata;
  /** Single-field lookup used only by follow-up polishing. */
  readonly getRunConfig: (stream: StreamTabId) => AgentConfig | undefined;
  /**
   * Warm a webview-selected stream before the synchronous metadata and
   * artifact readers above run. Production hosts always provide it.
   */
  readonly preload?: (stream: StreamTabId) => Promise<void>;
  /**
   * Restore the run config of a completed run into the main view (the extension
   * routes through `texra.restoreState`; the desktop calls
   * `buildMainViewState` / `prepareMainViewExecutionLaunch` directly).
   * The host owns any failure reporting because the extension command and
   * desktop state builder have different error paths.
   */
  readonly restoreRunConfig: (config: AgentConfig) => Promise<void>;
  /** Resolve a follow-up plan (plan kinds map to host-specific execution). */
  readonly applyFollowUpPlan: (plan: ProgressFollowUpPlan) => Promise<void>;
  /** Render a polish result (update renderer + show host messages). */
  readonly applyPolishResult: (
    result: ProgressFollowUpPolishResult,
  ) => Promise<void>;
  /**
   * Report a polish stage to the user. Hosts with a progress surface (the
   * extension feeds a `vscode.window.withProgress` notification) implement it;
   * hosts without one leave it unset.
   */
  readonly onPolishProgress?: (message: string) => void;
  /** Handle a polish controller exception (post error to renderer + log + host message). */
  readonly onPolishError: (
    stream: StreamTabId,
    error: unknown,
  ) => void | Promise<void>;
  /** Post a message to the renderer. */
  readonly postToRenderer: (message: ProgressViewOutboundMessage) => void;
  /** Restore an agent proposal config into the main view (delegates to agentProposalController). */
  readonly restoreProposalConfig: (proposal: AgentProposal) => Promise<void>;
  /** Retry request settlement. */
  readonly retry: {
    readonly submit: (
      stream: StreamTabId,
      requestId: string,
      feedback?: string,
    ) => boolean;
    readonly cancel: (stream: StreamTabId, requestId: string) => void;
  };
}

/**
 * Shared second-tier progress-view command handlers used by both extension and
 * desktop.
 *
 * These handlers wrap shared controllers ({@link ProgressWorkflowActionsController},
 * {@link ProgressApiKeyRetryController}, {@link ProgressFollowUpController},
 * {@link ProgressFollowUpPolishController}) plus host-injected callbacks for
 * messaging, retry settlement, state restoration, plan/polish result
 * application, recording, and proposal restore.
 *
 * Hosts create the controllers and callbacks once, call this factory, and
 * spread the result into their handler registry alongside
 * {@link createProgressViewCommandHandlers} and host-specific commands.
 */
export function createProgressViewSecondTierHandlers(
  deps: ProgressViewSecondTierActions,
) {
  const CMD = PROGRESS_VIEW_COMMANDS;

  return {
    // ── Workflow toolbar (diff / pack / clean) ──
    [CMD.DIFF_STREAM]: (data) => deps.workflowActions.diffStream(data.stream),
    [CMD.PACK_STREAM]: (data) =>
      deps.workflowActions.runFileOperation(data.stream, 'pack'),
    [CMD.CLEAN_STREAM]: (data) =>
      deps.workflowActions.runFileOperation(data.stream, 'clean'),

    // ── Retry ──
    [CMD.RETRY_STREAM_REQUEST]: async (data) => {
      const resolved = deps.retry.submit(
        data.stream,
        data.requestId,
        data.feedback,
      );
      if (!resolved) {
        await deps.host.showInfo(
          'No retryable request is available for this stream yet.',
        );
      }
    },
    [CMD.CANCEL_RETRY_REQUEST]: (data) => {
      deps.retry.cancel(data.stream, data.requestId);
    },

    // ── API key retry ──
    [CMD.USE_OWN_API_KEY]: async (data) => {
      // Provider validation: the IPC payload strings / user input must match a
      // known api provider; silently narrow unknown values so the controller
      // skips its provider-specific key-lookup branch.
      const providerArg =
        data.provider !== undefined && isApiProvider(data.provider)
          ? data.provider
          : undefined;

      const result = await deps.apiKeyRetry.useOwnApiKey({
        stream: data.stream,
        requestId: data.requestId,
        model: data.model,
        provider: providerArg,
        exhaustionReason: data.exhaustionReason,
        viaRelay: data.viaRelay,
        kimiCodeRoutedOnFailure: data.kimiCodeRoutedOnFailure,
      });
      if (result.proceeded && !result.retried) {
        await deps.host.showInfo(
          'Switched to your own API key. There is no pending retry to resume, so run the agent again when you are ready.',
        );
      }
    },

    // ── State restore ──
    [CMD.RESTORE_STATE]: async (data) => {
      const metadata = await resolveNativeAgentRun(
        deps.getRunMetadata,
        data.stream,
        deps.host.showInfo,
        'restored',
        deps.preload,
      );
      if (!metadata) return;
      await deps.restoreRunConfig(metadata.config);
    },

    // ── Manual compaction ──
    [CMD.COMPACT_RESPONSE]: async (data) => {
      const result = deps.session.executions.requestManualCompaction(
        data.stream,
      );
      switch (result.kind) {
        case 'no_active_tool_use':
          await deps.host.showInfo(
            'No active tool-use session found for this stream.',
          );
          return;
        case 'unsupported':
          await deps.host.showInfo(
            'Manual context compaction is not available for this model yet.',
          );
          return;
        case 'requested':
          notifyFollowUpSent(result.streamId, result.session);
          await deps.host.showInfo(
            'Context compaction requested. The agent will process it on the next model call.',
          );
          return;
      }
    },

    // ── Proposal config restore ──
    [CMD.RESTORE_PROPOSAL_CONFIG]: async (data) => {
      await deps.restoreProposalConfig(data.proposal);
    },

    // ── Follow-up polish ──
    [CMD.POLISH_FOLLOW_UP]: async (data) => {
      await deps.preload?.(data.stream);
      const config = deps.getRunConfig(data.stream);
      if (!config) return;
      try {
        deps.onPolishProgress?.('Sending to AI for polishing...');
        const result = await deps.followUpPolish.polishFollowUp({
          stream: data.stream,
          text: data.text,
          runConfig: config,
        });
        deps.onPolishProgress?.('Applying changes...');
        await deps.applyPolishResult(result);
      } catch (error) {
        await deps.onPolishError(data.stream, error);
      }
    },

    // ── Compile fixer ──
    [CMD.RUN_COMPILE_FIXER]: async (data) => {
      await deps.applyFollowUpPlan(
        await deps.followUp.planCompileFixerForStream(data.stream),
      );
    },

    // Voice recording (START_RECORDING / STOP_RECORDING) is host-specific:
    // the extension wraps it in a webview-bound RecordingManager that posts
    // status messages internally; the desktop calls standalone recording
    // functions and posts status manually. Each host keeps its own pair.
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
