/**
 * The `script` tool: one JavaScript program that calls the run's tools as
 * `await tools.<name>(args)`. The program runs in the code sandbox
 * (`@agent/codeSandbox/codeSandbox`); every call it issues goes through the
 * run loop's per-call program (`ToolCall.scriptCalls`), which commits its
 * rows and, on a resume, hands back what they already settled. This tool
 * names no other tool and writes no row.
 */
import * as NodeWorker from '@effect/platform-node/NodeWorker';
import { Data, Duration, Effect, Layer } from 'effect';
import { z } from 'zod';

import {
  CodeSandbox,
  type ScriptOp,
  type ScriptSettlement,
} from '@agent/codeSandbox/codeSandbox';
import { ToolCall } from '@agent/runtime/ToolCall';
import { ToolError, type ToolResultPayload } from '@shared/schemas';
import { executed } from '@tools/core/result';

import { defineTool } from '../core/define';

/** Most calls one script may issue; a resume reissues the same ones. */
const SCRIPT_CALL_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** How many guest stack frames a script failure keeps. */
const FAULT_FRAMES = 3;

const ScriptInputSchema = z.strictObject({
  code: z
    .string()
    .min(1, 'code is required')
    .describe(
      'The body of an async JavaScript function: `await` at top level, `return` the result. Inputs are literals in the code.',
    ),
  title: z
    .string()
    .nullish()
    .describe('A short title for the script, shown on its card.'),
  run_in_background: z
    .boolean()
    .nullish()
    .describe('Not supported yet: a script runs in the foreground.'),
  timeoutMs: z
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .nullish()
    .describe(
      'Wall-clock limit in milliseconds, tool calls included: 1 s to 24 h, default 60 min.',
    ),
});
type ScriptInput = z.infer<typeof ScriptInputSchema>;

/** A call's result ended the turn: the script ends with it. */
class EndedTurn extends Data.TaggedError('EndedTurn')<{
  readonly result: Extract<ToolResultPayload['result'], { status: 'executed' }>;
}> {}

/** What the guest's `await` gets from a settled call. */
const settlementOf = (
  result: ToolResultPayload['result'],
): Effect.Effect<ScriptSettlement, EndedTurn> => {
  if (result.status === 'error')
    return Effect.succeed({
      _tag: 'Failure',
      name: 'ToolFailed',
      message: result.error,
    });
  if (result.endTurn === true) return Effect.fail(new EndedTurn({ result }));
  return Effect.succeed({
    _tag: 'Value',
    value: { output: result.output, summary: result.summary },
  });
};

const shown = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value, null, 2);

const runScript = Effect.fn('ScriptTool.call')(function* (input: ScriptInput) {
  if (input.run_in_background === true)
    return yield* Effect.fail(
      new ToolError(
        'run_in_background is not supported yet: run the script in the foreground.',
      ),
    );
  const { scriptCalls, hooks } = yield* ToolCall;
  if (scriptCalls === undefined)
    return yield* Effect.fail(
      new ToolError('A script runs only as a call of an agent run.'),
    );
  const sandbox = yield* CodeSandbox;
  const outcome = yield* sandbox
    .run({
      source: input.code,
      tools: scriptCalls.tools,
      timeout: Duration.millis(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      call: (op: ScriptOp) =>
        op.seq >= SCRIPT_CALL_LIMIT
          ? Effect.succeed<ScriptSettlement>({
              _tag: 'Failure',
              name: 'CallLimit',
              message: `A script may issue at most ${SCRIPT_CALL_LIMIT} calls.`,
            })
          : Effect.flatMap(scriptCalls.call(op), settlementOf),
      onLog: (lines) =>
        Effect.sync(() => hooks?.onToolOutput?.(`${lines.join('\n')}\n`)),
      onDelivered: scriptCalls.delivered,
    })
    .pipe(
      Effect.map((result) => ({ _tag: 'Returned' as const, result })),
      Effect.catchTag('EndedTurn', (ended) => Effect.succeed(ended)),
      Effect.catchTag('ScriptFault', (fault) => {
        const frames = (fault.stack ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('at '))
          .slice(0, FAULT_FRAMES);
        return Effect.fail(
          new ToolError(
            [
              `The script threw ${fault.name}: ${fault.message}`,
              ...frames,
            ].join('\n    '),
          ),
        );
      }),
    );
  if (outcome._tag === 'EndedTurn') return outcome.result;
  const { value, logs, logsOmitted } = outcome.result;
  const log =
    logs.length === 0
      ? []
      : [
          '',
          `Log (last ${logs.length} lines${logsOmitted > 0 ? `, ${logsOmitted} earlier omitted` : ''}):`,
          ...logs,
        ];
  return executed(
    [`The script returned:`, shown(value), ...log].join('\n'),
    input.title == null ? 'Script finished' : `Script finished: ${input.title}`,
  );
});

export const ScriptTool = defineTool({
  name: 'script',
  // A resume runs the script again from the top against its recorded calls:
  // each settled call is handed back from its row, never run twice.
  replay: 'safe',
  slow: true,
  description: [
    'Run a JavaScript program that calls your other tools. `code` is the body of an async function: use `await` at top level and `return` the result (JSON).',
    'Each tool you are offered, other than `script`, is `tools.<name>(args)` with the same arguments as a direct call, and resolves to `{ output, summary }`; a failed call rejects with an Error named `ToolFailed`. Use `Promise.all` to run calls together and try/catch to recover.',
    '`phase(title)` labels the calls that follow; `console.log` lines stream to the card and the last 80 return with the result.',
    'There are no timers, no `Date.now()`, no `Math.random()` and no imports: the script replays exactly after an interruption, and calls that finished are not run again.',
  ].join('\n\n'),
  schema: ScriptInputSchema,
  execute: runScript,
});

/** The code sandbox a session's scripts run in: a worker per script. */
export const codeSandboxLayer = CodeSandbox.layer.pipe(
  Layer.provide(NodeWorker.layerPlatform),
);
