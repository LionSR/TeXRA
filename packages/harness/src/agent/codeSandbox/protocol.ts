// The wire between the code sandbox host and its worker. Both sides decode
// what they receive with these schemas, once, at the message boundary; every
// guest value crosses as JSON text, so neither side ever holds the other's
// objects.

import { Schema, SchemaGetter } from 'effect';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** What the worker is started with: one script and the limits it runs under. */
export const WorkerInputSchema = Schema.Struct({
  source: Schema.String,
  /** Names the realm installs as `tools.<name>(args)`. */
  tools: Schema.Array(Schema.String),
  /** Names the realm installs as global functions: `name(...args)` issues
   *  an op named `name()` whose input is the argument list. */
  globals: Schema.Array(Schema.String),
  cpuBudgetMs: Schema.Number.check(Schema.isGreaterThan(0)),
  /** The QuickJS module the host compiled once, shared with every worker. */
  wasm: Schema.instanceOf(WebAssembly.Module),
  /** One Int32 the host sets to preempt guest code that never yields. */
  interrupt: Schema.instanceOf(SharedArrayBuffer),
});
export type WorkerInput = typeof WorkerInputSchema.Type;

/** One settlement, delivered to the realm in the order the host chooses. */
export const SettleMessageSchema = Schema.Union([
  Schema.Struct({
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ok: Schema.Literal(true),
    /** JSON text of the value; absent resolves the guest's promise with undefined. */
    json: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ok: Schema.Literal(false),
    name: Schema.String,
    message: Schema.String,
  }),
]);
export type SettleMessage = typeof SettleMessageSchema.Type;

/** JSON text from the realm, parsed into the value it encodes. */
const JsonText = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown /* TODO(effect-schema): transform target schema; was `.transform((text, ctx): unknown => { try { return JSON.parse(text) as unknown; } catch (error) { ctx.issues.push({ code: 'custom', input: text, message: `not JSON text: ${toErrorMessage(error)}`, }); return z.NEVER; } })` */,
    {
      decode: SchemaGetter.transform((text, ctx): unknown => {
        try {
          return JSON.parse(text) as unknown;
        } catch (error) {
          ctx.issues.push({
            code: 'custom',
            input: text,
            message: `not JSON text: ${toErrorMessage(error)}`,
          });
          return Schema.Unknown; /* TODO(effect-schema): z.NEVER; was `z.NEVER()` */
        }
      }),
      encode: SchemaGetter.forbidden(() => 'decode-only'),
    },
  ),
);

const IssuedOpSchema = Schema.Struct({
  /** Issue order inside the realm, from 0. */
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: Schema.String,
  /** The guest's argument, as JSON text on the wire. */
  input: JsonText,
  /** The title of the guest's latest `phase()` call when it issued this. */
  phase: Schema.NullOr(Schema.String),
});

const ScriptEndSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Returned'),
    value: Schema.optional(JsonText),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Threw'),
    name: Schema.String,
    message: Schema.String,
    stack: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('SyntaxError'),
    message: Schema.String,
  }),
  Schema.Struct({ _tag: Schema.Literal('CpuExhausted') }),
  Schema.Struct({ _tag: Schema.Literal('MemoryExhausted') }),
]);
export type ScriptEnd = typeof ScriptEndSchema.Type;

/**
 * What one step reports: the ops the guest issued while the job queue
 * drained, in issue order, the tail of the lines it logged (and how many
 * earlier ones the tail dropped), and how it ended if it did.
 */
export const StepReportSchema = Schema.Struct({
  ops: Schema.Array(IssuedOpSchema),
  logs: Schema.Array(Schema.String),
  logsDropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end: Schema.optional(ScriptEndSchema),
});
/** A report as the worker writes it, with guest values still JSON text. */
export type StepReportWire = typeof StepReportSchema.Encoded;
