/**
 * The `script` tool: one JavaScript program that calls the run's tools as
 * `await tools.<name>(args)`. The program runs in the code sandbox
 * (`@agent/codeSandbox/codeSandbox`); every call it issues goes through the
 * run loop's per-call program, reached through the door on the call's
 * `RunCall` (`scriptCalls`), which commits its rows and, on a resume, hands
 * back what they already finished. This tool names no other tool and writes
 * no row.
 */
import * as NodeWorker from '@effect/platform-node/NodeWorker';
import { Duration, Effect, Layer, Predicate, Result, Schema } from 'effect';

import {
  CodeSandbox,
  type ScriptOp,
  type ScriptOpResult,
} from '@agent/codeSandbox/codeSandbox';
import { RUN_LOG_MAX_LINES } from '@agent/codeSandbox/limits';
import { ToolContext } from '@tools/core/ToolTypes';
import {
  noLaterTurn,
  inRunSession,
  type ScriptDoor,
} from '@agent/runtime/RunCall';
import {
  FinishedToolResultSchema,
  ToolError,
  type ToolFileAttachment,
  type ToolResultPayload,
  SCRIPT_TOOL_NAME,
} from '@shared/schemas';
import { executed } from '@tools/core/result';

import { defineTool } from '../core/definition';
import { optionalInput, timeoutMsField } from '../core/inputSchema';
import { launchBackgroundScript } from './backgroundScript';
import { declarationOf, globalDeclarationOf } from './declarations';
import { describeTool, searchTools } from './discovery';

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** How many guest stack frames a script failure keeps. */
const FAULT_FRAMES = 3;

const ScriptInputSchema = Schema.Struct({
  code: Schema.NonEmptyString.annotate({
    description:
      'The body of an async JavaScript function: `await` at top level, `return` the result. Inputs are literals in the code.',
  }),
  title: optionalInput(
    Schema.String,
    'A short title for the script, shown on its card.',
  ),
  run_in_background: optionalInput(
    Schema.Boolean,
    'Run the script as a background run of its own: the call returns its run id at once, and the result and a summary arrive as one follow-up when it ends. A one-shot run runs it in the foreground.',
  ),
  timeoutMs: timeoutMsField.annotate({
    description:
      'Wall-clock limit in milliseconds, tool calls included: 1 s to 24 h, default 60 min.',
  }),
});
type ScriptInput = typeof ScriptInputSchema.Type;

/** The script's own host functions, which read the pinned catalog: their
 *  ops are named `<global>()`, which no tool name can be. */
const SEARCH_TOOLS = 'searchTools';
const DESCRIBE_TOOL = 'describeTool';
const DEFAULT_SEARCH_LIMIT = 8;

const SearchArgsSchema = Schema.Tuple([
  Schema.NonEmptyString,
  Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        limit: Schema.optional(
          Schema.NullOr(
            Schema.Int.check(Schema.isGreaterThan(0)).check(
              Schema.isLessThanOrEqualTo(50),
            ),
          ),
        ),
      }),
    ),
  ),
]);
const DescribeArgsSchema = Schema.Tuple([Schema.NonEmptyString]);

