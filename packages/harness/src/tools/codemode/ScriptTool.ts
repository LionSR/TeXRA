/**
 * The `script` tool: one JavaScript program that calls the run's tools as
 * `await tools.<name>(args)`. The program runs in the code sandbox
 * (`@agent/codeSandbox/codeSandbox`); every call it issues goes through the
 * run loop's per-call program (`ScriptCalls`), which commits its
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
import { RUN_LOG_MAX_LINES } from '@agent/codeSandbox/limits';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  requireToolRun,
  ScriptCalls,
  type ScriptDoor,
  callerRun,
} from '@agent/runtime/RunCall';
import {
  JsonValueSchema,
  ToolError,
  type ToolFileAttachment,
  type ToolResultPayload,
} from '@shared/schemas';
import { executed } from '@tools/core/result';

import { defineTool } from '../core/definition';
import { launchBackgroundScript } from './backgroundScript';
import { declarationOf, globalDeclarationOf } from './declarations';
import { describeTool, searchTools } from './discovery';

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
    .describe(
      'Run the script as a background run of its own: the call returns its run id at once, and the result and a summary arrive as one follow-up when it ends. A one-shot run runs it in the foreground.',
    ),
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

/** The script's own host functions, which read the pinned catalog: their
 *  ops are named `<global>()`, which no tool name can be. */
const SEARCH_TOOLS = 'searchTools';
const DESCRIBE_TOOL = 'describeTool';
const DEFAULT_SEARCH_LIMIT = 8;

const SearchArgsSchema = z.tuple([
  z.string().min(1, 'searchTools(query) takes a non-empty query'),
  z.object({ limit: z.int().positive().max(50).nullish() }).nullish(),
]);
const DescribeArgsSchema = z.tuple([
  z.string().min(1, 'describeTool(name) takes a tool name'),
]);

/** What one host-function op answers, as a settled call. */
const answerOf = (
  op: ScriptOp,
  catalog: ScriptDoor['catalog'],
): ToolResultPayload['result'] => {
  const failed = (error: string) => ({ status: 'error' as const, error });
  if (op.name === `${SEARCH_TOOLS}()`) {
    const args = SearchArgsSchema.safeParse(op.input);
    if (!args.success) return failed(z.prettifyError(args.error));
    const [query, options] = args.data;
    const found = searchTools(
      catalog,
      query,
      options?.limit ?? DEFAULT_SEARCH_LIMIT,
    );
    return {
      status: 'executed',
      output: JSON.stringify(found),
      summary: `${found.length} tools for "${query}"`,
    };
  }
  const args = DescribeArgsSchema.safeParse(op.input);
  if (!args.success) return failed(z.prettifyError(args.error));
  const [name] = args.data;
  const declaration = describeTool(catalog, name);
  return declaration === null
    ? failed(
        `No tool named "${name}" is offered to this script; searchTools(query) finds the ones that are.`,
      )
    : { status: 'executed', output: declaration, summary: name };
};

/** A call's result ended the turn: the script ends with it. */
class EndedTurn extends Data.TaggedError('EndedTurn')<{
  readonly result: Extract<ToolResultPayload['result'], { status: 'executed' }>;
}> {}

/** What the guest's `await` gets from a settled call: `{ output, summary }`
 *  of a tool, the list `searchTools` found, the text `describeTool` wrote. */
const settlementOf = (
  result: ToolResultPayload['result'],
  op?: ScriptOp,
): Effect.Effect<ScriptSettlement, EndedTurn> => {
  if (result.status === 'error')
    return Effect.succeed({
      _tag: 'Failure',
      name: result.name ?? 'ToolFailed',
      message: result.error,
    });
  if (op !== undefined)
    return Effect.succeed({
      _tag: 'Value',
      value:
        op.name === `${SEARCH_TOOLS}()`
          ? (JSON.parse(result.output ?? '[]') as unknown)
          : result.output,
    });
  if (result.endTurn === true) return Effect.fail(new EndedTurn({ result }));
  return Effect.succeed({
    _tag: 'Value',
    value:
      result.value !== undefined
        ? result.value
        : { output: result.output, summary: result.summary },
  });
};

