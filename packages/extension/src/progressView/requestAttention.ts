/**
 * The one attention rule for a pending request in this window, whatever its
 * kind (tool edit, command, proposal, plan, question, inquiry, retry): the
 * sidebar view's badge counts the requests waiting on the user, and a new
 * one brings its run on screen without taking focus. The card stays the one
 * place to answer; nothing here decides a request.
 */
import { Effect, Stream } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';
import {
  requestAnswerability,
  type SessionView,
} from '@shared/session/sessionView';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';
import type * as vscode from 'vscode';

/** What the provider lends: its two surfaces, read at use, and its moves. */
interface AttentionSurface {
  sidebar(): vscode.WebviewView | undefined;
  panel(): vscode.WebviewPanel | undefined;
  isViewVisible(): boolean;
  /** The focus command: the only way to open a never-resolved sidebar. */
  showInSidebar(): Effect.Effect<void, Error>;
  showSessions(runId: RunId): void;
}

/** The requests the card lets this window answer (`requestAnswerability`). */
function answerableHere(view: SessionView): SessionView['requests'] {
  return view.requests.filter((request) => {
    const run = view.runs.get(request.runId);
    return (
      run !== undefined &&
      requestAnswerability(run, request.payload) === 'answerable'
    );
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
      return arrived ? this.bringForward(arrived.runId) : Effect.void;
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

  /** Reveal a hidden surface, keyboard focus left where the user is typing:
   *  a focused card's single-key answers must not catch keystrokes meant for
   *  the editor. Host calls that throw fail here, so the warning covers them
   *  and the {@link follow} fiber survives to keep the badge current. */
  private bringForward(runId: RunId): Effect.Effect<void> {
    const { surface } = this;
    const host = (call: () => void) =>
      Effect.try({ try: call, catch: ensureError });
    return Effect.gen(function* () {
      if (!surface.isViewVisible()) {
        const panel = surface.panel();
        const sidebar = surface.sidebar();
        if (panel) yield* host(() => panel.reveal(undefined, true));
        else if (sidebar) yield* host(() => sidebar.show(true));
        else yield* surface.showInSidebar();
      }
      // A surface on the New-task state opens this run, visible or just
      // revealed; one showing a session keeps it, and its run tabs mark the
      // one waiting.
      yield* host(() => surface.showSessions(runId));
    }).pipe(
      Effect.catch((failure) =>
        Effect.logWarning(
          `A waiting request could not be revealed: ${toErrorMessage(failure)}`,
        ).pipe(withLogChannel('RequestAttention')),
      ),
    );
  }
}
