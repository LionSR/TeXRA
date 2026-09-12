// The desktop's presentation of one paper's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import { Cause, Effect, Exit, Fiber, Stream } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  validateRunRequest,
  type PresentationEventHandlers,
  type RunRequest,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import {
  ToolEditApprovalController,
  type ToolEditApprovalHost,
} from '@controllers/approval/ToolEditApprovalController';
import { effectRuntime } from '@platform/processRuntime';
import type {
  AgentCategory,
  RequestOpenFilePayload,
  RunId,
} from '@shared/schemas';
import { Rejected } from '@shared/session/requestErrors';

import { DesktopToolEditApprovalHost } from './desktopToolEditApproval.js';
import { toLogData } from './desktopLogUtils.js';
import {
  launchDesktopAgent,
  type DesktopAgentLaunchOptions as DesktopRunOptions,
} from './desktopAgentLaunch.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

export interface DesktopAgentRunOptions {
  host: DesktopAgentRunHost;
  /** Preview operations reject; the approval controller presents failures. */
  toolEditPreview: Pick<
    DesktopAgentRunHost,
    'openPath' | 'openBuildDisplay' | 'openDiff'
  >;
  session: SessionHandle;
  /** A run loaded an agent from the custom directory: the New-task
   *  state's agent-config banner (`HostSnapshot.banners`). */
  showAgentConfigBanner(data: {
    agentName: string;
    category: AgentCategory;
  }): void;
  /** Select the run launched by this window. */
  onLaunched?: (runId: RunId) => void;
  logger?: AgentTrace;
}

export interface DesktopAgentRun {
  /** Launch a request another host action built (a merge, a compile fix). */
  runAgentRequest(
    request: RunRequest,
    options?: DesktopRunOptions,
  ): Promise<void>;
  runValidated(
    request: ValidatedRunRequest,
    options?: DesktopRunOptions,
  ): Promise<void>;
  /** The tool-edit approvals this window owns. A prompt's verbs act over its
   *  staged preview: the approval applies the proposed file as the user left
   *  it. The host arm calls `handleAction` directly, as the extension does. */
  readonly toolEditApprovals: ToolEditApprovalController;
  dispose(): void;
}

export function createDesktopAgentRun(
  options: DesktopAgentRunOptions,
): DesktopAgentRun {
  const { session, host } = options;
  const logger = options.logger ?? createChannelTrace('DesktopAgentRun');
  // The process runtime, held once for this window's session work.
  const runtime = effectRuntime();
  let disposed = false;

  /**
   * Settle a host dialog promise, logging a rejection. The desktop dialog
   * await rejects when its window is torn down beneath it; voiding the
   * promise would leave that rejection unhandled.
   */
  async function settleHostDialog(
    dialog: Promise<unknown> | void,
    logMessage: string,
  ): Promise<void> {
    const presented = await runtime.runPromiseExit(
      Effect.tryPromise({
        try: async () => dialog,
        catch: (error) => error,
      }),
    );
    if (Exit.isFailure(presented)) {
      logger.warn(logMessage, {
        data: toLogData(Cause.squash(presented.cause)),
      });
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
      showAgentConfigBanner: ({ agentName, category }) =>
        options.showAgentConfigBanner({ agentName, category }),
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
  ): unknown {
    if (disposed) return undefined;
    return presentationEventHandlers[event](payload);
  }

  // The tool-edit preview: staged copies of the original and proposed
  // content the review pane diffs. The request itself is the session's
  // (`request.opened` folds into the view), and a surface's `request.decide`
  // settles it there; the staged preview is discarded when the request
  // resolves, whichever way.
  const decideRequest: ToolEditApprovalHost['decide'] = (
    runId,
    requestId,
    decision,
  ) =>
    runtime.runPromise(
      session.requests
        .request({ kind: 'request.decide', runId, requestId, decision })
        .pipe(Effect.asVoid),
    );
  const toolEditApprovals = new ToolEditApprovalController({
    host: new DesktopToolEditApprovalHost({
      ui: {
        ...options.toolEditPreview,
        showErrorMessage: host.showErrorMessage,
      },
      decide: decideRequest,
    }),
  });
  const sessionEvents = runtime.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => toolEditApprovals.handleSessionEvent(event)),
    ),
  );
  // Attached for the window's life, before the first run of this window
  // asks anything. This host presents only the tool-edit preview; every
  // other request (bash, plan, proposal, retry, question) is listed by the
  // fold and answered by a surface's `request.decide`.
  const detachHostInteractions = session.interactions.use({
    emit: handlePresentationEvent,
    presentToolEdit: (request) => {
      void settleHostDialog(
        toolEditApprovals.present(request),
        'Failed to stage the tool-edit preview',
      );
    },
  });

  function runValidated(
    request: ValidatedRunRequest,
    runOptions: DesktopRunOptions = {},
  ): Promise<void> {
    return launchDesktopAgent(
      { kind: 'fresh', ...request },
      { session },
      {
        onRunResolved: options.onLaunched,
        ...runOptions,
      },
    );
  }

  return {
    async runAgentRequest(request, runOptions) {
      const validated = validateRunRequest(request);
      if (!validated.valid) {
        logger.error('Invalid desktop run request', {
          data: validated.issue,
        });
        throw new Rejected({ reason: validated.message });
      }
      await runValidated(validated.request, runOptions);
    },
    runValidated,
    toolEditApprovals,
    dispose() {
      if (disposed) return;
      disposed = true;
      detachHostInteractions();
      runtime.runFork(Fiber.interrupt(sessionEvents));
      toolEditApprovals.dispose();
    },
  };
}
