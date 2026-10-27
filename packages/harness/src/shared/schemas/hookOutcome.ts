/**
 * The payload of a run history's `hook.outcome` arm (`sessionEvent.ts`): what
 * one invocation of an installed plugin's Claude Code hook did, recorded
 * through the run's one writer so a resume reuses it instead of running the
 * hook again (`2026-09-28-code-plugins-hooks-v1.md`).
 */
import { Schema } from 'effect';

/** The hook events the harness runs in v1; the protocol module parses the
 *  rest of the reference's events and ignores them. */
export const SUPPORTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
] as const;
const HookEventSchema = Schema.Literals(SUPPORTED_HOOK_EVENTS);
/**
 * One of the {@link SUPPORTED_HOOK_EVENTS}: the Claude Code hook event an
 * outcome was recorded for.
 */
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
/**
 * How one hook invocation ended; see the status schema above for what each
 * value means.
 */
export type HookStatus = typeof HookStatusSchema.Type;

/**
 * What one invocation of a plugin's hook did: where it ran, which plugin and
 * handler, how it ended, and what it told the model. The run loop commits it
 * as a `hook.outcome` row after the hook runs; a resume reads the recorded
 * point instead of running the hook again.
 */
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
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: HookStatusSchema,
  exitCode: Schema.NullOr(Schema.Int),
  /** A `PreToolUse` denial's reason, as the model reads it. */
  deny: Schema.NullOr(Schema.String),
  /** Text the model reads beside the prompt or the tool result; for a
   *  stop, the instruction its block continues the run with. */
  context: Schema.NullOr(Schema.String),
  /** What the hook asked for that v1 parses and does not act on. */
  ignored: Schema.Array(Schema.String),
  /** The start of stderr, on a failure only. */
  stderr: Schema.NullOr(Schema.String),
});
/** The decoded shape of {@link HookOutcomePayloadSchema}. */
export type HookOutcomePayload = typeof HookOutcomePayloadSchema.Type;

/** A run's recorded hook outcomes by point, in commit order. */
export type HookOutcomes = Readonly<
  Record<string, readonly HookOutcomePayload[]>
>;
