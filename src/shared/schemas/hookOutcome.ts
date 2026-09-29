/**
 * The payload of a run ledger's `hook.outcome` arm (`sessionEvent.ts`): what
 * one invocation of an installed plugin's Claude Code hook did, recorded
 * through the run's one writer so a resume reuses it instead of running the
 * hook again (`2026-09-28-code-plugins-hooks-v1.md`).
 */
import { z } from 'zod';

/** The hook events TeXRA runs in v1; the protocol module parses the rest of
 *  the reference's events and ignores them. */
export const SUPPORTED_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
] as const;
const HookEventSchema = z.enum(SUPPORTED_HOOK_EVENTS);
export type HookEvent = z.infer<typeof HookEventSchema>;

/** How a hook invocation ended: `blocked` is exit code 2, `failed` any other
 *  non-zero exit whose output did not decide, `malformed` output that failed
 *  to parse or validate, `unstartable` a process that never ran. */
const HookStatusSchema = z.enum([
  'ok',
  'blocked',
  'failed',
  'timeout',
  'malformed',
  'unstartable',
]);
export type HookStatus = z.infer<typeof HookStatusSchema>;

export const HookOutcomePayloadSchema = z.strictObject({
  /** The site the hook ran at (`PreToolUse:<call id>`, `Stop:<turn>`, …):
   *  every hook of one point commits in one batch, and a recorded point is
   *  never run again. */
  point: z.string().min(1),
  event: HookEventSchema,
  /** The contributing installed plugin's id (`plugin:<name>`). */
  plugin: z.string().min(1),
  /** The handler's position in the plugin's hook configuration. */
  hook: z.string().min(1),
  durationMs: z.int().nonnegative(),
  status: HookStatusSchema,
  exitCode: z.int().nullable(),
  /** A `PreToolUse` denial's reason, as the model reads it. */
  deny: z.string().nullable(),
  /** Text the model reads beside the prompt or the tool result. */
  context: z.string().nullable(),
  /** What the hook asked for that v1 parses and does not act on. */
  ignored: z.array(z.string()).readonly(),
  /** The start of stderr, on a failure only. */
  stderr: z.string().nullable(),
});
export type HookOutcomePayload = z.infer<typeof HookOutcomePayloadSchema>;

/** A run's recorded hook outcomes by point, in commit order. */
export type HookOutcomes = Readonly<
  Record<string, readonly HookOutcomePayload[]>
>;