const shown = (value: unknown): string =>
  value === undefined ? 'undefined' : JSON.stringify(value, null, 2);

const runScript = Effect.fn('ScriptTool.call')(function* (input: ScriptInput) {
  const { emit } = yield* ToolContext;
  const run = yield* callerRun;
  // A one-shot run has no later turn for a follow-up to reach.
  if (
    input.run_in_background === true &&
    run !== undefined &&
    run.toolPolicy.stopAfterCycle !== true
  )
    return yield* launchBackgroundScript(
      yield* requireToolRun('script run_in_background'),
      {
        code: input.code,
        ...(input.timeoutMs != null && { timeoutMs: input.timeoutMs }),
      },
      input.title ?? 'Script',
    );
  const issued = yield* ScriptCalls;
  if (issued === null)
    return yield* Effect.fail(
      new ToolError('A script runs only as a call of an agent run.'),
    );
  const scriptCalls = yield* issued;
  const sandbox = yield* CodeSandbox;
  // The last `RUN_LOG_MAX_LINES` lines the guest logged, for the result.
  const tail: string[] = [];
  let tailOmitted = 0;
  const logTail = (): string[] =>
    tail.length === 0
      ? []
      : [
          '',
          `Log (last ${tail.length} lines${tailOmitted > 0 ? `, ${tailOmitted} earlier omitted` : ''}):`,
          ...tail,
        ];
  const failed = (lines: readonly string[]) =>
    Effect.fail(new ToolError([...lines, ...logTail()].join('\n')));
  const script = { source: input.code, title: input.title ?? null };
  // The files its calls attached, in the order their results committed:
  // they reach the model on the script's own result.
  const files: ToolFileAttachment[] = [];
  const issue = (op: ScriptOp) =>
    Effect.flatMap(scriptCalls.call(op, script), (settled) => {
      for (const attached of settled.attachments)
        if (attached.content.kind === 'base64')
          files.push({
            path: attached.path,
            mimeType: attached.mimeType,
            ...(attached.description !== undefined && {
              description: attached.description,
            }),
            base64Data: attached.content.data,
          });
      return settlementOf(settled.result);
    });
  // The tools that are also globals, by the op name a global issues.
  const globals = new Map(
    scriptCalls.globals.map((global) => [`${global.tool}()`, global]),
  );
  const outcome = yield* sandbox
    .run({
      source: input.code,
      tools: scriptCalls.catalog.map(({ definition }) => definition.name),
      globals: [
        SEARCH_TOOLS,
        DESCRIBE_TOOL,
        ...scriptCalls.globals.map(({ tool }) => tool),
      ],
      timeout: Duration.millis(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      call: (op: ScriptOp) => {
        const global = globals.get(op.name);
        if (global !== undefined) {
          // `name(first, opts)` is `tools.name({ ...opts, [positional]: first })`:
          // the call is the tool's, recorded as the tool's.
          const [first, rest] = Array.isArray(op.input) ? op.input : [];
          if (rest != null && (typeof rest !== 'object' || Array.isArray(rest)))
            return Effect.succeed<ScriptSettlement>({
              _tag: 'Failure',
              name: 'TypeError',
              message: `${global.tool}() takes an options object as its second argument.`,
            });
          return issue({
            ...op,
            name: global.tool,
            input: { ...rest, [global.positional]: first },
          });
        }
        return op.name.endsWith('()')
          ? Effect.flatMap(
              scriptCalls.answer(op, script, () =>
                answerOf(op, scriptCalls.catalog),
              ),
              (result) => settlementOf(result, op),
            )
          : issue(op);
      },
      onLog: (lines, dropped) =>
        Effect.sync(() => {
          tail.push(...lines);
          const overflow = Math.max(0, tail.length - RUN_LOG_MAX_LINES);
          tail.splice(0, overflow);
          tailOmitted += dropped + overflow;
          if (lines.length > 0) emit(`${lines.join('\n')}\n`);
        }),
      onDelivered: scriptCalls.delivered,
    })
    .pipe(
      Effect.map((result) => ({ _tag: 'Returned' as const, result })),
      Effect.catchTag('EndedTurn', (ended) => Effect.succeed(ended)),
      // A script that ends in failure still returns its log tail: the lines
      // before the failure are most of what explains it.
      Effect.catchTags({
        ScriptFault: (fault) =>
          failed([
            [
              `The script threw ${fault.name}: ${fault.message}`,
              // The guest's own frames: the realm's bridge and natives
              // locate nothing in the script.
              ...(fault.stack ?? '')
                .split('\n')
                .map((line) => line.trim())
                .filter(
                  (line) =>
                    line.startsWith('at ') && line.includes('script.js'),
                )
                .slice(0, FAULT_FRAMES),
            ].join('\n    '),
          ]),
        ScriptSyntaxError: (error) =>
          failed([`The script does not parse: ${error.message}`]),
        ScriptCpuExhausted: (error) => failed([error.message]),
        ScriptMemoryExhausted: (error) => failed([error.message]),
        ScriptTimedOut: (error) => failed([error.message]),
      }),
    );
  if (outcome._tag === 'EndedTurn') return outcome.result;
  const { value } = outcome.result;
  const returned = JsonValueSchema.safeParse(value);
  const log = logTail();
  const foreground =
    input.run_in_background === true
      ? [
          'This run is one-shot, so the script ran in the foreground: no later turn would read a follow-up.',
          '',
        ]
      : [];
  return {
    ...executed(
      [...foreground, `The script returned:`, shown(value), ...log].join('\n'),
      input.title == null
        ? 'Script finished'
        : `Script finished: ${input.title}`,
    ),
    ...(files.length > 0 && { files }),
    // Its return as data: what a script's run ends with (a document task's
    // documents), journaled with the call.
    ...(returned.success && { value: returned.data }),
  };
});

/** What every `script` description says, before the declarations. */
const SURFACE = [
  'Run a JavaScript program that calls your other tools. `code` is the body of an async function: use `await` at top level and `return` the result (JSON).',
  [
    'Globals:',
    '- `tools.<name>(args)` calls a tool you are offered, other than `script`, with the arguments of a direct call, and resolves to `{ output, summary }`. A failed call rejects with an Error named `ToolFailed`. Use `Promise.all` to run calls together and try/catch to recover.',
    '- `searchTools(query, { limit })` ranks every tool you can call, those not declared below included (MCP and plugin tools), and resolves to the best `limit` (default 8, at most 50) as `{ name, line }[]`.',
    "- `describeTool(name)` resolves to a tool's full declaration, with the description of each field.",
    '- A tool declared below as a function is also a global: its first argument is one field of its arguments, its second an object of the rest. A tool that resolves to more than `{ output, summary }` declares what, and its description names the errors it rejects with other than `ToolFailed`.',
    '- `phase(title)` labels the calls that follow; `console.log` lines stream to the card and the last 80 return with the result.',
  ].join('\n'),
  'There are no timers, no `Date.now()`, no `Math.random()` and no imports: the script replays exactly after an interruption, and calls that finished are not run again.',
].join('\n\n');

const SCRIPT_TOOL = 'script';

export const ScriptTool = defineTool({
  name: SCRIPT_TOOL,
  // A resume runs the script again from the top against its recorded calls:
  // each settled call is handed back from its row, never run twice.
  replay: 'safe',
  slow: true,
  description: SURFACE,
  describe: (declared) =>
    [
      SURFACE,
      'The tools you declared, as TypeScript (more are callable: `searchTools` finds them):',
      [
        '```ts',
        'type ToolOutput = { output: string; summary?: string };',
        'declare const tools: {',
        ...declared.map(({ definition }) =>
          declarationOf(definition, false, '  '),
        ),
        '};',
        ...declared.flatMap(({ definition, scriptGlobal }) =>
          scriptGlobal === undefined
            ? []
            : [globalDeclarationOf(definition, scriptGlobal.positional)],
        ),
        '```',
      ].join('\n'),
    ].join('\n\n'),
  schema: ScriptInputSchema,
  execute: runScript,
});

/** The code sandbox a session's scripts run in: a worker per script. */
export const codeSandboxLayer = CodeSandbox.layer.pipe(
  Layer.provide(NodeWorker.layerPlatform),
);