/** What one host-function op answers, as a finished call. */
const answerOf = (
  op: ScriptOp,
  { catalog, modules }: Pick<ScriptDoor, 'catalog' | 'modules'>,
): ToolResultPayload['result'] => {
  const failed = (error: string) => ({ status: 'error' as const, error });
  if (op.name === `${SEARCH_TOOLS}()`) {
    const args = Schema.decodeUnknownResult(SearchArgsSchema)(op.input);
    if (!Result.isSuccess(args)) return failed(args.failure.message);
    const [query, options] = args.success;
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
  const args = Schema.decodeUnknownResult(DescribeArgsSchema)(op.input);
  if (!Result.isSuccess(args)) return failed(args.failure.message);
  const [name] = args.success;
  // A tool's declaration, or the source of a module the script may import
  // (a program's included), by its specifier or its bare name.
  const declaration =
    describeTool(catalog, name) ??
    modules[name] ??
    modules[`builtIn:${name}`] ??
    null;
  return declaration === null
    ? failed(
        `No tool or module named "${name}" is offered to this script; searchTools(query) finds the tools that are.`,
      )
    : { status: 'executed', output: declaration, summary: name };
};

/** A call's result ended the turn: the script ends with it. */
class EndedTurn extends Schema.TaggedError<EndedTurn>()('EndedTurn', {
  // The executed member of a finished result: only an executed result ends
  // the turn.
  result: FinishedToolResultSchema.members[0],
}) {}

/** What the guest's `await` gets from a finished call: `{ output, summary }`
 *  of a tool, the list `searchTools` found, the text `describeTool` wrote. */
const guestAnswerOf = (
  result: ToolResultPayload['result'],
  op?: ScriptOp,
): Effect.Effect<ScriptOpResult, EndedTurn> => {
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
          ? Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(
              result.output ?? '[]',
            )
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
  const { emit, env } = yield* ToolContext;
  // A one-shot run has no later turn for a follow-up to reach.
  if (input.run_in_background === true && !noLaterTurn(env.run))
    return yield* inRunSession((call) =>
      launchBackgroundScript(
        call,
        {
          code: input.code,
          ...(input.timeoutMs != null && { timeoutMs: input.timeoutMs }),
        },
        input.title ?? 'Script',
      ),
    );
  const scriptCalls = yield* inRunSession(({ scriptCalls: issued }) =>
    issued === null
      ? Effect.fail(
          new ToolError('A script runs only as a call of an agent run.'),
        )
      : issued,
  );
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
    Effect.flatMap(scriptCalls.call(op, script), (finished) => {
      for (const attached of finished.attachments)
        if (attached.content.kind === 'stored')
          files.push({
            path: attached.path,
            mimeType: attached.mimeType,
            ...(attached.description !== undefined && {
              description: attached.description,
            }),
            digest: attached.content.digest,
          });
      return guestAnswerOf(finished.result);
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
      modules: scriptCalls.modules,
      timeout: Duration.millis(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      call: (op: ScriptOp) => {
        const global = globals.get(op.name);
        if (global !== undefined) {
          // `name(first, opts)` is `tools.name({ ...opts, [positional]: first })`:
          // the call is the tool's, recorded as the tool's.
          const [first, rest] = Array.isArray(op.input) ? op.input : [];
          if (rest != null && !Predicate.isObject(rest))
            return Effect.succeed<ScriptOpResult>({
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
              scriptCalls.answer(op, script, () => answerOf(op, scriptCalls)),
              (result) => guestAnswerOf(result, op),
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
              // The guest's own frames, in the script or in a module it
              // imported: the realm's bridge and natives locate nothing.
              ...(fault.stack ?? '')
                .split('\n')
                .map((line) => line.trim())
                .filter(
                  (line) =>
                    line.startsWith('at ') &&
                    ['script.js', ...Object.keys(scriptCalls.modules)].some(
                      (file) => line.includes(file),
                    ),
                )
                .slice(0, FAULT_FRAMES),
            ].join('\n    '),
          ]),
        ScriptSyntaxError: (error) =>
          failed([`The script does not parse: ${error.message}`]),
        ScriptLimitExceeded: (error) => failed([error.message]),
      }),
    );
  if (outcome._tag === 'EndedTurn') return outcome.result;
  const { value } = outcome.result;
  const returned = Schema.decodeUnknownResult(Schema.Json)(value);
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
    // Its return as data: what a script's run ends with (a program's
    // value), journaled with the call.
    ...(Result.isSuccess(returned) && { value: returned.success }),
  };
});

