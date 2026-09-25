/**
 * The one attention rule for a pending request in this window, whatever its
 * kind (tool edit, command, proposal, plan, question, inquiry, retry): the
 * sidebar view's badge counts the requests waiting on the user, and one that
 * arrives while no surface shows reveals its run without taking focus. The
 * card stays the one place to answer; nothing here decides a request.
 */
import type * as vscode from 'vscode';
import { Effect, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import { requestParksItsCaller, type RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

/** What the provider lends: its two surfaces, read at use, and its moves. */
interface AttentionSurface {
  sidebar(): vscode.WebviewView | undefined;
  panel(): vscode.WebviewPanel | undefined;
  isViewVisible(): boolean;
  /** The focus command: the only way to open a never-resolved sidebar. */
  showInSidebar(): Effect.Effect<void, Error>;
  showSessions(runId: RunId): void;
}

/** A parked caller is answerable only while this window holds its run
 *  (`SessionRequests.decide`); an inquiry, at any time. */
function answerableHere(view: SessionView): SessionView['requests'] {
  return view.requests.filter((request) => {
    const run = view.runs.get(request.runId);
    if (run === undefined || run.readOnly) return false;
    return run.approval === 'own' || !requestParksItsCaller(request.payload);
  });
}

export class RequestAttention {
  private badge: vscode.ViewBadge | undefined;

  constructor(private readonly surface: AttentionSurface) {}

  /** A newly resolved sidebar view starts with the current count. */
  paint(view: vscode.WebviewView): void {
    view.badge = this.badge;
  }

  follow(session: Pick<SessionHandle, 'viewChanges'>): Effect.Effect<void> {
    // Unseeded: the first view is what was already pending when the window
    // subscribed, which the badge shows and nothing reveals.
    let known: ReadonlySet<string> | undefined;
    return Stream.runForEach(session.viewChanges, (view) => {
      const open = answerableHere(view);
      const key = (r: (typeof open)[number]) => `${r.runId}/${r.requestId}`;
      const arrived = known && open.find((r) => !known?.has(key(r)));
      known = new Set(open.map(key));
      this.setCount(open.length);
      return arrived && !this.surface.isViewVisible()
        ? this.revealWithoutFocus(arrived.runId)
        : Effect.void;
    });
  }

  private setCount(count: number): void {
    if (count === (this.badge?.value ?? 0)) return;
    this.badge =
      count === 0
        ? undefined
        : {
            value: count,
            tooltip: `${formatResultCount(count, 'request')} waiting for you`,
          };
    const sidebar = this.surface.sidebar();
    if (sidebar) this.paint(sidebar);
  }

  /** Keyboard focus stays where the user is typing: a focused card's
   *  single-key answers must not catch keystrokes meant for the editor. */
  private revealWithoutFocus(runId: RunId): Effect.Effect<void> {
    const { surface } = this;
    return Effect.gen(function* () {
      const panel = surface.panel();
      const sidebar = surface.sidebar();
      if (panel) panel.reveal(undefined, true);
      else if (sidebar) sidebar.show(true);
      else yield* surface.showInSidebar();
      // A surface on the New-task state opens this run; one showing a
      // session keeps it, and its run tabs mark the one waiting.
      surface.showSessions(runId);
    }).pipe(
      Effect.catch((failure) =>
        Effect.logWarning(
          `A waiting request could not be revealed: ${toErrorMessage(failure)}`,
        ).pipe(withLogChannel('RequestAttention')),
      ),
    );
  }
}
