/**
 * Example 08 — A real crash inside a script, and its resume in another
 * process.
 *
 * 1. Spawns itself as a child `node` process over the same workspace. The
 *    child opens a persistent session and starts a run whose script awaits
 *    `Promise.all([self(...), tools.hold()])`: the `self()` child finishes,
 *    `hold` never returns there, so the script is still waiting when its
 *    child's result is committed.
 * 2. This process opens the same store, sees the child run's stored outcome
 *    in its own session view, and kills the child process with SIGKILL.
 * 3. It resumes the run here. The finished child is not run again, its
 *    result reaches the replayed script once, the script runs on to its
 *    second `self()` from its saved source, and the run completes.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { Effect, Option, Schema, Stream } from 'effect';
import { defineTool, Sessions } from '@texra-ai/harness';
import {
  definePlugin,
  executed,
  harnessBuiltins,
} from '@texra-ai/harness/plugins';
import { RunIdSchema } from '@texra-ai/harness/schemas';

import {
  makeExampleWorkspace,
  scriptReturnOf,
  type ScriptedTurn,
} from './_support.ts';

const [mode, existing] = process.argv.slice(2);
const crashing = mode === 'crash';

/** Never returns in the process that is killed; returns at once after. */
const holdTool = defineTool({
  name: 'hold',
  description: 'Wait for the reviewer.',
  replay: 'safe',
  // `Schema.Struct({})` converts to `{ not: { type: 'null' } }`, which the
  // Anthropic binding refuses as a tool's parameters: give it one field.
  schema: Schema.Struct({
    note: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  execute: () =>
    crashing ? Effect.never : Effect.succeed(executed('released', 'released')),
});
const plugins = [
  ...harnessBuiltins,
  definePlugin({ id: 'hold', tools: [holdTool] }),
];

const VERDICT = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};
const CODE = `
const schema = ${JSON.stringify(VERDICT)};
const [first] = await Promise.all([
  self('Round 1: check the setup.', { schema }),
  tools.hold({}),
]);
const second = await self('Round 2: check the bound.', { schema });
return {
  verdicts: [first.structured.verdict, second.structured.verdict],
  firstRun: first.runId,
};`;
const submit = (verdict: string, expect: string): ScriptedTurn => ({
  expect,
  toolCalls: [{ name: 'submit_output', input: { verdict } }],
});

// The killed process answers the parent's first turn and the first child;
// this one only the second child and the parent's last turn.
const { platform, workspace, requests } = await makeExampleWorkspace(
  crashing
    ? [
        {
          expect: 'Review in two rounds.',
          toolCalls: [{ name: 'script', input: { code: CODE } }],
        },
        submit('setup-ok', 'Round 1:'),
      ]
    : [
        submit('bound-ok', 'Round 2:'),
        { expect: 'The script returned', text: 'Both rounds passed.' },
      ],
  existing,
);
const layer = Sessions.layer({ platform, plugins });

const crashProgram = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const run = yield* session.start({
    agent: {
      name: 'reviewer',
      prompt: 'Review the draft with a script.',
      tools: ['script', 'hold'],
    },
    instruction: 'Review in two rounds.',
    model: 'anthropic/claude-sonnet-5-5',
  });
  process.stdout.write(`started ${run.runId}\n`);
  const end = yield* run.result;
  throw new Error(
    `The run ended where it was to be killed: ${JSON.stringify(end)}`,
  );
}).pipe(Effect.scoped, Effect.provide(layer));

const resumeProgram = Effect.gen(function* () {
  // Open the store first, so its event stream starts before the other
  // process writes anything.
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const from = session.view.head();
  const child = spawn(
    process.execPath,
    [process.argv[1] ?? '', 'crash', workspace],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('exit', (_code, signal) => resolve(signal)),
  );
  const runId = yield* Effect.promise(async () => {
    for await (const line of createInterface({ input: child.stdout }))
      if (line.startsWith('started '))
        return Schema.decodeUnknownSync(RunIdSchema)(line.slice(8));
    throw new Error('The crash process exited before it started a run.');
  });

  // The other process's commits reach this session's event stream: the
  // `self()` card closes in the batch that commits its result. Kill the
  // process there, while the script still awaits `hold`.
  const selfCards = new Set<string>();
  yield* Stream.runHead(
    Stream.filter(session.view.events(from), (event) => {
      if (event.type === 'tool.start' && event.toolName === 'self')
        selfCards.add(event.logId);
      return event.type === 'tool.end' && selfCards.has(event.logId);
    }),
  );
  child.kill('SIGKILL');
  const signal = yield* Effect.promise(() => exited);
  // The view applies the other process's commits on its next poll of the
  // store, after the event stream has read them.
  const childrenOf = (view: ReturnType<typeof session.view.current>) =>
    [...view.runs.values()].filter((run) => run.parentId === runId);
  const finished = yield* Stream.runHead(
    Stream.filter(
      Stream.concat(
        Stream.succeed(session.view.current()),
        session.view.changes,
      ),
      (view) => childrenOf(view).some((run) => run.durableOutcome !== null),
    ),
  ).pipe(Effect.timeout('5 seconds'));
  const committed = childrenOf(Option.getOrThrow(finished));
  if (committed.length !== 1 || committed[0]?.durableOutcome !== 'completed')
    throw new Error(`expected one finished child, got ${committed.length}`);
  const firstChild = committed[0].id;
  console.log(`[08] child ${firstChild}'s result committed; ${signal} sent`);

  const resumed = yield* session.resume(runId);
  const end = yield* resumed.result;
  const children = [...session.view.current().runs.values()].filter(
    (run) => run.parentId === runId,
  );
  const conversation = yield* session.records(runId).readConversation();
  const results = conversation.filter(
    (node) =>
      node.kind === 'tool-result' &&
      node.text.startsWith('The script returned:'),
  );
  const returned = scriptReturnOf(conversation) as {
    verdicts: string[];
    firstRun: string;
  };
  if (
    end.outcome !== 'completed' ||
    requests.length !== 2 ||
    children.length !== 2 ||
    results.length !== 1 ||
    returned.verdicts.join() !== 'setup-ok,bound-ok' ||
    returned.firstRun !== firstChild
  )
    throw new Error(
      `resume went wrong: ${JSON.stringify({ end, requests: requests.length, children: children.length, results: results.length, returned })}`,
    );
  console.log(
    `[08] resumed: outcome=${end.outcome} model turns here=${requests.length} children=${children.length} script results=${results.length} verdicts=${returned.verdicts.join('|')} first child reused=${returned.firstRun === firstChild}`,
  );
}).pipe(Effect.scoped, Effect.provide(layer));

await Effect.runPromise(crashing ? crashProgram : resumeProgram);
