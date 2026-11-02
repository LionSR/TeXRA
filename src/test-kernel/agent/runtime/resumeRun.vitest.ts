/**
 * `resumeRun`, the one door every host resumes a persisted run through, over
 * a real store: each case parks a root run, crashes its process, and resumes
 * it in a fresh session on the validation model, failing or holding the
 * store's own operations where the case needs a race (`StoreFaults`).
 *
 * Failure modes:
 * - a store failure during a resume reads as a refusal, or loses input;
 * - input sent while a resume reads the run, or from its host step, is
 *   lost, left unread, or delivered out of order;
 * - two resumes of one run both launch it;
 * - a run whose input closed while the resume read it is launched anyway;
 * - a resume whose launch fails loses input that raced it, keeps the run
 *   live here, or wedges the next resume;
 * - a host that cannot answer approval prompts has approval-gated tools
 *   offered to the run it resumed;
 * - a stop asked as the resumed run opens still runs a turn;
 * - a user's stop of the resumed run's turn is undone: the input typed
 *   behind that turn wakes the run again; or a message sent once the stop
 *   returns, before its halt commits, is left unread;
 * - a run another live process holds is resumed here, or the host
 *   rearranges itself before the refusal;
 * - a run whose rows do not fold is reported as finished;
 * - a resume whose input the resumed turn's end takes with it answers only
 *   at a later rest, after the turn that input starts;
 * - a user's stop while a resume decides is lost: the stop writes the end,
 *   and the resume activates the stopped run anyway;
 * - the first caller of a resume leaving before admission takes a second
 *   SDK caller's resume down with it;
 * - every caller of a resume leaving before admission leaves the resume
 *   running with no owner, which then activates the run;
 * - a message sent while a resume decides only watches that resume, so the
 *   resume's caller leaving loses the wake;
 * - a run whose process died before its title was written stays untitled
 *   after its resume, or a resume titles it a second time;
 * - R7 of the harness 1.0 release acceptance: a script started before a
 *   crash runs, after a plugin's module changed, the new module source
 *   instead of the one it started with; or a step started after the
 *   change keeps the old one.
 */
import '@test/support/sessionGraphTestSetup';

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Cause, Effect, Fiber, Context, Layer, Schema, Stream } from 'effect';
import { describe, expect } from 'vitest';

