/**
 * State management for output processing.
 *
 * Manages mutable state for output files across rounds, including
 * round data and workspace preparation.
 *
 * `OutputState.rounds` is the canonical live collection, keyed by round
 * index (`Map<number, RoundOutput>`). The reflection flow hydrates it from
 * the persisted `roundOutputs` array on startup via `roundsFromPersisted`
 * and projects it back to that array shape via `roundsToPersisted` for
 * each durable `output.produced` row.
 */

import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type RoundIndexed,
  type RoundOutput,
} from '@shared/schemas';
import { RunFileService } from '@utils/files/runStorage';
import { formatResultCount } from '@utils/text/stringUtils';

export interface OutputState {
  rounds: Map<number, RoundOutput>;
  openedOutputs: Set<string>;
}

/** What the output pipeline reads of the reflection run. */
export interface OutputDependencies {
  readonly config: AgentConfig;
  readonly baseFiles: FileLocation[];
  readonly logger: AgentTrace;
  readonly fileService: RunFileService;
  /** The run's session roots, held as data: the pipeline runs on the run's
   *  fiber, and nothing about a fiber names the project it works on. */
  readonly roots: WorkspaceRoots;
}

export function createOutputState(
  rounds: Map<number, RoundOutput> = new Map(),
): OutputState {
  return {
    rounds,
    openedOutputs: new Set(),
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

/** The complete round collection, ordered by its explicit round key. */
export function roundsToPersisted(state: OutputState): RoundOutput[] {
  return [...state.rounds.values()].sort((a, b) => a.round - b.round);
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

/** Output files keyed by round for the diff pipeline. */
export function getOutputFilesByRound(
  state: OutputState,
): RoundIndexed<OutputFileInfo> {
  return Object.fromEntries(
    Array.from(state.rounds, ([round, data]) => [round, data.outputs]),
  );
}

export function setCompileFailures(
  state: OutputState,
  round: number,
  failures: CompileFailure[],
): void {
  ensureRoundData(state, round).compileFailures = failures;
}

/** Record missing outputs and their human-facing diagnostic. */
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
  ensureRoundData(state, round).missingOutputs = missing;
}
