/**
 * Real-model acceptance: three scenarios where the model writes the code.
 *
 * Unlike `02`–`10`, nothing here hands the model a script. Each scenario
 * gives a task in plain words and checks only what any competent model
 * leaves behind: the run's outcome, the calls it made, the child runs, the
 * facts and the artifacts. No check reads exact text or counts requests.
 *
 * 1. `codemode`: an agent file with a plugin tool, its script module and
 *    `executions`. The model reads the `script` description, writes a
 *    program that outlines a draft through the module, runs two `self()`
 *    review rounds (the second chosen from the first's structured result)
 *    and counts its finished children with SQL over `runs`.
 * 2. `plugin`: the `acme-notes` package's agent, tool and script module
 *    (example `10`), used by a script the model writes.
 * 3. `crash-resume`: a second process runs a model-written script that
 *    waits on a sign-off tool after its first `self()` round; once that
 *    child's result is committed the process is killed, and this one
 *    resumes the run: the committed child is not run again and the run
 *    completes.
 *
 * Needs `TEXRA_EXAMPLE_MODEL` (`provider/model`), the provider's API key
 * in its usual variable, and `TEXRA_ACCEPTANCE_OUT`, the directory the
 * evidence of this run is written under (`scripts/example-packed.mjs
 * --acceptance` sets it). A route whose key is not set is recorded as
 * skipped, and nothing is sent.
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { Effect, Layer, Option, Schema, Stream } from 'effect';
import { defineTool, Sessions, type LocalSession } from '@texra-ai/harness';
import {
  definePlugin,
  errorResult,
  executed,
  harnessBuiltins,
  type Plugin,
} from '@texra-ai/harness/plugins';
import { RunIdSchema, type RunId } from '@texra-ai/harness/schemas';
import { API_KEY_PROVIDER_IDS, apiKeyEnvName } from '@texra-ai/llm';
import { acmeNotes, agentsDir as notesAgents, NoteSchema } from 'acme-notes';

import {
  check,
  json,
  judged,
  runScenario,
  writeEvidence,
  writeReport,
  type ScenarioResult,
} from './_evidence.ts';
import { makeExampleWorkspace, scriptReturnsOf } from './_support.ts';

const MODEL = process.env.TEXRA_EXAMPLE_MODEL?.trim() ?? '';
const OUT = process.env.TEXRA_ACCEPTANCE_OUT?.trim() ?? '';
/** How long one run may take before it is interrupted and failed. */
const RUN_LIMIT = '8 minutes';

const DRAFT = String.raw`\section{Setup}
Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.
\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.
\section{Discussion}
The bound is sharp for constant functions.
`;
const TITLES = ['Setup', 'Main bound', 'Discussion'];

const childrenOf = (session: LocalSession, runId: RunId) =>
  [...session.view.current().runs.values()].filter(
    (run) => run.parentId === runId,
  );

/** Waits for a run's end, interrupting it past {@link RUN_LIMIT}. */
const endOf = (run: {
  readonly result: Effect.Effect<{ readonly outcome?: string }, unknown>;
  readonly interrupt: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const end = yield* run.result.pipe(Effect.timeoutOption(RUN_LIMIT));
    if (Option.isNone(end)) {
      yield* run.interrupt;
      return `timed out after ${RUN_LIMIT}`;
    }
    return end.value.outcome ?? 'unknown';
  });

const has = (value: unknown, needle: string) =>
  JSON.stringify(value ?? null).includes(needle);

// -- 1. codemode ------------------------------------------------------------