import {
  originOf,
  type Model,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm';
import { defineTool, Sessions } from '@texra-ai/harness';
import { ValidationModel, withProcessServices } from '@texra-ai/harness/host';
import { definePlugin } from '@texra-ai/harness/plugins';
import { resumeRun, type ResumeRunOptions } from '@agent/runtime/resumeRun';
import { appendRow, positionRow } from '@agent/runtime/loop/rows';
import {
  submitFollowUp,
  wakeRun,
  Inbox,
} from '@agent/followUp/ToolUseFollowUp';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { SessionLog, RunHistory } from '@shared/session/runHistory';
import { queuedFollowUps } from '@test/support/sessionTestUtils';
import {
  answersOf,
  claimHolder,
  crashedCopy,
  parkedRunAfterCrash,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { SessionGraph } from '@test/support/testKernel';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeSessions } from '../../../../packages/harness/src/effect/sessionPrograms';
import type { RunId } from '@texra-ai/harness/schemas';

/** A resume in `session` on the test process's runtime. */
const resume = (
  runId: RunId,
  {
    session,
    ...options
  }: ResumeRunOptions & { readonly session: Context.Context<SessionServices> },
) =>
  withProcessServices(
    testRuntime(),
    resumeRun(runId, options).pipe(Effect.provide(session)),
  );

/** Send `text` to the run as its user. */
const send = (
  session: Context.Context<SessionServices>,
  runId: RunId,
  text: string,
) => Context.get(session, Inbox).send(runId, { from: { kind: 'user' }, text });

/** The texts the run's rows still queue. */
const queuedTexts = (session: Context.Context<SessionServices>, runId: RunId) =>
  Effect.map(queuedFollowUps(session, runId), (queued) =>
    queued.map((followUp) => followUp.text),
  );

/** How many times the run has been activated: once per launch. */
const activations = (storage: string, runId: RunId) =>
  storedRows(storage).filter(
    (row) => row.run === runId && row.type === 'run.activate',
  ).length;

/** The names of the tools the run's newest `tools.offered` row offers. */
const offeredTools = (storage: string, runId: RunId) => {
  const rows = storedRows(storage).filter(
    (row) => row.run === runId && row.type === 'tools.offered',
  );
  return rows.map((row) =>
    (
      JSON.parse(row.data) as {
        payload: { tools: readonly { name: string }[] };
      }
    ).payload.tools.map((tool) => tool.name),
  );
};

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

/** `session` as the package hands it to an embedder (`Sessions.open`). */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const sessions = yield* makeSessions(
      // cast: the owner opens the one session this case holds.
      { open: () => Effect.succeed(session) } as never,
      yield* testRuntime().contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** What a resume that activated the run answers. */
const ACTIVATED = { activation: expect.any(Number) };

describe(
  'resumeRun over a crashed store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-resume-');

    it.live(
      "a store read that fails under a resume's claim fails it with the store's error, releases the claim, activates nothing and keeps the queued input",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'Keep this input.');
          const faults = yield* sessionStoreFaults(storage);
          // Under the claim, the resume reads the run's queued input and
          // then its lineage (`persistedParentRunId`): that read fails.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.flip(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;
          yield* faults.failNext('readRunRecords');
          yield* input.release;

          const error = yield* Fiber.join(resumed);
          expect(error.message).toContain('injected readRunRecords fault');
          expect(activations(storage, runId)).toBe(1);
          expect(claimHolder(storage, runId)).toBeNull();
          expect(yield* queuedTexts(session, runId)).toEqual([
            'Keep this input.',
          ]);
        }),
    );

    it.live(
      'input sent while a resume reads the run reaches the resumed run',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The first records read finds the run's owner; the second, its
          // config, is inside the resume.
          const owner = yield* faults.holdNext('readRunRecords');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* owner.reached;
          const config = yield* faults.holdNext('readRunRecords');
          yield* owner.release;
          yield* config.reached;

          expect(yield* send(session, runId, 'raced')).toEqual({
            kind: 'queued',
            read: false,
          });
          yield* config.release;
          expect(yield* Fiber.join(resumed)).toMatchObject(ACTIVATED);
          yield* untilStored(
            storage,
            () => answersOf(storage, runId).at(-1)?.includes('raced') ?? false,
          );

          // A root outlives its resume: its input ending ends it.
          yield* Context.get(session, Inbox).closeInput(runId);
          yield* untilStored(
            storage,
            () => endsOf(storage, runId).at(-1) === 'cancelled',
          );
        }),
    );

    it.live(
      'a second resume of a run joins the one in flight, each admitted once',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'once');
          const faults = yield* sessionStoreFaults(storage);
          // The first resume waits on the run's claim, inside its resume.
          const claim = yield* faults.holdNext('acquireClaims');
          const first = yield* Effect.forkChild(resume(runId, { session }));
          yield* claim.reached;
          // Joined as it is forked: the resume is the run's activation.
          const second = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* claim.release;

          const joined = yield* Fiber.join(second);
          expect(joined).toMatchObject(ACTIVATED);
          expect(yield* Fiber.join(first)).toEqual(joined);
          expect(activations(storage, runId)).toBe(2);
        }),
    );

    it.live(
      'a resume on a host that cannot answer approval prompts offers its run no approval-gated tool',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash({
            interactions: { approvalPromptsUnavailable: true },
          });
          yield* send(session, runId, 'continue');

          expect(yield* resume(runId, { session })).toMatchObject(ACTIVATED);
          yield* untilStored(
            storage,
            () => offeredTools(storage, runId).length > 1,
          );
          const [launched, resumed] = offeredTools(storage, runId);
          expect(launched).toContain('bash');
          expect(resumed).toContain('read_file');
          expect(resumed).not.toContain('bash');
          // The notice names only the declared tools it withholds: `plan`,
          // which the persona declares and the goal plugin also injects,
          // once.
          const withheld = storedRows(storage).flatMap((row) => {
            if (row.run !== runId || row.type !== 'log') return [];
            const { message } = JSON.parse(row.data) as { message: string };
            const names = /^Not offering ([^:]+):/.exec(message)?.[1];
            return names === undefined ? [] : names.split(', ');
          });
          expect(withheld).toContain('bash');
          expect(withheld.filter((name) => name === 'plan')).toEqual(['plan']);
        }),
    );

    it.live(
      'a resume whose input the turn end takes with it answers at that commit',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          // The crash cut a turn short: its message taken, its answer not given.
          yield* Effect.gen(function* () {
            yield* Context.get(session, SessionLog).hold(runId);
            const parked = yield* Context.get(session, RunHistory).load(runId);
            if (parked === null) throw new Error('The run has no history.');
            const cell = yield* Context.get(session, RunHistory).open(runId);
            yield* cell.append([
              appendRow(runId, [
                {
                  role: 'user',
                  content: [{ kind: 'text', text: 'answer me' }],
                },
              ]),
              positionRow(runId, parked, 'turn.ready'),
            ]);
          }).pipe(Effect.scoped);
          // Read at a turn's end, never mid-turn; the turn it starts holds
          // its model call until released.
          yield* Context.get(session, Inbox).send(
            runId,
            { from: { kind: 'user' }, text: 'GOLDEN-PARK then this' },
            { hold: 'turn' },
          );

          // The receipt is what a wake (no caller holds the run) answers on.
          yield* Effect.flatten(wakeRun(runId).pipe(Effect.provide(session)));
          expect(answersOf(storage, runId)).toHaveLength(2);
          writeFileSync(
            join(testWorkspaceRoots().storage, 'golden-park.release'),
            '',
          );
        }),
    );

    it.live(
      'a run a live process elsewhere holds is refused before the host rearranges',
      () =>
        Effect.gen(function* () {
          // A live pid (this process's parent) whose start identity was
          // never read: no proof finds it dead.
          const owner = JSON.stringify(['other-host', process.ppid, null]);
          const { session, runId, storage } = yield* parkedRunAfterCrash({
            owner,
          });

          expect(yield* resume(runId, { session })).toEqual({
            failed: { kind: 'ownedElsewhere', owner },
          });
          expect(activations(storage, runId)).toBe(1);
        }),
    );
    it.live(
      "a user's stop while a resume decides ends the run cancelled, keeps the stop's reason, and the resume activates nothing",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // Past its checks under the claim, the resume reads the run's
          // input before it launches: the stop lands there.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.exit(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;

          const stop = Context.get(session, Runs).stop(runId, {
            reason: 'user',
            detachActiveChildren: false,
          });
          expect(Context.get(session, Runs).stopCause(runId)).toBe('user');
          yield* stop.settlement.pipe(Effect.provide(session));
          yield* input.release;
          yield* Fiber.join(resumed);

          expect(endsOf(storage, runId)).toEqual(['cancelled']);
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      "a user's stop after a resume launched its generation, before admission, ends the run cancelled once",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The resume reads the run's input and lineage, then launches its
          // generation, whose first read the stop lands on.
          const claim = yield* faults.holdNext('acquireClaims');
          const resumed = yield* Effect.forkChild(
            Effect.exit(resume(runId, { session })),
          );
          yield* claim.reached;
          const input = yield* faults.holdNext('readAggregate');
          yield* claim.release;
          yield* input.reached;
          const lineage = yield* faults.holdNext('readRunRecords');
          yield* input.release;
          yield* lineage.reached;
          const launched = yield* faults.holdNext('readRunRecords');
          yield* lineage.release;
          yield* launched.reached;
          // Its generation holds the run here, not yet admitted.
          expect(Context.get(session, Runs).get(runId)).toBeDefined();

          Context.get(session, Runs).stop(runId, {
            reason: 'user',
            detachActiveChildren: false,
          });
          expect(Context.get(session, Runs).stopCause(runId)).toBe('user');
          yield* launched.release;
          yield* Fiber.join(resumed);

          expect(endsOf(storage, runId)).toEqual(['cancelled']);
          expect(activations(storage, runId)).toBe(1);
        }),
    );

    it.live(
      'a second SDK resumer is handed the run when the first leaves before admission',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          yield* send(session, runId, 'once');
          const sdk = yield* packageSession(session);
          const faults = yield* sessionStoreFaults(storage);
          const claim = yield* faults.holdNext('acquireClaims');
          const first = yield* Effect.forkChild(sdk.resume(runId), {
            startImmediately: true,
          });
          yield* claim.reached;
          const second = yield* Effect.forkChild(sdk.resume(runId), {
            startImmediately: true,
          });
          yield* Fiber.interrupt(first);
          yield* claim.release;

          const run = yield* Fiber.join(second);
          expect(run.runId).toBe(runId);
          expect((yield* run.result).outcome).toBe('completed');
          expect(activations(storage, runId)).toBe(2);
        }),
    );

    it.live(
      'a resume whose every caller leaves before it admits the run is stopped, activating nothing',
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          const claim = yield* faults.holdNext('acquireClaims');
          const first = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* claim.reached;
          const second = yield* Effect.forkChild(resume(runId, { session }), {
            startImmediately: true,
          });
          yield* Fiber.interrupt(first);
          yield* Fiber.interrupt(second);
          yield* claim.release;

          // Nothing is left to activate it: no activation comes within a
          // bound that a live resume meets many times over.
          const activated = yield* untilStored(
            storage,
            () => activations(storage, runId) > 1,
          ).pipe(Effect.timeout('3 seconds'), Effect.exit);
          expect(
            activated._tag === 'Failure' && Cause.squash(activated.cause),
          ).toBeInstanceOf(Cause.TimeoutError);
          expect(Context.get(session, Runs).get(runId)).toBeUndefined();
        }),
    );

    it.live(
      "a message sent while a resume decides wakes the run though the resume's caller leaves",
      () =>
        Effect.gen(function* () {
          const { session, runId, storage } = yield* parkedRunAfterCrash();
          const faults = yield* sessionStoreFaults(storage);
          // The resume reads the run's config, before its claim.
          const owner = yield* faults.holdNext('readRunRecords');
          const resumed = yield* Effect.forkChild(resume(runId, { session }));
          yield* owner.reached;
          const config = yield* faults.holdNext('readRunRecords');
          yield* owner.release;
          yield* config.reached;

          expect(
            yield* submitFollowUp(
              runId,
              { from: { kind: 'user' }, text: 'woken' },
              {},
            ).pipe(Effect.provide(session)),
          ).toEqual({ status: 'queued' });
          yield* Fiber.interrupt(resumed);
          yield* config.release;

          yield* untilStored(storage, () =>
            answersOf(storage, runId).some((answer) =>
              answer.includes('woken'),
            ),
          );
        }),
    );

    it.live('a run the crash left untitled is titled once by its resume', () =>
      Effect.gen(function* () {
        // The title is lost with the killed process: its write fails.
        const faults = yield* sessionStoreFaults(testWorkspaceRoots().storage);
        yield* faults.failNext('appendAll', 'run.description');
        const { session, runId, storage } = yield* parkedRunAfterCrash();
        const titles = () =>
          storedRows(storage).filter(
            (row) => row.run === runId && row.type === 'run.description',
          );
        expect(titles()).toEqual([]);

        expect(yield* resume(runId, { session })).toMatchObject(ACTIVATED);
        yield* untilStored(storage, () => titles().length > 0);
        expect(titles()).toHaveLength(1);
      }),
    );
  },
);

