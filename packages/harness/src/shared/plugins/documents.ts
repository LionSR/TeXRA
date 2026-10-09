/**
 * The documents plugin's rows (its `arms`, `@tools/plugins`): a
 * document task's documents are its latest `plugin.fact` of kind
 * `documents/output`, which carries every revision's outputs, and the files
 * a run last accepted into the workspace are its `documents/accepted`. Core
 * stores and folds the rows without reading them (`RunView.facts`); this
 * module is their schemas and their one reader, which hosts, webviews and the
 * plugin's own tools share. Browser-safe: it imports only schemas.
 */
import { z } from 'zod';

import {
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  RunDocumentsSchema,
  type RunDocuments,
  type AggregateId,
  type SessionEvent,
  RoundKeyedOutputSidecarValueSchemas,
  RoundOutputSchema,
  type RoundOutput,
  type ToolFact,
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

/** The fact that makes `rounds` the calling run's documents, for its
 *  call's result (`ToolResult.facts`). */
export function documentsOutputFact(rounds: readonly RoundOutput[]): ToolFact {
  return {
    plugin: DOCUMENTS_OUTPUT_ARM.plugin,
    kind: DOCUMENTS_OUTPUT_ARM.kind,
    version: DOCUMENTS_OUTPUT_ARM.version,
    value: DocumentsOutputSchema.parse({ rounds }),
  };
}

const DocumentsAcceptedSchema = z.strictObject({
  /** The workspace files the acceptance wrote. */
  absolutePaths: z.array(z.string()),
  /** When it wrote them, so a second acceptance of the same files is new. */
  acceptedAt: z.number(),
});

/** The files a run last accepted into the workspace, past the editor's own
 *  write path: what every process that folds the run announces
 *  (`workspaceFilesWritten`). */
export const DOCUMENTS_ACCEPTED_ARM = {
  plugin: 'documents',
  kind: 'accepted',
  version: 1,
  schema: DocumentsAcceptedSchema,
  upcasters: [],
  writes: (value: unknown): readonly string[] =>
    DocumentsAcceptedSchema.parse(value).absolutePaths,
} as const;

/** The fact that the calling run accepted `absolutePaths` at
 *  `acceptedAt`, for its call's result (`ToolResult.facts`). */
export function documentsAcceptedFact(
  absolutePaths: readonly string[],
  acceptedAt: number,
): ToolFact {
  return {
    plugin: DOCUMENTS_ACCEPTED_ARM.plugin,
    kind: DOCUMENTS_ACCEPTED_ARM.kind,
    version: DOCUMENTS_ACCEPTED_ARM.version,
    value: DocumentsAcceptedSchema.parse({
      absolutePaths: [...absolutePaths],
      acceptedAt,
    }),
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