/** Reads a LaTeX file of the workspace and returns its sections. */
const outlineTool = (workspace: string) =>
  defineTool({
    name: 'outline_sections',
    description:
      'Split a LaTeX file of the workspace into its sections: each title with its body text.',
    replay: 'safe',
    schema: Schema.Struct({
      path: Schema.String.annotate({
        description: 'The file, relative to the workspace root.',
      }),
    }),
    scriptReturns: '{ sections: { title: string; text: string }[] }',
    execute: ({ path }) => {
      const file = resolve(workspace, path);
      const inside = relative(workspace, file);
      if (inside.startsWith('..') || isAbsolute(inside))
        return Effect.succeed(errorResult(`${path} is outside the workspace.`));
      return Effect.tryPromise({
        try: () => readFile(file, 'utf8'),
        catch: (error) => error as NodeJS.ErrnoException,
      }).pipe(
        // Only absence is the model's to fix; any other failure is the
        // environment's and fails the call with its cause.
        Effect.catch((error) =>
          error.code === 'ENOENT' ? Effect.succeed(null) : Effect.die(error),
        ),
        Effect.map((tex) => {
          if (tex === null) return errorResult(`No file at ${path}.`);
          const sections = [
            ...tex.matchAll(
              /\\section\{([^}]*)\}([^\\]*(?:\\(?!section)[^\\]*)*)/g,
            ),
          ].map((match) => ({
            title: match[1] ?? '',
            text: (match[2] ?? '').trim(),
          }));
          return {
            ...executed(
              sections.map((section) => section.title).join('\n'),
              `${sections.length} sections`,
            ),
            value: { sections },
          };
        }),
      );
    },
  });

const CODEMODE_INSTRUCTION = `draft.tex in the workspace is a short paper draft. Review it with one script program that you write yourself (the script tool's description lists what a program can call):
1. Get the draft's sections through the latex script module.
2. Run two review rounds with self(), each returning a structured verdict that names the section it checked and whether its claim is supported. Round 1 checks the first section; choose round 2's section from round 1's verdict.
3. After both rounds, query the executions SQL history (the runs table) to count how many of your child runs ended completed.
Return an object with the section titles, both verdicts, and that count as completedChildren. Then reply with one sentence on what the review found.`;

