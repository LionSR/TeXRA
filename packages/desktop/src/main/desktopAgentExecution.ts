// The desktop's presentation of one paper's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  dispatchPresentationEvent,
  toPresentationDelivery,
  type PresentationDelivery,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
} from '@agent/runtime';
import {
  validateExecutionRequest,
  type ExecutionRequest,
  type ValidatedExecutionRequest,
} from '@agent/core/state/executionRequests';
import { prepareMainViewExecutionLaunch } from '@controllers/mainView/backend/MainViewExecutionLaunchController';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import type {
  MainViewExecuteMessage,
  RequestOpenFilePayload,
  StreamTabId,
} from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';

import { DesktopToolEditApprovalHost } from './desktopToolEditApproval.js';
import { toLogData } from './desktopLogUtils.js';
import {
  launchDesktopAgent,
  type DesktopAgentLaunchOptions as DesktopRunExecutionOptions,
} from './desktopAgentLaunch.js';
import type { DesktopAgentExecutionHost } from './desktopAgentExecutionHost.js';

export interface DesktopAgentExecutionOptions {
  host: DesktopAgentExecutionHost;
  session: SessionHandle;
  /** A run loaded an agent from the custom directory: the New-task
   *  state's agent-config banner (`HostSnapshot.banners`). */
  showAgentConfigBanner(data: { agentName: string }): void;
  logger?: AgentTrace;
}

export interface DesktopAgentExecution {
  /** Launch from the launcher's selections; every failure is a dialog. */
  handleExecute(message: MainViewExecuteMessage): Promise<void>;
  /** Launch a request another host action built (a merge, a compile fix). */
  runExecutionRequest(
    request: ExecutionRequest,
    options?: DesktopRunExecutionOptions,
  ): Promise<void>;
  runValidated(
    request: ValidatedExecutionRequest,
    options?: DesktopRunExecutionOptions,
  ): Promise<void>;
  /** The stream a launch from this window resolved to, if one is pending. */
  onLaunched(listener: (streamId: StreamTabId) => void): () => void;
  /** A tool-edit prompt's verbs over its staged preview: the approval
   *  applies the proposed file as the user left it. */
  toolEditAction(
    requestId: string,
    action:
      'approve' | 'reject' | 'openDiff' | 'previewProposed' | 'showLatexdiff',
    feedback?: string,
  ): void;
  dispose(): void;
}

export function createDesktopAgentExecution(
  options: DesktopAgentExecutionOptions,
): DesktopAgentExecution {
  const { session, host } = options;
  const logger = options.logger ?? createChannelTrace('DesktopAgentExecution');
  const launchListeners = new Set<(streamId: StreamTabId) => void>();
  let disposed = false;

  /**
   * Settle a host dialog promise and report whether it was presented. The
   * desktop dialog await rejects when its window is torn down beneath it;
   * voiding the promise would leave that rejection unhandled, and reporting
   * nothing would read as not-delivered even when the dialog did render.
   */
  async function settleHostDialog(
    dialog: Promise<unknown> | void,
    logMessage: string,
  ): Promise<boolean> {
    try {
      await dialog;
      return true;
    } catch (error) {
      logger.warn(logMessage, { data: toLogData(error) });
      return false;
    }
  }

  const presentationEventHandlers: PresentationEventHandlers<RuntimePresentationEventPayloads> =
    {
      // The desktop task shell keeps the conversation canvas permanently on
      // screen, so there is no separate progress surface to reveal.
      requestEnsureProgressView: () => undefined,
      requestShowError: ({ message }) =>
        settleHostDialog(
          host.showErrorMessage(message),
          'Failed to present the error dialog',
        ),
      requestShowInstruction: (instruction) =>
        // An instruction is actionable guidance, not a failure, so it uses
        // the info-style dialog with each action token as a real button.
        settleHostDialog(
          host.showInstructionDialog(instruction.message, instruction.actions),
          'Failed to present the instruction dialog',
        ),
      showAgentConfigBanner: ({ agentName }) => {
        options.showAgentConfigBanner({ agentName });
        return true;
      },
      requestOpenFile: (data: RequestOpenFilePayload) =>
        // Desktop has no editor integration to preview through, so the
        // resolved path goes to the preview-with-fallback host directly.
        settleHostDialog(
          host.openPath(data.location.absolutePath),
          'Failed to open requested file on desktop',
        ),
    };

  function handlePresentationEvent<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): PresentationDelivery {
    if (disposed) return false;
    return toPresentationDelivery(
      dispatchPresentationEvent(presentationEventHandlers, event, payload),
    );
  }

  // The tool-edit preview: staged copies of the original and proposed
  // content the review pane diffs. The request itself is the session's
  // (`approval.requested` folds into the view), and a surface's decision
  // settles it there; the staged preview is discarded when the request
  // resolves, whichever way.
  const toolEditApprovals = new ToolEditApprovalController({
    host: new DesktopToolEditApprovalHost({ ui: host }),
    session,
  });
  // Attached for the window's life: the runtime parks a request until a
  // host is attached, so the presentation must be there before the first
  // run of this window asks anything.
  const detachHostInteractions = session.interactions.use({
    emit: handlePresentationEvent,
    requestToolEditApproval: (request) =>
      toolEditApprovals.requestApproval(request),
    cancel: (selector) => toolEditApprovals.cancel(selector),
  });

  function runValidated(
    request: ValidatedExecutionRequest,
    runOptions: DesktopRunExecutionOptions = {},
  ): Promise<void> {
    return launchDesktopAgent(
      { kind: 'fresh', ...request },
      { session },
      {
        onStreamResolved: (streamId) => {
          for (const listener of [...launchListeners]) listener(streamId);
        },
        ...runOptions,
      },
    );
  }

  return {
    async handleExecute(message) {
      const launch = await prepareMainViewExecutionLaunch(message, host);
      // A refused launch is a Rejected response, as on the extension: the
      // surface's settle path early-returns and keeps the composer's text.
      if (launch.status === 'cancelled') {
        throw new Rejected({ reason: 'The launch was cancelled.' });
      }
      if (launch.status === 'error') {
        void host.showErrorMessage(launch.message);
        throw new Rejected({ reason: launch.message });
      }
      if (launch.infoMessage) {
        void settleHostDialog(
          host.showInfoMessage(launch.infoMessage),
          'Failed to present the launch information dialog',
        );
      }
      return runValidated(launch.request);
    },
    async runExecutionRequest(request, runOptions) {
      const validated = validateExecutionRequest(request);
      if (!validated.valid) {
        logger.error('Invalid desktop execution request', {
          data: validated.issue,
        });
        await host.showErrorMessage(validated.message);
        return;
      }
      await runValidated(validated.request, runOptions);
    },
    runValidated,
    onLaunched(listener) {
      launchListeners.add(listener);
      return () => {
        launchListeners.delete(listener);
      };
    },
    toolEditAction(requestId, action, feedback) {
      toolEditApprovals.handleAction({
        requestId,
        action,
        ...(feedback === undefined ? {} : { feedback }),
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      detachHostInteractions();
      toolEditApprovals.dispose();
      launchListeners.clear();
    },
  };
}