/** The release file a case's `wait_release` calls wait for. */
const releaseFile = () => join(testWorkspaceRoots().workspace!, 'release');

/**
 * A native plugin whose script module `builtIn:notes` exports `version`,
 * and whose `wait_release` tool, safe to repeat, waits for the release file.
 */
const notesPlugin = (version: number) =>
  definePlugin({
    id: 'notes',
    tools: [
      defineTool({
        name: 'wait_release',
        description: 'Wait until the release file exists.',
        replay: 'safe',
        schema: Schema.Struct({ file: Schema.String }),
        execute: ({ file }) =>
          Effect.gen(function* () {
            while (!existsSync(file)) yield* Effect.sleep('20 millis');
            return {
              status: 'executed' as const,
              output: 'released',
              summary: 'released',
            };
          }),
      }),
    ],
    scriptModules: { notes: `export const version = ${version};` },
  });

/** The script each step runs: the module's version, after a wait in the
 *  first step only. */
const versionScript = (wait: boolean) =>
  [
    "const { version } = await import('builtIn:notes');",
    ...(wait
      ? [
          `await tools.wait_release({ file: ${JSON.stringify(releaseFile())} });`,
        ]
      : []),
    'return { version };',
  ].join('\n');

/**
 * The model of the module cases, behind the validation route: the first
 * step runs a script that waits, the second a script that does not, the
 * third answers. A step is its count of tool results.
 */
