/**
 * The documents plugin's rows (its `arms`, `@tools/plugins`): a
 * document task's documents are its latest `plugin.fact` of kind
 * `documents/output`, which carries every revision's outputs, and the files
 * a run last accepted into the workspace are its `documents/accepted`. Core
 * stores and folds the rows without reading them (`RunView.facts`); this
 * module is their schemas and their one reader, which hosts, webviews and the
 * plugin's own tools share. It also holds the `task:` block of an agent
 * file the plugin owns (`DOCUMENT_TASK_BLOCK`), which the catalog scans
 * with. Browser-safe: it imports only schemas.
 */
import { z } from 'zod';

import {
  DEFAULT_TOOL_CONFIG,
  ToolConfigFieldsSchema,
  type AggregateId,
  type SessionEvent,
  type ToolFact,
} from '@shared/schemas';
import {
  DocumentDiffsSchema,
  DocumentsResultSchema,
  RoundKeyedOutputSidecarValueSchemas,
  RoundOutputSchema,
  roundOutputsToCompileFailureSummaries,
  roundOutputsToOutputSummaries,
  type DocumentDiffs,
  type DocumentsResult,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import type { RunView } from '@texra-ai/harness';
import type { AgentConfig } from '@texra-ai/harness/schemas';
import type { AgentBlock } from '@texra-ai/harness/plugins';

const DocumentsOutputSchema = z.strictObject({
  /** Every revision so far, by its zero-based `round`. */
  rounds: z.array(RoundOutputSchema),
  /** The proposed revision's diffs, once the task proposed: the one record
   *  of them, which its run's result is derived from. Optional, so a row
   *  written before the task proposed (or a v1 row) reads as it was
   *  written. */
  ...DocumentDiffsSchema.shape,
});

/** The documents plugin's one row kind. */
export const DOCUMENTS_OUTPUT_ARM = {
  plugin: 'documents',
  kind: 'output',
  // v2: a proposed task's fact carries its `diffs` (no upcaster: a v1 fact
  // reads as is, and an earlier build reads a v2 one as a newer build's).
  version: 2,
  schema: DocumentsOutputSchema,
  upcasters: [],
} as const;

/** The key a run's documents fold under in `RunView.facts`. */
export const DOCUMENTS_OUTPUT_KEY = `${DOCUMENTS_OUTPUT_ARM.plugin}/${DOCUMENTS_OUTPUT_ARM.kind}`;

/** The fact that makes `rounds` (and, once proposed, the final `diffs`)
 *  the calling run's documents, for its call's result (`ToolResult.facts`). */
export function documentsOutputFact(
  rounds: readonly RoundOutput[],
  diffs: DocumentDiffs = {},
): ToolFact {
  return {
    plugin: DOCUMENTS_OUTPUT_ARM.plugin,
    kind: DOCUMENTS_OUTPUT_ARM.kind,
    version: DOCUMENTS_OUTPUT_ARM.version,
    value: DocumentsOutputSchema.parse({ rounds, ...diffs }),
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

/** The documents a run's end reports of its documents fact: every
 *  revision's outputs and compile failures, and the proposed diffs. */
export function documentsSummary(fact: ToolFact): DocumentsResult {
  const { rounds, ...diffs } = DocumentsOutputSchema.parse(fact.value);
  return DocumentsResultSchema.parse({
    outputs: roundOutputsToOutputSummaries(rounds),
    compileFailures: roundOutputsToCompileFailureSummaries(rounds),
    ...diffs,
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

/**
 * A document task: what the documents recipe runs over its persona. Each
 * request (Nunjucks) opens one revision, in order, after the `prefix` that
 * lays out the documents; `outputs` are the files a task writes when the
 * launch names none, and `files` binds template variables to files beside
 * the YAML (`X` renders as `X_FILE` and `X_CONTENT`).
 */
const DocumentTaskSchema = z.strictObject({
  /** Edits existing documents (diffed against them), rather than writing
   *  new ones. */
  rewrite: z.boolean().prefault(true),
  outputs: z.array(z.string()).prefault([]),
  files: z.record(z.string(), z.string()).prefault({}),
  prefix: z.string().prefault(''),
  requests: z.array(z.string()).min(1, 'a task needs at least one request'),
});
/** A document task with its defaults applied. */
export type DocumentTask = z.infer<typeof DocumentTaskSchema>;

/** The `task:` block of an agent file, owned by the documents plugin. */
export const DOCUMENT_TASK_BLOCK: AgentBlock<DocumentTask> = Object.freeze({
  key: 'task',
  schema: DocumentTaskSchema,
});

/**
 * A document task's launch options, as its recipe's run records them
 * (`script.options`) and its approval shows them (`AgentProposal.options`):
 * the figure, TeXCount and compile switches and the critic review. Built
 * from the main view's switches (`ToolConfigFieldsSchema`), so the two
 * name the same fields.
 */
export const DocumentTaskOptionsSchema =
  ToolConfigFieldsSchema.prefault(DEFAULT_TOOL_CONFIG);
/** A document task's launch options with their defaults applied. */
export type DocumentTaskOptions = z.infer<typeof DocumentTaskOptionsSchema>;

/** The options a document task's run was launched with: its recipe's
 *  `script.options`, defaults for any it does not name. */
export const documentTaskOptions = (
  config: Pick<AgentConfig, 'script'>,
): DocumentTaskOptions =>
  DocumentTaskOptionsSchema.parse(
    config.script?.kind === 'recipe' ? config.script.options : {},
  );

/** What a proposal launches, as its approval copy names it. */
export function agentProposalLabel(proposal: {
  readonly task: boolean;
  readonly options?: Readonly<Record<string, unknown>> | null;
}): string {
  if (!proposal.task) return 'agent';
  // A reflecting task also runs a critic after every revision but the last;
  // options this plugin cannot read name no critic.
  return DocumentTaskOptionsSchema.safeParse(proposal.options ?? {}).data
    ?.reflect
    ? 'document task, with critic'
    : 'document task';
}