const codemode = (dir: string) =>
  Effect.gen(function* () {
    const { platform, agentsDir, workspace, route } = yield* Effect.promise(
      () => makeExampleWorkspace(),
    );
    yield* Effect.promise(async () => {
      await writeFile(join(workspace, 'draft.tex'), DRAFT);
      await writeFile(
        join(agentsDir, 'draft-reviewer.yaml'),
        [
          'name: draft_reviewer',
          'description: Reviews LaTeX drafts with programs.',
          'prompt: You review LaTeX drafts. Do the work with the script tool, writing programs over the tools and modules its description lists.',
          'tools: [script, executions, outline_sections]',
          '',
        ].join('\n'),
      );
    });
    const plugin = definePlugin({
      id: 'latex-outline',
      tools: [outlineTool(workspace)],
      scriptModules: {
        latex:
          '/** The sections of a LaTeX file: `{ sections: { title, text }[] }`. */\nexport const outline = (path) => tools.outline_sections({ path });',
      },
    });
    return yield* Effect.gen(function* () {
      const session = yield* (yield* Sessions).open(platform.roots, {
        persistent: true,
      });
      const run = yield* session.start({
        agent: 'draft_reviewer',
        instruction: CODEMODE_INSTRUCTION,
        model: route.model,
      });
      const outcome = yield* endOf(run);
      const evidence = yield* writeEvidence(dir, session, run.runId, workspace);
      const children = childrenOf(session, run.runId);
      const completed = children.filter(
        (child) => child.durableOutcome === 'completed',
      ).length;
      const returned = scriptReturnsOf(evidence.conversation).at(-1);
      // Each finished round's structured verdict, as its run ended with it.
      const verdicts: unknown[] = [];
      for (const child of children)
        if (child.durableOutcome === 'completed')
          verdicts.push(
            (yield* session.records(child.id).readRunEnd())?.output.structured,
          );
      const ok = (tool: string, input?: (input: unknown) => boolean) =>
        evidence.calls.some(
          (call) =>
            call.tool === tool &&
            call.status === 'completed' &&
            (input?.(call.input) ?? true),
        );
      return judged(
        session,
        run.runId,
        [
          check(
            'run completed',
            outcome === 'completed',
            evidence.end?.error?.message ?? outcome,
          ),
          check(
            'a script finished',
            ok('script'),
            evidence.calls.map((c) => `${c.tool}:${c.status}`),
          ),
          check('the module called the plugin tool', ok('outline_sections')),
          check(
            'two self() rounds completed',
            completed >= 2,
            `${completed} of ${children.length}`,
          ),
          check(
            'each round ended with a structured verdict naming a section',
            verdicts.length >= 2 &&
              verdicts.every((verdict) =>
                TITLES.some((title) => has(verdict, title)),
              ),
            verdicts,
          ),
          check(
            'an executions SQL query succeeded',
            ok('executions', (input) => has(input, '"query"')),
          ),
          check(
            'the script returned every section title',
            TITLES.every((title) => has(returned, title)),
            returned,
          ),
          check(
            'the returned count matches the finished children',
            (returned as { completedChildren?: unknown } | undefined)
              ?.completedChildren === completed,
            { completed, returned },
          ),
        ],
        evidence,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({
          platform,
          plugins: [...harnessBuiltins, plugin],
        }).pipe(Layer.provideMerge(route.transport)),
      ),
    );
  });

// -- 2. plugin --------------------------------------------------------------

const NOTES = ['Lemma 2 needs a citation.', 'Section 3 is done.'];
const PLUGIN_INSTRUCTION = `Keep two notes on the draft, in one script program you write yourself, through the notes script module: ${JSON.stringify(NOTES[0])} and ${JSON.stringify(NOTES[1])}. Return what the module returned for each note.`;

const plugin = (dir: string) =>
  Effect.gen(function* () {
    const { platform, workspace, route } = yield* Effect.promise(() =>
      makeExampleWorkspace([], undefined, notesAgents),
    );
    return yield* Effect.gen(function* () {
      const session = yield* (yield* Sessions).open(platform.roots, {
        persistent: true,
      });
      const run = yield* session.start({
        agent: 'note_taker',
        instruction: PLUGIN_INSTRUCTION,
        model: route.model,
      });
      const outcome = yield* endOf(run);
      const evidence = yield* writeEvidence(dir, session, run.runId, workspace);
      const exported = yield* session.records(run.runId).readTrace();
      const facts =
        exported.status === 'ok'
          ? exported.trace.events.flatMap((event) =>
              event.type === 'plugin.fact' && event.plugin === 'acme-notes'
                ? [event]
                : [],
            )
          : [];
      yield* Effect.promise(() =>
        writeFile(join(dir, 'outputs', 'facts.json'), json(facts)),
      );
      const decoded = facts.flatMap((fact) => {
        const note = Schema.decodeUnknownOption(NoteSchema)(fact.value);
        return Option.isSome(note) ? [note.value.text] : [];
      });
      const returned = scriptReturnsOf(evidence.conversation).at(-1);
      return judged(
        session,
        run.runId,
        [
          check(
            'run completed',
            outcome === 'completed',
            evidence.end?.error?.message ?? outcome,
          ),
          check(
            'a script imported the notes module',
            evidence.scripts.some((code) => code.includes('builtIn:notes')),
            evidence.scripts,
          ),
          check(
            'note_add ran from a script',
            evidence.calls.some(
              (call) => call.tool === 'note_add' && call.status === 'completed',
            ),
          ),
          check(
            'both notes are versioned facts of the plugin',
            NOTES.every((note) => decoded.includes(note)) &&
              facts.every((fact) => fact.version === 1),
            decoded,
          ),
          check(
            'the script returned both notes',
            NOTES.every((note) => has(returned, note)),
            returned,
          ),
        ],
        evidence,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({
          platform,
          plugins: [...harnessBuiltins, acmeNotes],
        }).pipe(Layer.provideMerge(route.transport)),
      ),
    );
  });

// -- 3. crash-resume --------------------------------------------------------

const [mode, existing] = process.argv.slice(2);
const crashing = mode === 'crash';

/** Never returns in the process that is killed; returns at once after. */
const signoffTool = defineTool({
  name: 'await_signoff',
  description:
    "Wait for the reviewer to sign off a round's verdict before the next round starts. Resolves once they have.",
  replay: 'safe',
  // Its card opens when it starts, not when it ends: the kill below waits
  // for a sign-off that has started and never ends.
  slow: true,
  schema: Schema.Struct({
    verdict: Schema.String.annotate({
      description: 'The verdict to sign off, in a sentence.',
    }),
  }),
  execute: () =>
    crashing ? Effect.never : Effect.succeed(executed('Signed off.')),
});
const crashPlugins: readonly Plugin[] = [
  ...harnessBuiltins,
  definePlugin({ id: 'signoff', tools: [signoffTool] }),
];
const CRASH_AGENT = {
  name: 'two_round_reviewer',
  description: 'Reviews a draft in two signed-off rounds.',
  prompt:
    'You review drafts. Do the work with the script tool, writing programs over what its description lists.',
  tools: ['script', 'await_signoff'],
};
const CRASH_INSTRUCTION = `Review this draft in one script program that you write yourself:

${DRAFT}
Round 1: with self(), check the Setup section and return a structured verdict naming any gap. Then call await_signoff with round 1's verdict and wait for it. Round 2: only after the sign-off, with self(), check the section round 1's verdict points to (the Main bound section if it names none). Return both verdicts.`;

/** The killed process: starts the run and waits where it is killed. */
const crashProgram = (workspace: string) =>
  Effect.gen(function* () {
    const { platform, route } = yield* Effect.promise(() =>
      makeExampleWorkspace([], workspace),
    );
    return yield* Effect.gen(function* () {
      const session = yield* (yield* Sessions).open(platform.roots, {
        persistent: true,
      });
      const run = yield* session.start({
        agent: CRASH_AGENT,
        instruction: CRASH_INSTRUCTION,
        model: route.model,
      });
      process.stdout.write(`started ${run.runId}\n`);
      const end = yield* run.result;
      process.stdout.write(`ended ${end.outcome}\n`);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({ platform, plugins: crashPlugins }).pipe(
          Layer.provideMerge(route.transport),
        ),
      ),
    );
  });

const crashResume = (dir: string) =>
  Effect.gen(function* () {
    const { platform, workspace, route } = yield* Effect.promise(() =>
      makeExampleWorkspace(),
    );
    return yield* Effect.gen(function* () {
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
      // Keep reading what it prints, so a full pipe never blocks it.
      child.stdout.resume();

      // Kill once a `self()` child's result is committed and the script
      // waits on the sign-off, which never resolves in that process.
      const selfCards = new Set<string>();
      let selfEnded = false;
      let signoffStarted = false;
      const killPoint = yield* Stream.runHead(
        Stream.filter(session.view.events(from), (event) => {
          if (event.type === 'tool.start' && event.toolName === 'self')
            selfCards.add(event.logId);
          if (event.type === 'tool.end' && selfCards.has(event.logId))
            selfEnded = true;
          if (event.type === 'tool.start' && event.toolName === 'await_signoff')
            signoffStarted = true;
          return selfEnded && signoffStarted;
        }),
      ).pipe(
        // The other process may end first: its run failed or finished.
        Effect.raceFirst(
          Effect.promise(() => exited).pipe(Effect.as(Option.none())),
        ),
        Effect.timeoutOption(RUN_LIMIT),
      );
      child.kill('SIGKILL');
      const signal = yield* Effect.promise(() => exited);
      if (Option.isNone(killPoint) || Option.isNone(killPoint.value)) {
        const evidence = yield* writeEvidence(dir, session, runId, workspace);
        return judged(
          session,
          runId,
          [
            check(
              'the script reached a committed self() result and a pending sign-off',
              false,
              `self ended: ${selfEnded}, sign-off started: ${signoffStarted}, crash process ${signal === 'SIGKILL' ? 'killed at the time limit' : `exited first, its run ${evidence.end?.outcome ?? 'not ended'}${evidence.end?.error ? `: ${evidence.end.error.message}` : ''}`}`,
            ),
          ],
          evidence,
        );
      }

      // The view applies the other process's commits on its next poll.
      const finished = yield* Stream.runHead(
        Stream.filter(
          Stream.concat(
            Stream.succeed(session.view.current()),
            session.view.changes,
          ),
          (view) =>
            [...view.runs.values()].some(
              (run) => run.parentId === runId && run.durableOutcome !== null,
            ),
        ),
      ).pipe(Effect.timeoutOption('10 seconds'));
      const before = new Map<string, number>();
      for (const run of childrenOf(session, runId))
        if (run.durableOutcome !== null)
          before.set(
            run.id,
            (yield* session.records(run.id).readConversation()).length,
          );

      const resumed = yield* session.resume(runId);
      const outcome = yield* endOf(resumed);
      const evidence = yield* writeEvidence(dir, session, runId, workspace);
      const children = childrenOf(session, runId);
      const unchanged: string[] = [];
      for (const [id, length] of before) {
        const after = (yield* session.records(id as RunId).readConversation())
          .length;
        if (after === length) unchanged.push(id);
      }
      const firstScript = evidence.calls.find((call) => call.tool === 'script');
      return judged(
        session,
        runId,
        [
          check('killed by SIGKILL', signal === 'SIGKILL', signal),
          check(
            'exactly one round was committed before the kill',
            Option.isSome(finished) && before.size === 1,
            before.size,
          ),
          check(
            'resumed run completed',
            outcome === 'completed',
            evidence.end?.error?.message ?? outcome,
          ),
          check(
            'committed children did not run again',
            before.size > 0 && unchanged.length === before.size,
            { before: Object.fromEntries(before), unchanged },
          ),
          check(
            'a second round ran and completed after the resume',
            children.some(
              (run) =>
                !before.has(run.id) && run.durableOutcome === 'completed',
            ),
            children.map((run) => `${run.id}:${run.durableOutcome}`),
          ),
          check(
            'the interrupted script finished from its saved source',
            firstScript?.status === 'completed',
            firstScript?.status,
          ),
        ],
        evidence,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({ platform, plugins: crashPlugins }).pipe(
          Layer.provideMerge(route.transport),
        ),
      ),
    );
  });

// -- The run ----------------------------------------------------------------

if (crashing) {
  await Effect.runPromise(crashProgram(existing ?? ''));
} else {
  if (!MODEL.includes('/') || OUT === '')
    throw new Error(
      'Set TEXRA_EXAMPLE_MODEL=provider/model and TEXRA_ACCEPTANCE_OUT=<dir>.',
    );
  const provider = MODEL.slice(0, MODEL.indexOf('/'));
  const keyProvider = API_KEY_PROVIDER_IDS.find((id) => id === provider);
  const keyName = keyProvider ? apiKeyEnvName(keyProvider) : undefined;
  const harness = JSON.parse(
    await readFile(
      join(process.cwd(), 'node_modules/@texra-ai/harness/package.json'),
      'utf8',
    ),
  ) as { version: string };
  const started = new Date().toISOString();
  const missingKey = keyName !== undefined && !process.env[keyName];
  const results: ScenarioResult[] = [];
  /** `TEXRA_ACCEPTANCE_SCENARIOS` (comma-separated names) runs a subset. */
  const only = (process.env.TEXRA_ACCEPTANCE_SCENARIOS ?? '')
    .split(',')
    .filter(Boolean);
  const scenarios = [
    ['codemode', codemode],
    ['plugin', plugin],
    ['crash-resume', crashResume],
  ] as const;
  const unknown = only.filter(
    (name) => !scenarios.some(([known]) => known === name),
  );
  if (unknown.length > 0)
    throw new Error(
      `No scenario named ${unknown.join(', ')}; the scenarios are ${scenarios.map(([name]) => name).join(', ')}.`,
    );
  if (!missingKey)
    for (const [name, program] of scenarios)
      if (only.length === 0 || only.includes(name))
        results.push(
          await runScenario(OUT, name, (dir) =>
            Effect.runPromise(program(dir)),
          ),
        );
  const run = {
    route: provider,
    model: MODEL,
    started,
    harness: harness.version,
    commit: process.env.TEXRA_ACCEPTANCE_COMMIT ?? null,
    node: process.version,
    runLimit: RUN_LIMIT,
    skipped: missingKey ? `${keyName} is not set` : null,
    results,
  };
  await writeReport(OUT, run);
  console.log(`[acceptance] evidence in ${OUT}`);
  // A skipped route is not a pass: nothing ran.
  if (missingKey || results.some((r) => !r.passed)) process.exitCode = 1;
}