const moduleModel = Layer.succeed(ValidationModel)({
  enabled: Effect.succeed(true),
  bind: (config) => {
    const origin = originOf({
      protocol: 'openai-responses',
      requestedModel: config.id,
      deployment: {
        endpoint: 'https://validation.invalid/v1',
        credentialScope: 'validation',
      },
    });
    const model: Model = {
      prepareTurn: (request) =>
        Effect.succeed({
          ...origin,
          mode: 'foreground',
          system: request.system,
          messages: request.messages,
          tools: request.tools ?? [],
          transport: { kind: 'http' },
          controls: {
            temperature: 0,
            maxOutputTokens: request.maxOutputTokens ?? config.maxOutputTokens,
            store: false,
            parallelToolCalls: true,
            toolChoice: request.toolChoice ?? 'auto',
            reasoning: null,
            serviceTier: null,
          },
        }),
      streamTurn: (turn) =>
        Stream.sync(() => {
          const step = turn.messages.filter((m) => m.role === 'tool').length;
          const content: TurnResult['content'] =
            step < 2
              ? [
                  {
                    kind: 'local-call',
                    providerCallId: `script-${step}`,
                    name: 'script',
                    argumentsText: JSON.stringify({
                      title: `Step ${step}`,
                      code: versionScript(step === 0),
                    }),
                  },
                ]
              : [
                  {
                    kind: 'message',
                    content: [{ kind: 'text', text: 'Both steps ran.' }],
                  },
                ];
          return {
            kind: 'completed',
            result: {
              kind: 'http',
              providerResponseId: `response-${step}`,
              requestedOrigin: origin,
              returnedModel: config.id,
              modelFingerprint: null,
              content,
              finishReason: step < 2 ? 'tool-calls' : 'stop',
              usage: null,
            },
          } satisfies TurnEvent;
        }),
    };
    return { origin, model };
  },
});

