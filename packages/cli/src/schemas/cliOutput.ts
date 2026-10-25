/**
 * Contract for the CLI's `--output-format ndjson` line records.
 *
 * Every headless command emits one JSON object per line through
 * {@link emitCliResult} (a few stream records directly via `writeNdjsonStdout`).
 * Each record is tagged with a `kind` discriminator and carries a command-
 * specific payload; the two keys of {@link CliNdjsonLineStampSchema} — a `ts`
 * ISO timestamp and the {@link CLI_NDJSON_CONTRACT} version (`contract`) —
 * are stamped on the way out, after the record's own keys so `kind` stays
 * first. This file is the single source of truth for that wire shape: a line
 * is one member of the union below plus that stamp.
 *
 * - The {@link CliNdjsonRecord} type is derived from the schema, so the
 *   `ndjson` argument of every `emitCliResult` call is checked against the
 *   registered `kind` set at compile time (the previous `object` type checked
 *   nothing — a typo'd or unregistered `kind` slipped through silently).
 *
 * Members are intentionally *loose*: the discriminator and the primary nested
 * field are pinned, but extra keys pass through. Several commands spread a
 * typed payload at the top level (`{ kind: 'chatgpt-auth-status', ...status }`) and
 * `ts` is added downstream, so over-constraining here would reject valid output
 * and break headless byte-parity for no contract gain. The value is in the
 * exhaustive, named `kind` registry, not in re-validating each payload field.
 */

// Third-party imports
import { Schema, Struct } from 'effect';

import {
  InstalledPluginSchema,
  RUN_OUTCOME,
  type RunOutcome,
} from '@texra-ai/harness/schemas';

/**
 * The two keys every line carries beyond the record a command builds: `ts`,
 * appended by `emitCliResult` unless the record set its own, and `contract`,
 * appended by the NDJSON sink. Declared here so the wire shape of a line is
 * this stamp over one member of the `kind` union below.
 */
const CliNdjsonLineStampSchema = Schema.Struct({
  contract: Schema.Literal(2),
  ts: Schema.String,
});

/**
 * The CLI output contract version, stamped on every NDJSON line as
 * `contract` (`version` is the `texra version` record's own field). Version 2
 * is 1.0's: `kind: "progress"` records carry a session row verbatim (`event`
 * is the row's `type`, `payload` the rest of it), results carry `runId`, and
 * `CliRunStatus` is the only renamed vocabulary.
 */
export const CLI_NDJSON_CONTRACT =
  CliNdjsonLineStampSchema.fields.contract.literal;

/** A payload field carried verbatim from the command (already shaped upstream). */
const payload = Schema.Unknown;

/**
 * An installed plugin as a run result names it: where it came from and, for
 * a fetched plugin, the commit it is pinned to.
 */
const CliPluginPinSchema = InstalledPluginSchema.mapFields(
  Struct.pick(['name', 'source', 'ref', 'commit']),
);
export type CliPluginPin = typeof CliPluginPinSchema.Type;

/**
 * The provenance an agent run's result carries beside its own fields: the
 * plugins installed when it started or resumed. Absent on a result that is
 * not a run's; the tools each step offered are the run's `tools.offered`
 * rows.
 */
const runResultPayload = Schema.StructWithRest(
  Schema.Struct({
    plugins: Schema.optional(Schema.Array(CliPluginPinSchema)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const CliNdjsonRecordSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('agent'), agent: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('agent-copy'), copy: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      kind: Schema.Literal('workspace-agents'),
      agents: payload,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('config'), config: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('version'), version: Schema.String }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('service'), service: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('task'), task: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('model'), model: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('model-catalog'), model: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('models-enabled'), models: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('model-enabled'), model: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('memory'), memory: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('memory-detail') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('init-config'), init: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('chatgpt-auth') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('chatgpt-auth-status') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(Schema.Struct({ kind: Schema.Literal('grok-auth') }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('grok-auth-status') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('history-entry'), entry: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('history-detail'), detail: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('history-delete'), result: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('team-result') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('team'), preset: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      kind: Schema.Literal('team-inspection'),
      plan: payload,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      kind: Schema.Literal('agent-result'),
      result: runResultPayload,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('result'), result: runResultPayload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('skill'), skill: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('skill-issue'), issue: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('plugin'), plugin: payload }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('doctor-check') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal('doctor-summary') }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  Schema.StructWithRest(Schema.Struct({ kind: Schema.Literal('progress') }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
  Schema.StructWithRest(Schema.Struct({ kind: Schema.Literal('log') }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
]);

/** A single `--output-format ndjson` line record. */
export type CliNdjsonRecord = typeof CliNdjsonRecordSchema.Type;

/** The run-status vocabulary the CLI prints and its history records. */
const CLI_RUN_STATUS = {
  COMPLETED: 'completed',
  INTERRUPTED: 'interrupted',
  ERROR: 'error',
} as const;

export type CliRunStatus = (typeof CLI_RUN_STATUS)[keyof typeof CLI_RUN_STATUS];

/**
 * Project the canonical outcome onto the frozen public run-status
 * vocabulary (CLI NDJSON history status, CLI display prose).
 * The only production mapping — flows and hosts must not hand-roll their
 * own. An out-of-vocabulary value (stale fixture, unparsed legacy data)
 * fails with a named error instead of an undefined-property crash
 * downstream.
 */
export function runOutcomeToCliRunStatus(outcome: RunOutcome): CliRunStatus {
  switch (outcome) {
    case RUN_OUTCOME.COMPLETED:
      return CLI_RUN_STATUS.COMPLETED;
    case RUN_OUTCOME.CANCELLED:
      return CLI_RUN_STATUS.INTERRUPTED;
    case RUN_OUTCOME.FAILED:
      return CLI_RUN_STATUS.ERROR;
    default:
      throw new Error(`Unhandled run outcome: ${String(outcome)}`);
  }
}
