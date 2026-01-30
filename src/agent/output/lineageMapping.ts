/**
 * File lineage mapping for output tracking.
 *
 * Traces the lineage of output files back to their base files,
 * enabling proper diff computation and file history tracking.
 */

import type { FileLocation } from '@shared/schemas';

import { FileLineageCalculator } from './FileLineageCalculator';
import type { OutputState } from './outputState';
import type { RoundFileMapping } from './types';

/** Traces file lineage for a round's outputs. */
export function traceFileLineage(
  state: OutputState,
  baseFiles: FileLocation[],
  currRound: number,
): RoundFileMapping {
  const currentOutputs = state.rounds.get(currRound)?.outputs ?? [];
  const prevOutputs =
    currRound > 0 ? (state.rounds.get(currRound - 1)?.outputs ?? []) : [];

  const lineageCalculator = new FileLineageCalculator(baseFiles);
  return lineageCalculator.calculateMapping(currentOutputs, prevOutputs);
}
