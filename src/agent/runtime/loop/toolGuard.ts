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
import { z } from 'zod';

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
import { ensureError } from '@utils/errors/errorMessage';

import { ToolCall } from '../ToolCall';
import type { RuntimeTool, ToolServices } from '../ToolServices';

const JSON_OBJECT_ARGUMENTS = z.record(z.string(), z.unknown());

/**
 * Apply the tool's declared guard, answering the result that replaces the
 * call when the guard refuses it and `undefined` when the body may run.
 */
const guardRefusal = Effect.fn('toolUse.guard')(function* (
  tool: RuntimeTool,
  rawInput: unknown,
): Effect.fn.Return<ToolResult | undefined, Error, ToolServices> {
  const guard = tool.guard;
  if (!guard) return undefined;
  // The guard reads the call's own validated arguments, from the same schema
  // `call` validates with; a tool whose parameters are a pass-through JSON
  // Schema (an MCP server's) takes a JSON object, as its `call` checks. A tool
  // that declares a guard but no schema would have the guard quietly stop
  // gating it, so it is a defect, not a skip.
  const schema =
    tool.definition.zodSchema ??
    (tool.definition.parameters ? JSON_OBJECT_ARGUMENTS : undefined);
  if (!schema)
    return yield* Effect.die(
      new Error(
        `Tool ${tool.definition.name} declares a guard but no schema: the guard has no arguments to read.`,
      ),
    );
  // An input that schema refuses reaches no prompt and no path: the `call`
  // below re-reads it and returns the validation error, which is the report.
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) return undefined;
  const input = parsed.data as never;
  const call = yield* ToolCall;

  // Resolution and the read-only-root check both reject with a `ToolError`
  // the dispatcher reports to the model, so they stay a failure rather than
  // becoming a defect.
  const targets = yield* Effect.try({
    try: () => guard.writes?.(input) ?? [],
    catch: ensureError,
  });
  for (const target of targets) {
    const { path, display } = yield* resolveAndFormat(
      call.roots,
      call.roots.workspace,
      target,
      call.workingDirectory,
    );
    yield* Effect.try({
      try: () => assertWritable(path, display),
      catch: ensureError,
    });
  }

  if (!guard.bash) return undefined;
  const command = yield* guard.bash(input);
  // The directory the approved command runs in, as the tool declared it.
  // `'unknown'`: the executor can name none, so the prompt names none rather
  // than a directory the approved command may not run in, and the call's own
  // directory is not read at all. `'workspace'`: the executor runs there
  // whatever working directory the call was given. Otherwise the call's
  // working directory when it named one and the workspace otherwise, which is
  // what a shell-shaped tool runs in.
  let cwd: string | undefined;
  if (guard.cwd === 'workspace') cwd = call.roots.workspace;
  else if (guard.cwd !== 'unknown')
    cwd = parseWorkingDirectory(call.workingDirectory) ?? call.roots.workspace;

  const decision = yield* requestBashApproval({ command, cwd });
  return decision.action === 'approve'
    ? undefined
    : buildBashApprovalRejectedResult(command, decision);
});

/** One call, guard first: the declared guard's refusal, else the tool's body. */
export const guardedToolCall = (
  tool: RuntimeTool,
  rawInput: unknown,
): ReturnType<RuntimeTool['call']> =>
  guardRefusal(tool, rawInput).pipe(
    Effect.flatMap((refusal) =>
      refusal ? Effect.succeed(refusal) : tool.call(rawInput),
    ),
  );
