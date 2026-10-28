/**
 * The documents of one document task run, by revision (`rounds`, keyed by
 * round index). A tool call rebuilds it from the latest `documents/output`
 * fact (`roundsFromPersisted`) and commits it again as that fact's array
 * (`roundsToPersisted`).
 */

import { RunFileService } from '@texra-ai/harness/plugins';
import {
  type CompileFailure,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { AgentTrace } from '@texra-ai/harness/plugins';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { AgentConfig, FileLocation } from '@texra-ai/harness/schemas';

/** A round while a tool call works on it: the persisted `RoundOutput` with
 *  its fields writable, since extraction, the disk check, the compile check
 *  and the diff each set their part of the round in place before the call
 *  commits the whole map as the fact's array. */
export type RoundState = { -readonly [K in keyof RoundOutput]: RoundOutput[K] };

export interface OutputState {
  rounds: Map<number, RoundState>;
}

/** What the output pipeline reads of the workflow run. */
export interface OutputDependencies {
  readonly config: AgentConfig;
  readonly baseFiles: FileLocation[];
  readonly logger: AgentTrace;
  readonly fileService: RunFileService;
  /** The run's session roots, held as data: the pipeline runs on the run's
   *  fiber, and nothing about a fiber names the project it works on. */
  readonly roots: WorkspaceRoots;
}

/**
 * Build a live `rounds` map from the persisted array shape, keyed by each
 * entry's own `round` field (not array index) so a hydration source with
 * gaps still lands on the right round.
 */
export function roundsFromPersisted(
  rounds: readonly RoundOutput[],
): Map<number, RoundState> {
  return new Map(rounds.map((round) => [round.round, { ...round }]));
}

/** The complete round collection, ordered by its explicit round key. */
export function roundsToPersisted(state: OutputState): RoundOutput[] {
  return [...state.rounds.values()].sort((a, b) => a.round - b.round);
}

export function ensureRoundData(state: OutputState, round: number): RoundState {
  const existing = state.rounds.get(round);
  if (existing) return existing;
  const data: RoundState = {
    round,
    outputs: [],
    compileFailures: [],
    missingOutputs: [],
    latexdiffs: [],
    reply: null,
  };
  state.rounds.set(round, data);
  return data;
}

export function setCompileFailures(
  state: OutputState,
  round: number,
  failures: CompileFailure[],
): void {
  ensureRoundData(state, round).compileFailures = failures;
}

/** Add `missing` to the round's missing outputs: every report of one
 *  extraction is kept (the round is reset when its extraction starts). */
export function reportMissingOutputs(
  state: OutputState,
  round: number,
  missing: readonly string[],
): void {
  const data = ensureRoundData(state, round);
  data.missingOutputs = [...new Set([...data.missingOutputs, ...missing])];
}
