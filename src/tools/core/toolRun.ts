/**
 * The run a tool call was made under, asked for once.
 *
 * `ToolCallShape.run` is absent for a standalone host invocation outside an
 * agent run, so every tool whose work is addressed to a run — it registers a
 * child under it, subscribes on it, or delivers a follow-up to it — has to
 * refuse that call. This is the one place that refusal is worded, so the model
 * reads the same sentence whichever tool it reached for.
 *
 * Host-agnostic, VS Code-free.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { ToolCallShape } from '@agent/runtime/ToolCall';
import { ToolError } from '@shared/schemas';

/** The calling run, once {@link requireToolRun} has established it. */
export type ToolRun = NonNullable<ToolCallShape['run']>;

/**
 * Narrow a tool call to one made under a run, or fail with the shared refusal.
 *
 * `toolName` names the thing that needs the run, so it can be narrower than
 * the tool itself (`'bash run_in_background'`) when only one branch asks.
 */
export function requireToolRun(
  toolName: string,
  call: ToolCallShape,
): Effect.Effect<ToolRun, ToolError> {
  return call.run
    ? Effect.succeed(call.run)
    : Effect.fail(new ToolError(`${toolName} requires an active run context.`));
}
