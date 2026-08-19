/**
 * Contract for the CLI's `--output-format ndjson` line records.
 *
 * Every headless command emits one JSON object per line through
 * {@link emitCliResult} (a few stream records directly via `writeNdjsonStdout`).
 * Each record is tagged with a `kind` discriminator and carries a command-
 * specific payload; a `ts` ISO timestamp is stamped on the way out. This file
 * is the single source of truth for that wire shape:
 *
 * - The {@link CliNdjsonRecord} type is derived from the schema, so the
 *   `ndjson` argument of every `emitCliResult` call is checked against the
 *   registered `kind` set at compile time (the previous `object` type checked
 *   nothing — a typo'd or unregistered `kind` slipped through silently).
 * - `CliNdjsonRecordContract.vitest.mts` parses representative records against
 *   {@link CliNdjsonRecordSchema}, locking the contract so downstream consumers
 *   that key on `kind` don't break under a silent rename.
 *
 * Members are intentionally *loose*: the discriminator and the primary nested
 * field are pinned, but extra keys pass through. Several commands spread a
 * typed payload at the top level (`{ kind: 'auth-status', ...profile }`) and
 * `ts` is added downstream, so over-constraining here would reject valid output
 * and break headless byte-parity for no contract gain. The value is in the
 * exhaustive, named `kind` registry, not in re-validating each payload field.
 */

// Third-party imports
import { z } from 'zod';

/** A payload field carried verbatim from the command (already shaped upstream). */
const payload = z.unknown();

export const CliNdjsonRecordSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('agent'), agent: payload }),
  z.looseObject({ kind: z.literal('agent-roster'), roster: payload }),
  z.looseObject({ kind: z.literal('config'), config: payload }),
  z.looseObject({ kind: z.literal('tool-status'), tool: payload }),
  z.looseObject({ kind: z.literal('tool-toggle'), tool: payload }),
  z.looseObject({ kind: z.literal('tool-guide'), guide: payload }),
  z.looseObject({ kind: z.literal('version'), version: z.string() }),
  z.looseObject({ kind: z.literal('model'), model: payload }),
  z.looseObject({ kind: z.literal('model-catalog'), model: payload }),
  z.looseObject({ kind: z.literal('models-enabled'), models: payload }),
  z.looseObject({ kind: z.literal('model-enabled'), model: payload }),
  z.looseObject({ kind: z.literal('memory'), memory: payload }),
  z.looseObject({ kind: z.literal('memory-detail') }),
  z.looseObject({ kind: z.literal('auth') }),
  z.looseObject({ kind: z.literal('auth-status') }),
  z.looseObject({ kind: z.literal('init-config'), init: payload }),
  z.looseObject({ kind: z.literal('chatgpt-auth') }),
  z.looseObject({ kind: z.literal('chatgpt-auth-status') }),
  z.looseObject({ kind: z.literal('grok-auth') }),
  z.looseObject({ kind: z.literal('grok-auth-status') }),
  z.looseObject({ kind: z.literal('history-entry'), entry: payload }),
  z.looseObject({ kind: z.literal('history-detail'), detail: payload }),
  z.looseObject({ kind: z.literal('history-delete'), result: payload }),
  z.looseObject({ kind: z.literal('multi-agent-result') }),
  z.looseObject({ kind: z.literal('multi-agent-preset'), preset: payload }),
  z.looseObject({
    kind: z.literal('multi-agent-preset-inspection'),
    plan: payload,
  }),
  z.looseObject({ kind: z.literal('agent-result'), result: payload }),
  z.looseObject({ kind: z.literal('result'), result: payload }),
  z.looseObject({ kind: z.literal('skill'), skill: payload }),
  z.looseObject({ kind: z.literal('skill-issue'), issue: payload }),
  z.looseObject({ kind: z.literal('doctor-check') }),
  z.looseObject({ kind: z.literal('doctor-summary') }),
  z.looseObject({ kind: z.literal('progress') }),
  z.looseObject({ kind: z.literal('log') }),
]);

/** A single `--output-format ndjson` line record. */
export type CliNdjsonRecord = z.infer<typeof CliNdjsonRecordSchema>;
