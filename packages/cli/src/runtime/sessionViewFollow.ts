/**
 * What a headless CLI output reads of a session: its view, followed level by
 * level, and the one run it describes. Shared by the stderr status line
 * (`runProgressRenderer.ts`) and the plain-text workflow output
 * (`workflowPlainOutput.ts`), which are otherwise separate renderers.
 */
import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';

/** What a headless renderer reads of a session: its view. */
export type RunProgressSession = Pick<SessionHandle, 'view'>;

/**
 * The run a headless renderer describes: the run of the named run,
 * or the first top-level run created after the renderer attached (the
 * view cursor it read then). Claimed once by each renderer; a child's later
 * appearance never moves it.
 */
export function claimRootRun(
  view: SessionView,
  wantedRunId: RunId | undefined,
  attachCursor: number,
): RunId | undefined {
  const candidates = [...view.runs.values()].filter((run) =>
    wantedRunId !== undefined
      ? run.id === wantedRunId
      : run.parentId === null && run.createdAt > attachCursor,
  );
  candidates.sort((a, b) => a.createdAt - b.createdAt);
  return candidates.at(0)?.id;
}

/** Follow a view level with a callback; returns the detach. The fiber runs on
 *  the runtime the renderer was built with. */
export function followView(
  runtime: ProcessRuntime,
  session: RunProgressSession,
  onView: (view: SessionView) => void,
): () => void {
  const fiber = runtime.runFork(
    Stream.runForEach(SubscriptionRef.changes(session.view), (view) =>
      Effect.sync(() => onView(view)),
    ),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}
