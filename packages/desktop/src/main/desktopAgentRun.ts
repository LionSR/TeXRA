// The desktop's presentation of one paper's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import { Cause, Effect, Fiber, Stream } from 'effect';

import {
  validateRunRequest,
  type HostPresentation,
  type PresentationEventHandlers,
  type RunRequest,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { RunLaunchFailed } from '@controllers/session/hostRunActions';
import { withLogChannel } from '@logger/effectLog';
import {
  type ProcessRuntime,
  withProcessServices,
} from '@platform/processRuntime';
import type {
  AgentCategory,
  RequestOpenFilePayload,
  RunId,
} from '@shared/schemas';
import {
  isRequestRefusal,
  Rejected,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  DesktopToolEditApprovalHost,
  type DesktopToolEditApprovalUi,
} from './desktopToolEditApproval.js';
import {
  launchDesktopAgent,
  type DesktopAgentLaunchOptions as DesktopRunOptions,
} from './desktopAgentLaunch.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

const CHANNEL = 'DesktopAgentRun';

export interface DesktopAgentRunOptions {
  host: DesktopAgentRunHost;
  /** Preview operations reject; the approval controller presents failures. */
  toolEditPreview: Omit<DesktopToolEditApprovalUi, 'showErrorMessage'>;
  session: SessionHandle;
  /** A launch could not find its agent: the New-task state's
   *  agent-config banner (`HostSnapshot.banners`). */
  showAgentConfigBanner(data: {
    agentName: string;
    category: AgentCategory;
  }): Effect.Effect<void>;
  /** Select the run launched by this window. */
  onLaunched?: (runId: RunId) => void;
  /** The process runtime this window was handed; the run and its approval
   *  wiring settle on it. */
  runtime: ProcessRuntime;
  /** Runs when a launch this window started settles. That is after
   *  `AgentRunLifecycle` writes `firstRunDone` on a successful run, so the
   *  host can recompute the onboarding funnel from the updated flag. The
   *  refresh is idempotent and runs on every settle. */
  onRunCompleted?: Effect.Effect<void>;
}

export interface DesktopAgentRun {
  /**
   * Launch a request another host action built (a merge, a compile fix). The
   * Effect settles with the launched run itself, as the port contract in
   * `HostRunActionPorts.runAgentRequest` states, and fails in that port's
   * channel: a refusal as itself, every other launch failure as
   * `RunLaunchFailed` carrying the launch's own error.
   */
  runAgentRequest(
    request: RunRequest,
    options?: DesktopRunOptions,
  ): Effect.Effect<void, RequestRefusal | RunLaunchFailed>;
  /** The same launch for a request that is already validated. It still fails
   *  with the launch's own bare `Error`; a caller that needs a named channel
   *  names it, as `runAgentRequest` does. */
  runValidated(
    request: ValidatedRunRequest,
    options?: DesktopRunOptions,
  ): Effect.Effect<void, Error>;
  /** The tool-edit approvals this window owns. A prompt's verbs act over its
   *  staged preview: the approval applies the proposed file as the user left
   *  it. The host arm calls `handleAction` directly, as the extension does. */
  readonly toolEditApprovals: ToolEditApprovalController;
  dispose(): void;
}

export function createDesktopAgentRun(
  options: DesktopAgentRunOptions,
): DesktopAgentRun {
  const { session, host, runtime } = options;
  let disposed = false;

  /**
   * Each arm answers with the program that presents its notice; the session
   * forks it, so nothing here settles a dialog on a fiber of its own. Where
   * the failure is reported depends on the arm: the two dialog members
   * report their own (a dialog rejects when its window is torn down beneath
   * it, and the host binds them through `awaitOrReport`), so the programs
   * they hand back cannot fail; `openPath` fails in its own channel and the
   * session's fork warn-logs it.
   */
  const presentationEventHandlers: PresentationEventHandlers<
    RuntimePresentationEventPayloads,
    HostPresentation
  > = {
    // The desktop shell keeps the conversation canvas permanently on
    // screen, so there is no separate progress surface to reveal.
    requestEnsureProgressView: () => undefined,
    requestShowError: ({ message, docsCommand }) =>
      host.showErrorDialog(message, docsCommand),
    // An instruction is actionable guidance, not a failure, so it uses
    // the info-style dialog with each action token as a real button.
    requestShowInstruction: (instruction) =>
      host.showInstructionDialog(instruction.message, instruction.actions),
    showAgentConfigBanner: ({ agentName, category }) =>
      options.showAgentConfigBanner({ agentName, category }),
    // Desktop has no editor integration to preview through, so the
    // resolved path goes to the preview-with-fallback host directly.
    requestOpenFile: (data: RequestOpenFilePayload) =>
      host.openPath(data.location.absolutePath),
  };

  function handlePresentationEvent<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): HostPresentation {
    if (disposed) return undefined;
    return presentationEventHandlers[event](payload);
  }

  // The tool-edit preview: staged copies of the original and proposed
  // content the review pane diffs. The request itself is the session's
  // (`request.opened` folds into the view), and a surface's `request.decide`
  // settles it there; the staged preview is discarded when the request
  // resolves, whichever way.
  const toolEditApprovals = new ToolEditApprovalController({
    host: new DesktopToolEditApprovalHost({
      ui: {
        ...options.toolEditPreview,
        showErrorMessage: host.showErrorMessage,
      },
      decide: (runId, requestId, decision) =>
        session.requests
          .request({ kind: 'request.decide', runId, requestId, decision })
          .pipe(Effect.asVoid),
      runtime,
    }),
  });
  const sessionEvents = runtime.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      toolEditApprovals.handleSessionEvent(event),
    ),
  );
  // Attached for the window's life, before the first run of this window
  // asks anything. This host presents only the tool-edit preview; every
  // other request (bash, plan, proposal, retry, question) is listed by the
  // fold and answered by a surface's `request.decide`.
  const detachHostInteractions = runtime.runSync(
    session.interactions.use({
      emit: handlePresentationEvent,
      // Staging runs on a fiber of this window's runtime: the session hands
      // the request over and does not wait, and a staging failure is logged
      // here rather than left to a fiber nobody reads.
      presentToolEdit: (request) => {
        runtime.runFork(
          toolEditApprovals
            .present(request)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning('Failed to stage the tool-edit preview').pipe(
                  Effect.annotateLogs({ data: Cause.squash(cause) }),
                  withLogChannel(CHANNEL),
                ),
              ),
            ),
        );
      },
      // An open that never committed leaves the staged preview with no
      // decision to release it; this is that release, composed rather than
      // run so the session's own fiber waits for the diff view and the temp
      // files behind it to go. The controller's programs take this window's
      // services from the runtime's context, which the session that composes
      // them does not carry.
      releaseToolEdit: (requestId) =>
        withProcessServices(runtime, toolEditApprovals.release(requestId)),
    }),
  );

  /**
   * The launch, settling with the run. `onRunCompleted` fires on every
   * settlement, as the old `finally` did — after the launch, including
   * `setFirstRunDone`. Do not hook session.onResult: that fires from run.end
   * inside finalizeTerminal, before the flag write.
   */
  function runValidated(
    request: ValidatedRunRequest,
    runOptions: DesktopRunOptions = {},
  ): Effect.Effect<void, Error> {
    return launchDesktopAgent(
      { kind: 'fresh', ...request },
      { session, runtime },
      {
        onRunResolved: options.onLaunched,
        ...runOptions,
      },
    ).pipe(Effect.ensuring(options.onRunCompleted ?? Effect.void));
  }

  return {
    runAgentRequest(request, runOptions) {
      const validated = validateRunRequest(request);
      if (!validated.valid) {
        return Effect.logError('Invalid desktop run request').pipe(
          Effect.annotateLogs({ data: validated.issue }),
          withLogChannel(CHANNEL),
          Effect.andThen(
            Effect.fail(new Rejected({ reason: validated.message })),
          ),
        );
      }
      // The launch program still fails with a bare `Error`, so the port's
      // one channel is named here, as the extension's binding names it.
      return runValidated(validated.request, runOptions).pipe(
        Effect.mapError((cause) =>
          isRequestRefusal(cause)
            ? cause
            : new RunLaunchFailed({
                message: toErrorMessage(cause),
                cause,
              }),
        ),
      );
    },
    runValidated,
    toolEditApprovals,
    dispose() {
      if (disposed) return;
      disposed = true;
      detachHostInteractions();
      runtime.runFork(Fiber.interrupt(sessionEvents));
      runtime.runFork(toolEditApprovals.dispose());
    },
  };
}
