// What the project rail does across every open project: a row's `+` and `⋯`
// actions, the seen record of the conversation on screen, the Files toggle,
// and reopening a collapsed rail when a request lands off screen.

import type { createSessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import { postMessage } from '@shared/hostBridge';
import type { RunId } from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import type { Shell } from '@shared/session/shell';

import { DESKTOP_PROJECT_COMMANDS } from '../shared/desktopProjectMessages';
import {
  toggleSidebar,
  type DesktopShellState,
} from '../shared/desktopShellState';
import type { RailProject } from './desktopShell';
import type { createProjectWorkbench } from './projectWorkbench';

type ProjectAction = 'new-task' | 'close';

/**
 * Record that `run` is on screen as it stands, dropping the entries of runs
 * the view no longer holds. The same state when nothing changed.
 */
function markRunSeen(
  state: DesktopShellState,
  view: SessionView,
  run: RunView,
): DesktopShellState {
  if (run.lastTimestamp === null || state.seen[run.id] === run.lastTimestamp)
    return state;
  const seen = Object.fromEntries(
    Object.entries(state.seen).filter(([id]) => view.runs.has(id as RunId)),
  );
  return { ...state, seen: { ...seen, [run.id]: run.lastTimestamp } };
}

/**
 * The top-level runs that finished after the user last had them on screen.
 * A run never recorded here was never shown in this window (it predates the
 * record, or another host launched it), so it is not news either.
 */
export function unseenRuns(
  state: DesktopShellState,
  view: SessionView,
): ReadonlySet<RunId> {
  const unseen = new Set<RunId>();
  for (const run of view.runs.values()) {
    const seen = state.seen[run.id];
    if (
      run.parentId === null &&
      run.durableOutcome !== null &&
      seen !== undefined &&
      run.lastTimestamp !== null &&
      seen < run.lastTimestamp
    )
      unseen.add(run.id);
  }
  return unseen;
}

export function createProjectRail(deps: {
  shell(): Shell;
  projects(): readonly RailProject[];
  sessions: ReturnType<typeof createSessionSurfaces>;
  workbenches: ReadonlyMap<string, ReturnType<typeof createProjectWorkbench>>;
}) {
  const { sessions, workbenches } = deps;
  const shown = () => workbenches.get(deps.shell().active);

  function selectProject(key: string): void {
    if (key !== deps.shell().active)
      postMessage(DESKTOP_PROJECT_COMMANDS.SELECT_PROJECT, { key });
  }

  /**
   * The off-screen pending requests (by request id) that have already
   * reopened the sidebar once. A user who re-collapses it mid-run must not be
   * fought on every unrelated signal change; only a newly appearing off-screen
   * request (one not in this set) reopens it again, including a new request
   * on a run whose earlier one was answered.
   */
  let sidebarRevealedForRequestIds = new Set<string>();

  return {
    selectProject,

    /** A project row's `+` and `×`: each acts on its own project, and a
     *  new task shows that project. */
    runProjectAction(key: string, action: ProjectAction): void {
      const project = workbenches.get(key);
      switch (action) {
        case 'close':
          postMessage(DESKTOP_PROJECT_COMMANDS.CLOSE_PROJECT, {
            key,
            hasUnsavedChanges: project?.editorPane.hasUnsavedChanges() ?? false,
          });
          return;
        case 'new-task':
          sessions.act(key, { kind: 'selectNew' });
          break;
      }
      selectProject(key);
    },

    /**
     * Record that the conversation on screen has been seen as it stands, so
     * a run that finishes while the user watches it is not marked unseen
     * later. Only while the window has focus: a run finishing behind another
     * app is news when the user comes back.
     */
    markShownRunSeen(): void {
      const workbench = shown();
      const session = sessions.get(deps.shell().active);
      if (!workbench || !session || !document.hasFocus()) return;
      const view = session.view$.get();
      const { selected } = session.surface$.get();
      const run = selected === null ? undefined : view.runs.get(selected);
      if (run?.parentId !== null) return;
      workbench.updateState(markRunSeen(workbench.getState(), view, run));
    },

    /**
     * Auto-reveals a collapsed sidebar when a pending request lands on a run
     * other than the one on screen, in this project or another. That is the
     * dead-end case: the request card lives on the pending run's own view
     * (one home for the decision), so a collapsed, non-viewed rail leaves
     * nothing to click (#11511 — per-call workflow review cards land on a
     * child run, not the one the user is watching). The preference belongs
     * to the shown project's surface.
     */
    revealSidebarForOffScreenRequest(): void {
      const { active } = deps.shell();
      const offScreen = deps
        .projects()
        .flatMap((project) =>
          project.view.requests
            .filter(
              (request) =>
                project.display.key !== active ||
                request.runId !== project.surface.selected,
            )
            .map((request) => request.requestId),
        );
      if (offScreen.length === 0) {
        sidebarRevealedForRequestIds = new Set();
        return;
      }
      const isNewRequest = offScreen.some(
        (id) => !sidebarRevealedForRequestIds.has(id),
      );
      sidebarRevealedForRequestIds = new Set(offScreen);
      const state = shown()?.getState();
      if (isNewRequest && state?.sidebarCollapsed) {
        sessions.act(active, {
          kind: 'workbench',
          layout: toggleSidebar(state),
        });
      }
    },
  };
}
