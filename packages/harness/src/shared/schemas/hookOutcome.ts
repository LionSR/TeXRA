/**
 * The payload of a run history's `hook.outcome` arm (`sessionEvent.ts`): what
 * one invocation of an installed plugin's Claude Code hook did, recorded
 * through the run's one writer so a resume reuses it instead of running the
 * hook again.
 */
import { Schema } from 'effect';
import { NonNegativeIntSchema } from './nonNegativeInt';

/** The hook events the harness runs in v1; the protocol module parses the
 *  rest of the reference's events and ignores them. */
export const SUPPORTED_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
] as const);
const HookEventSchema = Schema.Literals(SUPPORTED_HOOK_EVENTS);
export type HookEvent = typeof HookEventSchema.Type;

/** How a hook invocation ended: `blocked` is exit code 2, `failed` any other
 *  non-zero exit whose output did not decide, `malformed` output that failed
 *  to parse or validate, `unstartable` a process that never ran. */
const HookStatusSchema = Schema.Literals([
  'ok',
  'blocked',
  'failed',
  'timeout',
  'malformed',
  'unstartable',
]);
export type HookStatus = typeof HookStatusSchema.Type;

export const HookOutcomePayloadSchema = Schema.Struct({
  /** The site the hook ran at (`PreToolUse:<call id>`, `Stop:<turn>`, …):
   *  every hook of one point commits in one batch, and a recorded point is
   *  never run again. */
  point: Schema.NonEmptyString,
  event: HookEventSchema,
  /** The contributing installed plugin's id (`plugin:<name>`). */
  plugin: Schema.NonEmptyString,
  /** The handler's position in the plugin's hook configuration. */
  hook: Schema.NonEmptyString,
  durationMs: NonNegativeIntSchema,
  status: HookStatusSchema,
  exitCode: Schema.NullOr(Schema.Int),
  /** What a `PreToolUse` hook said about the call: null when it gave no
   *  answer (or `defer`), as every other event's hook does. */
  decision: Schema.NullOr(Schema.Literals(['allow', 'deny', 'ask'])),
  /** Why, as the model reads a denial and a person reads a question. */
  reason: Schema.NullOr(Schema.String),
  /** The call's input as a `PreToolUse` hook rewrote it, kept so a resume
   *  reads it rather than running the hook again. */
  updatedInput: Schema.NullOr(Schema.JsonObject),
  /** Text the model reads beside the prompt or the tool result; for a
   *  stop, the instruction its block continues the run with. */
  context: Schema.NullOr(Schema.String),
  /** What the hook asked for that v1 parses and does not act on. */
  ignored: Schema.Array(Schema.String),
  /** The start of stderr, on a failure only. */
  stderr: Schema.NullOr(Schema.String),
});
export type HookOutcomePayload = typeof HookOutcomePayloadSchema.Type;

/** A run's recorded hook outcomes by point, in commit order. */
export type HookOutcomes = Readonly<
  Record<string, readonly HookOutcomePayload[]>
>;
