/**
 * The documents plugin's row (`PLUGIN_EVENT_ARMS` in `@tools/pluginArms`): a
 * document task's documents are its latest `plugin.fact` of kind
 * `documents/output`, which carries every revision's outputs. Core stores
 * and folds the row without reading it (`RunView.facts`); this module is its
 * schema and its one reader, which hosts, webviews and the plugin's own
 * tools share. Browser-safe: it imports only schemas.
 */
import { z } from 'zod';

import {
  aggregateId,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  RunDocumentsSchema,
  type RunDocuments,
  type AggregateId,
  type SessionEvent,
  RoundKeyedOutputSidecarValueSchemas,
  RoundOutputSchema,
  type RoundOutput,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';

const DocumentsOutputSchema = z.strictObject({
  /** Every revision so far, by its zero-based `round`. */
  rounds: z.array(RoundOutputSchema),
});

/** The documents plugin's one row kind. */
export const DOCUMENTS_OUTPUT_ARM = {
  plugin: 'documents',
  kind: 'output',
  version: 1,
  schema: DocumentsOutputSchema,
  upcasters: [],
} as const;

/** The key a run's documents fold under in `RunView.facts`. */
export const DOCUMENTS_OUTPUT_KEY = `${DOCUMENTS_OUTPUT_ARM.plugin}/${DOCUMENTS_OUTPUT_ARM.kind}`;

/** The row that makes `rounds` the run's documents, for the one publisher. */
export function documentsOutputRow(
  runId: RunId,
  rounds: readonly RoundOutput[],
): SessionEventDraft {
  return {
    type: 'plugin.fact',
    aggregateId: aggregateId('run', runId),
    plugin: DOCUMENTS_OUTPUT_ARM.plugin,
    kind: DOCUMENTS_OUTPUT_ARM.kind,
    version: DOCUMENTS_OUTPUT_ARM.version,
    value: DocumentsOutputSchema.parse({ rounds }),
  };
}

/** A stored documents row's rounds; none for a value that is not one. */
export function documentRoundsOf(value: unknown): RoundOutput[] {
  return value === undefined ? [] : DocumentsOutputSchema.parse(value).rounds;
}

/** The rounds of the latest documents row of `aggregate` among `rows`;
 *  undefined when it wrote none. */
export function latestDocumentRounds(
  rows: readonly SessionEvent[],
  aggregate: AggregateId,
): RoundOutput[] | undefined {
  const row = rows.findLast(
    (event) =>
      event.aggregateId === aggregate &&
      event.type === 'plugin.fact' &&
      `${event.plugin}/${event.kind}` === DOCUMENTS_OUTPUT_KEY,
  );
  return row?.type === 'plugin.fact' ? documentRoundsOf(row.value) : undefined;
}

/** The documents a run's end reports of `rounds`: every revision's
 *  outputs and compile failures. */
export function documentsSummary(rounds: RoundOutput[]): RunDocuments {
  return RunDocumentsSchema.parse({
    outputs: roundOutputsToOutputSummaries(rounds),
    compileFailures: roundOutputsToCompileFailureSummaries(rounds),
  });
}

/** What a host shows of a run's documents, each keyed by round. */
export interface RunDocumentsView {
  readonly files: z.infer<
    typeof RoundKeyedOutputSidecarValueSchemas.outputFiles
  >;
  readonly missingOutputs: z.infer<
    typeof RoundKeyedOutputSidecarValueSchemas.missingOutputs
  >;
  readonly compileFailures: z.infer<
    typeof RoundKeyedOutputSidecarValueSchemas.compileFailures
  >;
}

/** The run's documents by round, from its latest documents row; empty for a
 *  run that is no document task. */
export function documentsOf(run: Pick<RunView, 'facts'>): RunDocumentsView {
  const rounds = documentRoundsOf(run.facts[DOCUMENTS_OUTPUT_KEY]);
  const byRound = <T>(pick: (round: RoundOutput) => readonly T[]) =>
    Object.fromEntries(
      rounds.flatMap((round) =>
        pick(round).length === 0 ? [] : [[round.round, [...pick(round)]]],
      ),
    );
  return {
    files: byRound((round) => round.outputs),
    missingOutputs: byRound((round) => round.missingOutputs),
    compileFailures: byRound((round) => round.compileFailures),
  };
}
