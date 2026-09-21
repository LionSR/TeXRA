/**
 * The loop side of the guard a tool declares (`ToolGuard`): the paths a call
 * writes are resolved and refused before anything is written, and the command
 * it runs goes through the session's one approval queue before the body runs.
 *
 * Both used to be calls inside the bodies, which put approval in as many homes
 * as there were shell-shaped tools and made a tool's roots its own business.
 * Here the run loop asks once, through the same `requestBashApproval` the
 * session's approval queue and its `request.opened` rows already serve, so no
 * tool opens a prompt and no tool writes a card.
 */
import { Effect } from 'effect';

import type { ToolResult } from '@shared/schemas';
import {
  buildBashApprovalRejectedResult,
  requestBashApproval,
} from '@tools/approval/bashApproval';
import {
  assertWritable,
  parseWorkingDirectory,
  resolveAndFormat,
} from '@tools/pathResolution';

import { ToolCall } from '../ToolCall';
import type { RuntimeTool, ToolServices } from '../ToolServices';

/**
 * Apply the tool's declared guard, answering the result that replaces the
 * call when the guard refuses it and `undefined` when the body may run.
 */
const guardRefusal = Effect.fn('toolUse.guard')(function* (
  tool: RuntimeTool,
  rawInput: unknown,
): Effect.fn.Return<ToolResult | undefined, unknown, ToolServices> {
  const guard = tool.guard;
  if (!guard) return undefined;
  // The guard reads the call's own validated arguments, from the same schema
  // `call` validates with. An input that schema refuses reaches no prompt and
  // no path: the `call` below re-reads it and returns the validation error,
  // which is the report.
  const parsed = tool.definition.zodSchema?.safeParse(rawInput);
  if (parsed?.success !== true) return undefined;
  const input = parsed.data as never;
  const call = yield* ToolCall;

  const writes = guard.writes?.(input) ?? [];
  if (writes.length > 0) {
    yield* Effect.try({
      try: () => {
        for (const target of writes) {
          const { path, display } = resolveAndFormat(
            call.roots,
            call.roots.workspace,
            target,
            call.workingDirectory,
          );
          assertWritable(path, display);
        }
      },
      catch: (error) => error,
    });
  }

  if (!guard.bash) return undefined;
  const command = yield* guard.bash(input);
  const decision = yield* requestBashApproval({
    command,
    // The directory the approved command runs in, resolved the one way every
    // gated tool resolves it: the call's working directory when it named one,
    // the session's workspace otherwise.
    cwd: parseWorkingDirectory(call.workingDirectory) ?? call.roots.workspace,
  });
  return decision.action === 'approve'
    ? undefined
    : buildBashApprovalRejectedResult(command, decision);
});

/** One call, guard first: the declared guard's refusal, else the tool's body. */
export const guardedToolCall = (
  tool: RuntimeTool,
  rawInput: unknown,
): Effect.Effect<ToolResult, unknown, ToolServices> =>
  guardRefusal(tool, rawInput).pipe(
    Effect.flatMap((refusal) =>
      refusal ? Effect.succeed(refusal) : tool.call(rawInput),
    ),
  );
