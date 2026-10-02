/**
 * The plain-text script progress of `texra run` (PRD
 * one-fold-three-renderers, 10.3): what the session view's script stages
 * say, printed as their lines change. It reads `SessionHandle.view` and
 * derives nothing the fold already states; it keeps only what it last
 * printed.
 */
import { Effect, type Scope, Stream, SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import {
  descendantRuns,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import { scriptStages } from '@ui/transcript';
import { formatCostUsd } from '@utils/text/stringUtils';

import { claimRootRun } from './sessionViewFollow';

/** The plain script output also subscribes the transcripts it prints,
 *  since transcript rows fold only for subscribed aggregates. */
type ScriptPlainSession = Pick<
  SessionHandle,
  'view' | 'viewChanges' | 'setTranscriptSubscriptions'
>;

interface ScriptPlainOutputOptions {
  /** The launched run when the request names it, else the first top-level
   *  run created after attach: the output prints the script runs under it. */
  readonly runId?: RunId;
  readonly writeLine: (line: string) => void;
  readonly beforeWrite?: () => void;
}

/** The lines a run's script stages say (`scriptStages`): each phase's
 *  heading and each call's line, keyed by the stage, phase and call, and a
 *  background script run's outcome. */
function scriptPlainLines(
  run: RunView,
  view: SessionView,
): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  for (const stage of scriptStages(run, view)) {
    for (const call of stage.calls) {
      if (call.phase !== null)
        lines.set(`${stage.id}:phase:${call.phase}`, `◆ ${call.phase}`);
      lines.set(call.id, call.line);
    }
    // The stage's total once it has ended, its discarded attempts included.
    if (stage.status !== RUN_PHASE.RUNNING && stage.costUsd > 0)
      lines.set(
        `${stage.id}:total`,
        `Script total: ${formatCostUsd(stage.costUsd)}`,
      );
  }
  if (isTerminalOutcomePhase(run.status) && run.identity.kind === 'script')
    lines.set('outcome', `${run.statusLabel}: ${run.identity.title}`);
  return lines;
}

/**
 * The plain-text script progress of `texra run` (text output): what the
 * script stages of the launched run and the background script runs under it
 * say, printed as they change between consecutive view levels (PRD 10.3).
 * A line prints when its entry is new or reads differently than at the
 * previous level; nothing here folds, gates, or relabels.
 */
export function attachScriptPlainOutput(
  session: ScriptPlainSession,
  options: ScriptPlainOutputOptions,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const previous = new Map<RunId, ReadonlyMap<string, string>>();
    let subscribed = '';
    let rootRunId: RunId | undefined;
    const attachCursor = SubscriptionRef.getUnsafe(session.view).cursor;
    const write = (line: string): void => {
      options.beforeWrite?.();
      options.writeLine(line);
    };
    const printRun = (run: RunView, view: SessionView): void => {
      const before = previous.get(run.id);
      const lines = scriptPlainLines(run, view);
      previous.set(run.id, lines);
      for (const [id, line] of lines) {
        if (before?.get(id) !== line) write(line);
      }
    };
    yield* Effect.addFinalizer(() =>
      session.setTranscriptSubscriptions('script-plain-output', []),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(session.viewChanges, (view) =>
        Effect.gen(function* () {
          for (const runId of [...previous.keys()]) {
            if (!view.runs.has(runId)) previous.delete(runId);
          }
          // The view also holds every earlier run hydrated from the
          // transcript summary; only the launched run's own subtree is this
          // run's output.
          rootRunId ??= claimRootRun(view, options.runId, attachCursor);
          const root = rootRunId;
          const rootedIds =
            root === undefined
              ? undefined
              : new Set(descendantRuns(view, root, { includeRoot: true }));
          // The runs a script can run in: the launched run itself and the
          // background script runs under it.
          const scriptRuns =
            rootedIds === undefined
              ? []
              : [...view.runs.values()].filter(
                  (run) =>
                    rootedIds.has(run.id) &&
                    (run.identity?.kind === 'script' || run.id === root),
                );
          const key = scriptRuns.map((run) => run.id).join('\0');
          if (key !== subscribed) {
            subscribed = key;
            yield* session.setTranscriptSubscriptions(
              'script-plain-output',
              scriptRuns.map((run) => ({ id: run.id, fromSeq: 0 })),
            );
          }
          for (const run of scriptRuns) printRun(run, view);
        }),
      ),
      { startImmediately: true },
    );
  });
}
