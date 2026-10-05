// The desktop's presentation of one paper's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import { Effect, Scope } from 'effect';

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
import { launchOnRun } from '@texra/controllers/mainView/backend/MainViewRunLaunchController';
import { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import { attachSessionHost } from '@texra/controllers/session/attachSessionHost';

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
 * The run wiring of one paper, in the scope that opens it: closing the scope
 * detaches the host interactions, stops the session-event follower and
 * settles once every staged tool-edit preview is gone.
 */
export const createDesktopAgentRun = Effect.fn('desktop.createAgentRun')(
  function* (
    options: DesktopAgentRunOptions,
  ): Effect.fn.Return<DesktopAgentRun, never, Scope.Scope> {
    const { session, host, runtime } = options;

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
      session,
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
      const { approveDelegatedWork, ...launchOptions } = runOptions;
      return launchDesktopAgent(
        request,
        { session, runtime },
        {
          onRunResolved: options.onLaunched,
          ...launchOptions,
          onRun: launchOnRun(session.approvals, runOptions),
        },
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
