/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data and workspace preparation.
 *
 * `OutputState.rounds` is the canonical live collection, keyed by round
 * index (`Map<number, RoundOutput>`). The reflection flow hydrates it from
 * the persisted `roundOutputs` array on startup via `roundsFromPersisted`
 * and projects it back to that array shape via `roundsToPersisted` before
 * each round is persisted.
 */

import type { AgentTrace, StageHandle } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { AgentWorkflowSetting } from '@agent/core/definition/AgentDataclass';
import type { RunScope } from '@agent/runtime/RunScope';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import {
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type RoundIndexed,
  type RoundOutput,
} from '@shared/schemas';
import { TaskRunFileService } from '@utils/files/taskRunStorage';
import { formatResultCount } from '@utils/text/stringUtils';

export interface OutputState {
  rounds: Map<number, RoundOutput>;
  openedOutputs: Set<string>;
  runPreparation: Promise<void> | null;
}

/**
 * The structural subset of `ReflectionServices` the output pipeline reads.
 * `OutputNode` and `runReflectionFlow` pass their services object directly —
 * never build a separate literal of this shape.
 */
export interface OutputDependencies {
  readonly setting: AgentWorkflowSetting;
  readonly config: AgentConfig;
  readonly baseFiles: FileLocation[];
  readonly logger: AgentTrace;
  readonly fileService: TaskRunFileService;
  readonly runScope: RunScope;
}

export function createOutputState(
  rounds: Map<number, RoundOutput> = new Map(),
): OutputState {
  return {
    rounds,
    openedOutputs: new Set(),
    runPreparation: null,
  };
}

/**
 * Build a live `rounds` map from the persisted array shape, keyed by each
 * entry's own `round` field (not array index) so a hydration source with
 * gaps still lands on the right round.
 */
export function roundsFromPersisted(
  rounds: RoundOutput[],
): Map<number, RoundOutput> {
  return new Map(rounds.map((round) => [round.round, round]));
}

/**
 * Project the live `rounds` map back to the persisted array shape, placing
 * each entry at its own `round` index (not insertion order) — some
 * consumers of the persisted shape (e.g. `getFilesForRound`) index it
 * positionally by round number, and a round can in principle be absent
 * without shifting the rounds after it.
 */
export function roundsToPersisted(state: OutputState): RoundOutput[] {
  const result: RoundOutput[] = [];
  for (const [round, data] of state.rounds) {
    result[round] = data;
  }
  return result;
}

export async function withOutputStage<T>(
  deps: OutputDependencies,
  label: string,
  parentStage: StageHandle | undefined,
  fn: (stage: StageHandle) => Promise<T>,
): Promise<T> {
  const stage = deps.logger.openStage(`Output: ${label}`, {
    parent: parentStage,
    skip: true,
  });
  return stage.run(() => fn(stage));
}

export function ensureRoundData(
  state: OutputState,
  round: number,
): RoundOutput {
  const existing = state.rounds.get(round);
  if (existing) return existing;
  const data: RoundOutput = {
    round,
    rawOutput: null,
    outputs: [],
    compileFailures: [],
    missingOutputs: [],
  };
  state.rounds.set(round, data);
  return data;
}

/**
 * One per-round field of every round the state holds, in the round-indexed
 * shape the run facts carry. Those facts are latest-only listing rows, so
 * each one must carry the run's whole map rather than the round just
 * finished: after a restart the cold fold keeps only the newest row.
 */
function roundIndexedBy<T>(
  state: OutputState,
  pick: (data: RoundOutput) => T[],
): RoundIndexed<T> {
  return Object.fromEntries(
    Array.from(state.rounds, ([round, data]) => [round, pick(data)]),
  );
}

export function getOutputFilesByRound(
  state: OutputState,
): RoundIndexed<OutputFileInfo> {
  return roundIndexedBy(state, (data) => data.outputs);
}

export function getCompileFailuresByRound(
  state: OutputState,
): RoundIndexed<CompileFailure> {
  return roundIndexedBy(state, (data) => data.compileFailures);
}

export function setCompileFailures(
  state: OutputState,
  round: number,
  failures: CompileFailure[],
): void {
  ensureRoundData(state, round).compileFailures = failures;
}

/**
 * Record a round's missing outputs and publish the run's whole map. Every
 * producer of a missing-output observation goes through here (or through
 * {@link reportMissingOutputs}, which adds the transcript row), so the row
 * the session stores is always the run's current state.
 */
export function publishMissingOutputs(
  state: OutputState,
  trace: AgentTrace,
  round: number,
  missing: string[],
): void {
  ensureRoundData(state, round).missingOutputs = missing;
  emitRunFact(trace, 'updateMissingOutputs', {
    filesByRound: roundIndexedBy(state, (data) => data.missingOutputs),
  });
}

/**
 * One report, two artifacts: the human-facing transcript row and the
 * `updateMissingOutputs` run fact always travel together, so the round map
 * and the transcript can never diverge.
 *
 * The `missingOutputs` domain row is the human-facing transcript log and is
 * deliberately distinct from the run fact: it carries only the round's
 * unmatched outputs and the XML file they were expected in.
 */
export function reportMissingOutputs(
  state: OutputState,
  trace: AgentTrace,
  info: {
    round: number;
    missing: string[];
    xmlFile: string | null;
  },
): void {
  const { round, missing, xmlFile } = info;
  trace.domain({
    key: 'missingOutputs',
    text: `${formatResultCount(missing.length, 'output file')} missing`,
    data: { missing, xmlFile },
  });
  publishMissingOutputs(state, trace, round, missing);
}
