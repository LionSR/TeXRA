// The wire between the code sandbox host and its worker. Both sides decode
// what they receive with these schemas, once, at the message boundary; every
// guest value crosses as JSON text, so neither side ever holds the other's
// objects.

import { z } from 'zod';

/** What the worker is started with: one script and the limits it runs under. */
export const WorkerInputSchema = z.object({
  source: z.string(),
  /** Names the realm installs as `tools.<name>(args)`. */
  tools: z.array(z.string()),
  /** Names the realm installs as global functions: `name(...args)` issues
   *  an op named `name()` whose input is the argument list. */
  globals: z.array(z.string()),
  cpuBudgetMs: z.number().positive(),
  /** The QuickJS module the host compiled once, shared with every worker. */
  wasm: z.instanceof(WebAssembly.Module),
  /** One Int32 the host sets to preempt guest code that never yields. */
  interrupt: z.instanceof(SharedArrayBuffer),
});
export type WorkerInput = z.infer<typeof WorkerInputSchema>;

/** One settlement, delivered to the realm in the order the host chooses. */
export const SettleMessageSchema = z.discriminatedUnion('ok', [
  z.object({
    seq: z.int().nonnegative(),
    ok: z.literal(true),
    /** JSON text of the value; absent resolves the guest's promise with undefined. */
    json: z.string().optional(),
  }),
  z.object({
    seq: z.int().nonnegative(),
    ok: z.literal(false),
    name: z.string(),
    message: z.string(),
  }),
]);
export type SettleMessage = z.infer<typeof SettleMessageSchema>;

/** JSON text from the realm, parsed into the value it encodes. */
const JsonText = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    ctx.issues.push({
      code: 'custom',
      input: text,
      message: `not JSON text: ${error instanceof Error ? error.message : String(error)}`,
    });
    return z.NEVER;
  }
});

const IssuedOpSchema = z.object({
  /** Issue order inside the realm, from 0. */
  seq: z.int().nonnegative(),
  name: z.string(),
  /** The guest's argument, as JSON text on the wire. */
  input: JsonText,
  /** The title of the guest's latest `phase()` call when it issued this. */
  phase: z.string().nullable(),
});

const ScriptEndSchema = z.discriminatedUnion('_tag', [
  z.object({ _tag: z.literal('Returned'), value: JsonText.optional() }),
  z.object({
    _tag: z.literal('Threw'),
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  z.object({ _tag: z.literal('SyntaxError'), message: z.string() }),
  z.object({ _tag: z.literal('CpuExhausted') }),
  z.object({ _tag: z.literal('MemoryExhausted') }),
]);
export type ScriptEnd = z.output<typeof ScriptEndSchema>;

/**
 * What one step reports: the ops the guest issued while the job queue
 * drained, in issue order, the tail of the lines it logged (and how many
 * earlier ones the tail dropped), and how it ended if it did.
 */
export const StepReportSchema = z.object({
  ops: z.array(IssuedOpSchema),
  logs: z.array(z.string()),
  logsDropped: z.int().nonnegative(),
  end: ScriptEndSchema.optional(),
});
/** A report as the worker writes it, with guest values still JSON text. */
export type StepReportWire = z.input<typeof StepReportSchema>;