/** A process as every TeXRA host composes it, with the notes plugin at
 *  module `version`, on the module model. */
const moduleProcess = (version: number) =>
  SessionGraph.with([notesPlugin(version)], moduleModel);

/** The values the run's `script` calls returned, in order. */
const scriptValues = (storage: string, runId: RunId) =>
  storedRows(storage).flatMap((row) => {
    if (row.run !== runId || row.type !== 'tool.result') return [];
    const { payload } = JSON.parse(row.data) as {
      payload: { callId: string; result: { value?: unknown } };
    };
    // The model's own calls, not the ones a script made.
    return payload.callId.startsWith('script-') && !payload.callId.includes('/')
      ? [{ call: payload.callId, value: payload.result.value }]
      : [];
  });

describe(
  'resumeRun over a changed plugin module',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    validationHost('texra-module-');

    it.live(
      'R7: a script started before the crash runs its saved module source; a step started after the update imports the new one',
      () =>
        Effect.gen(function* () {
          const roots = testWorkspaceRoots();
          // The first process, at module version 1, dies while the first
          // step's script waits.
          const { runId, storage } = yield* Effect.scoped(
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const session = yield* sessions.open(roots, {
                persistent: true,
                host: {},
              });
              const run = yield* session.start({
                agent: {
                  name: 'module_reader',
                  description: 'Reads a module version in two steps.',
                  prompt: 'Read the module version.',
                  tools: ['script', 'wait_release'],
                },
                instruction: 'Read the version twice.',
                model: 'openai/gpt-5.6-sol',
              });
              yield* untilStored(roots.storage, (rows) =>
                rows.some(
                  (row) =>
                    row.run === run.runId &&
                    row.type === 'tool.intent' &&
                    row.data.includes('"kind":"script"'),
                ),
              );
              const storage = crashedCopy(roots.storage);
              yield* sessions.close(roots);
              return { runId: run.runId, storage };
            }).pipe(Effect.provide(moduleProcess(1))),
          );
          expect(scriptValues(storage, runId)).toEqual([]);

          // The second process, at module version 2, resumes it: the started
          // script finishes on its saved source, the next step's script
          // imports the update.
          writeFileSync(releaseFile(), '');
          const end = yield* Effect.scoped(
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const session = yield* sessions.open(
                { ...roots, storage },
                { persistent: true, host: {} },
              );
              const run = yield* session.resume(runId);
              const end = yield* run.result;
              yield* sessions.close({ ...roots, storage });
              return end;
            }).pipe(Effect.provide(moduleProcess(2))),
          );
          expect(end.outcome).toBe('completed');
          expect(scriptValues(storage, runId)).toEqual([
            { call: 'script-0', value: { version: 1 } },
            { call: 'script-1', value: { version: 2 } },
          ]);
        }),
    );
  },
);
