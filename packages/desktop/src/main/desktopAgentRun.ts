// The desktop's presentation of one project's session and its launch path.
//
// The session's facts reach the renderer through the fold and the framer;
// what remains host-side is what a session asks its host to do with no
// renderer in the loop: the runtime's presentation events (an error dialog,
// an instruction with actions, a file to open when a run finishes) and the
// tool-edit preview a request stages on disk. Decisions never pass through
// here: a surface answers an approval with `runtime.request`, and the
// session settles the pending request itself.

import { Effect, Fiber, Scope, type Stream } from 'effect';

import { type Run } from '@texra-ai/harness';
import {
  type ProcessRuntime,
  withProcessServices,
  type HostPresentation,
  type RuntimePresentationEvent,
  type RuntimePresentationEventPayloads,
  type PresentationEventHandlers,
} from '@texra-ai/harness/host';
import { AppSignals } from '@texra-ai/harness/host';
import { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import { attachWindowHost } from '@texra/controllers/server/windowHost';

import {
  DesktopToolEditApprovalHost,
  type DesktopToolEditApprovalUi,
} from './desktopToolEditApproval.js';
import { presentDesktopFinalOutput } from './desktopAgentLaunch.js';
import { desktopSpawner } from './desktopWindows.js';
import type {
  RunEndResult,
  RequestOpenFilePayload,
  RunId,
  AgentConfig,
} from '@texra-ai/harness/schemas';
import type { DesktopAgentRunHost } from './desktopAgentRunHost.js';
import type { DesktopProject } from './desktopProjects.js';

export interface DesktopAgentRunOptions {
  host: DesktopAgentRunHost;
  /** Preview operations reject; the approval controller presents failures. */
  toolEditPreview: Omit<DesktopToolEditApprovalUi, 'showErrorMessage'>;
  /** The project whose runs this window presents: its session here, or the
   *  service's, whose runs the window serves with its notices and tool-edit
   *  previews. */
  project: DesktopProject;
  /** Emits when this window gains focus (and once at once when it has it),
   *  so the service sends the project's host calls here first. */
  focused: Stream.Stream<void>;
  /** Whether the window is focused and shows this project now. */
  isFocused(): boolean;
  /** A launch could not find its agent: the New-task state's
   *  agent-config banner (`HostSnapshot.banners`). */
  showAgentConfigBanner(data: { agentName: string }): Effect.Effect<void>;
  /** Select the run launched by this window. */
  onLaunched?: (runId: RunId) => void;
  /** The process runtime this window was handed; the run and its approval
   *  wiring settle on it. */
  runtime: ProcessRuntime;
  /** Runs when a run this window launched ends: after `AgentRunLifecycle`
   *  writes `firstRunDone` on a successful run, so the host can recompute
   *  the onboarding funnel from the updated flag. Do not hook the run.end
   *  row: it commits inside finalizeTerminal, before the flag write. */
  onRunCompleted?: Effect.Effect<void>;
}

/** The window's side of its run actions (`HostRunActionPorts`). */
export interface DesktopAgentRun {
  /** Select a run this window launched, and refresh the funnel when it
   *  ends (`HostRunActionPorts.launched`). */
  launched(run: Run): Effect.Effect<void>;
  /** The window's scope, which what its runs do when they end lives in
   *  (`HostRunActionPorts.scope`). */
  readonly scope: Scope.Scope;
  /** Open a settled run's final output
   *  (`HostRunActionPorts.openFinalOutput`). */
  openFinalOutput(
    config: AgentConfig,
    result: RunEndResult,
  ): Effect.Effect<void, Error>;
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
    const { project, host, runtime } = options;

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
      requestShowError: ({ message, docsPage }) =>
        host.showErrorDialog(message, docsPage),
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
    // content the review pane diffs, for each tool edit the project's
    // session lists, here or in the service.
    const scope = yield* Scope.Scope;
    const spawn = desktopSpawner(runtime, scope);
    const toolEditApprovals = new ToolEditApprovalController({
      host: new DesktopToolEditApprovalHost({
        ui: {
          ...options.toolEditPreview,
          showErrorMessage: host.showErrorMessage,
        },
        spawn,
        focused: options.isFocused,
      }),
      session: project.session,
      roots: project.roots,
    });
    // Its close waits for a tool-edit LaTeX build still displaying, which
    // has no cancellation signal, so the window's release does not wait on
    // it: a window close never waits on a compile.
    const previews = yield* Effect.forkDetach(
      withProcessServices(runtime, toolEditApprovals.follow),
    );
    yield* Effect.addFinalizer(() =>
      Effect.asVoid(Effect.forkDetach(Fiber.interrupt(previews))),
    );
    // Attached for the window's life, before the first run of this window
    // asks anything. Every request (bash, plan, proposal, retry, question,
    // tool edit) is listed by the fold and answered by a surface's
    // `request.decide`.
    if (project.service === undefined)
      yield* project.session.attach({ emit: handlePresentationEvent });
    // A project of the service: the window presents its own failures, and
    // serves the project's runs there with the same notices.
    else {
      yield* Effect.acquireRelease(
        project.present.use({ emit: handlePresentationEvent }),
        (detach) => Effect.sync(detach),
      );
      const signals = yield* withProcessServices(runtime, AppSignals);
      yield* attachWindowHost(
        project.service,
        project.root,
        {
          emit: handlePresentationEvent,
          // What a service task wrote, told here as a task here tells it:
          // the file tree follows it.
          filesWritten: (absolutePaths) =>
            signals.emit('workspaceFilesWritten', {
              absolutePaths: [...absolutePaths],
            }),
        },
        options.focused,
      );
    }

    return {
      launched: (run) =>
        Effect.sync(() => options.onLaunched?.(run.runId)).pipe(
          Effect.andThen(
            Effect.forkIn(
              run.result.pipe(
                Effect.ignore,
                Effect.ensuring(options.onRunCompleted ?? Effect.void),
              ),
              scope,
            ),
          ),
          Effect.asVoid,
        ),
      scope,
      openFinalOutput: (config, result) =>
        withProcessServices(
          runtime,
          presentDesktopFinalOutput(project, config)(result),
        ),
      toolEditApprovals,
    };
  },
);
