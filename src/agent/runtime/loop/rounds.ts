/**
 * Round mode: a run in rounds, each one turn with no tools offered, which
 * the round policy of the run's category drives. The policy is a plugin
 * contribution (`ToolTable.rounds`, read once at run open): TeXRA's
 * documents plugin contributes the workflow category's
 * (`@agent/output/documentRoundPolicy`). This module is the loop's side: the
 * interface a policy implements and the round loop over the tool-use loop's
 * turn. A run in round mode is so for its whole life, chosen by its
 * category, not pinned per step (`./step`).
 *
 * - Rounds take no input: no follow-up lease, and a failed round ends the run
 *   where it stopped, so resuming it issues that round's request again.
 * - No idle between rounds: a round's turn stays open until the next round's
 *   opening closes it (`turn.end` in that batch) or the run halts.
 * - Threshold compaction is off, since a later round works on the earlier
 *   ones; a policy recovers an overflow itself.
 */
import { Effect, type FileSystem } from 'effect';

import type { StageHandle } from '@agent/trace';
import type { WorkspaceFs } from '@platform/rootedFs';
import type { AgentCategory, RunOutcome } from '@shared/schemas';
import type { RunHistory } from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { positionRow } from './rows';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

import type { AgentRun, AgentRunShape } from '../run/AgentRun';
import type { InputPart } from '../run/mediaInput';
import type { ModelInvoker } from '../ModelInvoker';
import type { RunCell, RunExit } from './runProgram';

/** The services a round prepares, compiles and diffs on. */
export type RoundServices =
  FileSystem.FileSystem | WorkspaceFs | ChildProcessSpawner;

/** What the tool-use loop asks of a round. */
export interface RoundTurns {
  readonly totalRounds: number;
  /** Every entry, before a round: the outputs and rejection facts the rows
   *  hold, then run-workspace preparation. */
  readonly enter: (
    state: RunState,
  ) => Effect.Effect<void, Error, RoundServices>;
  readonly stage: (index: number) => StageHandle;
  /** The user content that opens round `index`. */
  readonly open: (
    index: number,
  ) => Effect.Effect<InputPart[], Error, RoundServices>;
  /** The system text and debug coordinates of round `index`'s request. */
  readonly request: (index: number) => Effect.Effect<
    {
      readonly system: string;
      readonly round: number;
      readonly debugName: string;
    },
    Error,
    RoundServices
  >;
  /** A committed response of round `index`: the overflow retry's request
   *  (not done), or the round's output (done). `live` is false for a
   *  response a resume replays. */
  readonly afterResponse: (
    state: RunState,
    cell: RunCell,
    index: number,
    live: boolean,
  ) => Effect.Effect<
    { readonly state: RunState; readonly done: boolean },
    Error,
    RoundServices | RunHistory
  >;
}

/** A round-mode run's rounds, and what it does at a completed round. */
export interface RoundPolicy {
  readonly rounds: RoundTurns;
  /** The run's end with this outcome, or null to open the next round. */
  readonly atIdle: (state: RunState) => Effect.Effect<RunOutcome | null, Error>;
}

/**
 * A plugin's round mode for the runs of one agent category: the policy it
 * builds for a run, from the run in context, at the run's open.
 */
export interface RoundMode {
  readonly category: AgentCategory;
  readonly open: (
    run: AgentRunShape,
  ) => Effect.Effect<RoundPolicy, Error, ModelInvoker | AgentRun>;
}

/**
 * The round loop, over the tool-use loop's turn. `runTurn(cell, next)` opens
 * a round when `next` is set (closing the completed one) or the run is at a
 * fresh or halted boundary, and otherwise continues the round the rows left
 * open. The run concludes on a `turn.end` that opens no next round: the
 * fold reads it as `halted`, so a resume between it and the terminal row
 * does not open another round.
 */
export const roundLoop =
  <R>(
    { rounds, atIdle }: RoundPolicy,
    runTurn: (cell: RunCell, next: boolean) => Effect.Effect<RunExit, Error, R>,
  ) =>
  (cell: RunCell) =>
    Effect.gen(function* () {
      const { runId } = cell;
      yield* rounds.enter(yield* cell.current);
      /** The last round produced its output; its turn is still open. */
      let completed = false;
      for (;;) {
        const state = yield* cell.current;
        const idle =
          completed || state.phase === 'initial' || state.phase === 'halted';
        // A round the rows left open past a lowered total is not continued.
        if (idle || state.turn > rounds.totalRounds) {
          const finish = yield* atIdle(state);
          if (finish !== null) {
            if (state.phase === 'halted') return { state, outcome: finish };
            const halted = yield* cell.append([
              positionRow(runId, state, 'turn.end'),
            ]);
            return { state: halted, outcome: finish };
          }
        }
        const turn = yield* runTurn(cell, completed);
        // A failed or stopped round ends the run where it stopped.
        if (turn.outcome !== 'completed') return turn;
        completed = true;
      }
    });
