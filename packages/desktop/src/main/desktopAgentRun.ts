// The desktop's presentation of one project's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import { Effect, Scope, type Stream } from 'effect';

import {
  type RunEndResult,
  type HostPresentation,
  type PresentationEventHandlers,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type SessionHandle,
  type ValidatedRunRequest,
} from '@agent/runtime';
import {
  type ProcessRuntime,
  withProcessServices,
} from '@platform/processRuntime';
import type { RequestOpenFilePayload, RunId } from '@shared/schemas';
import { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import { attachSessionHost } from '@texra/controllers/session/attachSessionHost';
import type { ServiceLink } from '@texra/controllers/server/client';
import { attachWindowHost } from '@texra/controllers/server/windowHost';
import type { SessionBackend } from '@texra/controllers/session/sessionBackend';

import {
  DesktopToolEditApprovalHost,
  type DesktopToolEditApprovalUi,
} from './desktopToolEditApproval.js';
import {
  launchDesktopAgent,
  presentDesktopFinalOutput,
  type DesktopAgentLaunchOptions as DesktopRunOptions,
} from './desktopAgentLaunch.js';
import { desktopSpawner } from './desktopWindows.js';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';

export interface DesktopAgentRunOptions {
  host: DesktopAgentRunHost;
  /** Preview operations reject; the approval controller presents failures. */
  toolEditPreview: Omit<DesktopToolEditApprovalUi, 'showErrorMessage'>;
  session: SessionHandle;
  /** Where this project's runs run: the session here, or the service's. */
  backend: SessionBackend;
  /** The service, when the backend is the service's: this window serves
   *  its project's runs there with its notices and tool-edit previews. */
  service: ServiceLink | undefined;
  /** The project folder; none for the no-workspace session. */
  root: string | undefined;
  /** Emits when this window gains focus (and once at once when it has it),
   *  so the service sends the project's host calls here first. */
  focused: Stream.Stream<void>;
  /** A launch could not find its agent: the New-task state's
   *  agent-config banner (`HostSnapshot.banners`). */
  showAgentConfigBanner(data: { agentName: string }): Effect.Effect<void>;
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
  /** Launch a validated request, settling with the run itself
   *  (`HostRunActionPorts.runValidated`). It fails with the launch's own
   *  bare `Error`; a caller that needs a named channel names it. */
  runValidated(
    request: ValidatedRunRequest,
    options?: DesktopRunOptions & { readonly approveDelegatedWork?: boolean },
  ): Effect.Effect<void, Error>;
  /** Open a resumed workflow's final output, as a launch opens a fresh one's
   *  (`HostRunActionPorts.openWorkflowOutput`). */
  openWorkflowOutput(result: RunEndResult): Effect.Effect<void, Error>;
  /** The tool-edit approvals this window owns. A prompt's verbs act over its
   *  staged preview: the approval applies the proposed file as the user left
   *  it. The host arm calls `handleAction` directly, as the extension does. */
  readonly toolEditApprovals: ToolEditApprovalController;
}

/**
 * The run wiring of one project, in the scope that opens it: closing the scope
 * detaches the host interactions, stops the session-event follower and
 * settles once every staged tool-edit preview is gone.
 */
export const createDesktopAgentRun = Effect.fn('desktop.createAgentRun')(
  function* (
    options: DesktopAgentRunOptions,
  ): Effect.fn.Return<DesktopAgentRun, never, Scope.Scope> {
    const { session, backend, host, runtime } = options;

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
      showAgentConfigBanner: ({ agentName }) =>
        options.showAgentConfigBanner({ agentName }),
      // Desktop has no editor integration to preview through, so the
      // resolved path goes to the preview-with-fallback host directly.
      requestOpenFile: (data: RequestOpenFilePayload) =>
        host.openPath(data.location.absolutePath),
    };

    function handlePresentationEvent<K extends RuntimePresentationEvent>(
      event: K,
      payload: RuntimePresentationEventPayloads[K],
    ): HostPresentation {
      return presentationEventHandlers[event](payload);
    }

    // The tool-edit preview: staged copies of the original and proposed
    // content the review pane diffs. The request itself is the session's
    // (`request.opened` folds into the view), and a surface's `request.decide`
    // settles it there; the staged preview is discarded when the request
    // resolves, whichever way.
    const scope = yield* Scope.Scope;
    const spawn = desktopSpawner(runtime, scope);
    const toolEditApprovals = new ToolEditApprovalController({
      host: new DesktopToolEditApprovalHost({
        ui: {
          ...options.toolEditPreview,
          showErrorMessage: host.showErrorMessage,
        },
        spawn,
      }),
      // A decision goes where the run runs.
      session: { requests: backend },
    });
    // Dispose joins any tool-edit LaTeX build still displaying, which has no
    // cancellation signal, so the window's release must not wait on it: it
    // runs detached, as a window close never waits on a compile.
    yield* Effect.addFinalizer(() =>
      Effect.asVoid(
        Effect.forkDetach(
          withProcessServices(runtime, toolEditApprovals.dispose()),
        ),
      ),
    );
    // Attached for the window's life, before the first run of this window
    // asks anything. This host presents only the tool-edit preview; every
    // other request (bash, plan, proposal, retry, question) is listed by the
    // fold and answered by a surface's `request.decide`.
    yield* withProcessServices(
      runtime,
      attachSessionHost(session, toolEditApprovals, {
        emit: handlePresentationEvent,
      }).pipe(Scope.provide(scope)),
    );
    // A project of the service: the window serves its runs there with the
    // same notices and tool-edit previews.
    if (options.service !== undefined && options.root !== undefined)
      yield* attachWindowHost(
        options.service,
        options.root,
        {
          emit: handlePresentationEvent,
          toolEdits: {
            stage: (staging) =>
              withProcessServices(
                runtime,
                toolEditApprovals.present({ ...staging, roots: session.roots }),
              ).pipe(Effect.mapError((failure) => new Error(failure.message))),
            release: (requestId) =>
              withProcessServices(
                runtime,
                toolEditApprovals.release(requestId),
              ),
            approve: (requestId) =>
              withProcessServices(
                runtime,
                toolEditApprovals.approveStaged(requestId),
              ),
          },
        },
        options.focused,
      );

    /**
     * The launch, settling with the run. `onRunCompleted` fires on every
     * settlement, as the old `finally` did — after the launch, including
     * `setFirstRunDone`. Do not hook the run.end row: it commits
     * inside finalizeTerminal, before the flag write.
     */
    function runValidated(
      request: ValidatedRunRequest,
      runOptions: DesktopRunOptions & {
        readonly approveDelegatedWork?: boolean;
      } = {},
    ): Effect.Effect<void, Error> {
      return launchDesktopAgent(
        request,
        { session, backend, runtime },
        { onRunResolved: options.onLaunched, ...runOptions },
      ).pipe(Effect.ensuring(options.onRunCompleted ?? Effect.void));
    }

    return {
      runValidated,
      openWorkflowOutput: (result) =>
        withProcessServices(
          runtime,
          presentDesktopFinalOutput(session)(result),
        ),
      toolEditApprovals,
    };
  },
);