/** What every `script` description says, before the declarations. */
const SURFACE = [
  'Run a JavaScript program that calls your other tools. `code` is the body of an async function: use `await` at top level and `return` the result (JSON).',
  [
    'Globals:',
    '- `tools.<name>(args)` calls a tool you are offered, other than `script`, with the arguments of a direct call, and resolves to `{ output, summary }`. A failed call rejects with an Error named `ToolFailed`; use try/catch to recover.',
    '- Calls start in the order the script issues them. A call to a tool that runs alongside others (the reading and searching tools, and child runs: `agent()`, `self()`, `program()`; the declared ones are named after the declarations below) runs together with the calls around it; every other call (a command, an edit, most MCP and plugin tools) first waits for every call issued before it to finish, and the calls issued after it wait for it. So `Promise.all` runs reads, searches and child runs together, and commands and edits one after another.',
    '- `searchTools(query, { limit })` ranks every tool you can call, those not declared below included (MCP and plugin tools), and resolves to the best `limit` (default 8, at most 50) as `{ name, line }[]`.',
    "- `describeTool(name)` resolves to a tool's full declaration, with the description of each field, or to the source of a module or program named `name`.",
    '- A tool declared below as a function is also a global: its first argument is one field of its arguments, its second an object of the rest. A tool that resolves to more than `{ output, summary }` declares what, and its description names the errors it rejects with other than `ToolFailed`.',
    '- `self(prompt, { fork, schema, model, timeoutMs, maxCostUsd, label })` runs you again on `prompt` and resolves to its `{ response, structured?, cost, spent, … }`: forked (the default) from this conversation as it stood when the script started, or with `fork: false` with no earlier conversation; either way it is told `prompt` is its one part of the work. `model` runs it on another model, with your prompt and tools. A loop of `self()` calls that checks each reply is how a goal runs until it is met.',
    '- Every child run a script waits for (`agent()`, `self()`, `program()`) takes `timeoutMs` and `maxCostUsd`, a spend cap in USD on the child and the runs it starts: past either the child is stopped and the call rejects with an Error named `TimedOut` or `BudgetExceeded`.',
    '- `section(title)` labels the calls that follow; `console.log` lines stream to the card and the last 80 return with the result.',
  ].join('\n'),
  '`const { name } = await import(specifier)` loads a module by its specifier (`builtIn:<module>`, listed below when you may import any); a static `import` line does not parse in a function body.',
  'There are no timers, no `Date.now()` and no `Math.random()`: the script replays exactly after an interruption, on the modules it first loaded, and calls that finished are not run again. To continue at a later time, `tools.wake({ afterSeconds, note })` (where `wake` is offered) returns at once and arranges a later turn of the conversation, which starts from the note.',
].join('\n\n');

export const ScriptTool = defineTool({
  name: SCRIPT_TOOL_NAME,
  // A resume runs the script again from the top against its recorded calls:
  // each finished call is handed back from its row, never run twice.
  replay: 'safe',
  description: SURFACE,
  describe: (declared, modules, programs) => {
    // The declared tools whose calls run alongside others: the rest wait
    // their turn.
    const together = declared.flatMap(({ definition, lane }) =>
      lane === 'parallel' || lane === 'own' ? [`\`${definition.name}\``] : [],
    );
    return [
      SURFACE,
      // A module no tool's description names is found only here.
      ...(modules.length === 0
        ? []
        : [
            `The modules you may import: ${modules.map((specifier) => `\`${specifier}\``).join(', ')}.`,
          ]),
      ...(programs.length === 0
        ? []
        : [
            [
              'The programs `program(name, opts)` starts:',
              ...programs.map(
                ({ name, description }) => `- \`${name}\`: ${description}`,
              ),
            ].join('\n'),
          ]),
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
      ...(together.length === 0
        ? []
        : [
            `Of these, calls to ${together.join(', ')} run alongside the calls around them.`,
          ]),
    ].join('\n\n');
  },
  schema: ScriptInputSchema,
  execute: runScript,
});

/** The code sandbox a session's scripts run in: a worker per script. */
export const codeSandboxLayer = CodeSandbox.layer.pipe(
  Layer.provide(NodeWorker.layerPlatform),
);
