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
 * - R18: a `/compact` sent while a resume runs its turn is answered only
 *   once the run rests, not when its input takes it.
 * - R20: a message retried under its id once the run's input closed is
 *   refused, sent again or resumes the run, instead of answering with the
 *   first send's receipt; or a different message under that id is sent.
 * - R21: messages merged into one turn read as answered by different rows,
 *   or a turn that failed reads as answered.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { layer } from '@effect/vitest';
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  Context,
  Layer,
  Schema,
  Stream,
} from 'effect';
import { describe, expect } from 'vitest';

import {
  ModelError,
  originOf,
  type Model,
  type TurnEvent,
  type TurnResult,
} from '@texra-ai/llm';
import { Conflict, defineTool, Sessions } from '@texra-ai/harness';
import { ValidationModel } from '@texra-ai/harness/host';
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
  parkedAfter,
  parkedRunAfterCrash,
  sessionStoreFaults,
  storedRows,
  untilStored,
  REAL_RUN_TIMEOUT,
  validationHost,
} from '@test/support/storeFaults';
import { SessionGraph } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { makeSessions } from '../../../../packages/harness/src/effect/sessionPrograms';
import type { RunId } from '@texra-ai/harness/schemas';

/** A resume in `session`. */
const resume = (
  runId: RunId,
  {
    session,
    ...options
  }: ResumeRunOptions & { readonly session: Context.Context<SessionServices> },
) => resumeRun(runId, options).pipe(Effect.provide(session));

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

/** `session` as the package hands it to an embedder (`Sessions.open`),
 *  over the block's process services. */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const sessions = yield* makeSessions(
      // cast: the owner opens the one session this case holds.
      { open: () => Effect.succeed(session) } as never,
      yield* (yield* SessionGraph.runtime).contextEffect,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** What a resume that activated the run answers. */
const ACTIVATED = { activation: expect.any(Number) };

describe(
  'resumeRun over a crashed store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-resume-'), { buildPerTest: true })(
        (it) => {
          it.effect(
            "a store read that fails under a resume's claim fails it with the store's error, releases the claim, activates nothing and keeps the queued input",
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
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
                expect(error.message).toContain(
                  'injected readRunRecords fault',
                );
                expect(activations(storage, runId)).toBe(1);
                expect(claimHolder(storage, runId)).toBeNull();
                expect(yield* queuedTexts(session, runId)).toEqual([
                  'Keep this input.',
                ]);
              }),
          );

          it.effect(
            'input sent while a resume reads the run reaches the resumed run',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                const faults = yield* sessionStoreFaults(storage);
                // The first records read finds the run's owner; the second, its
                // config, is inside the resume.
                const owner = yield* faults.holdNext('readRunRecords');
                const resumed = yield* Effect.forkChild(
                  resume(runId, { session }),
                );
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
                  () =>
                    answersOf(storage, runId).at(-1)?.includes('raced') ??
                    false,
                );

                // A root outlives its resume: its input ending ends it.
                yield* Context.get(session, Inbox).closeInput(runId);
                yield* untilStored(
                  storage,
                  () => endsOf(storage, runId).at(-1) === 'cancelled',
                );
              }),
          );

          it.effect(
            'a second resume of a run joins the one in flight, each admitted once',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                yield* send(session, runId, 'once');
                const faults = yield* sessionStoreFaults(storage);
                // The first resume waits on the run's claim, inside its resume.
                const claim = yield* faults.holdNext('acquireClaims');
                const first = yield* Effect.forkChild(
                  resume(runId, { session }),
                );
                yield* claim.reached;
                // Joined as it is forked: the resume is the run's activation.
                const second = yield* Effect.forkChild(
                  resume(runId, { session }),
                  {
                    startImmediately: true,
                  },
                );
                yield* claim.release;

                const joined = yield* Fiber.join(second);
                expect(joined).toMatchObject(ACTIVATED);
                expect(yield* Fiber.join(first)).toEqual(joined);
                expect(activations(storage, runId)).toBe(2);
              }),
          );

          it.effect(
            'a resume on a host that cannot answer approval prompts offers its run no approval-gated tool',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } = yield* parkedRunAfterCrash({
                  interactions: { approvalPromptsUnavailable: true },
                });
                yield* send(session, runId, 'continue');

                expect(yield* resume(runId, { session })).toMatchObject(
                  ACTIVATED,
                );
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
                  const { message } = JSON.parse(row.data) as {
                    message: string;
                  };
                  const names = /^Not offering ([^:]+):/.exec(message)?.[1];
                  return names === undefined ? [] : names.split(', ');
                });
                expect(withheld).toContain('bash');
                expect(withheld.filter((name) => name === 'plan')).toEqual([
                  'plan',
                ]);
              }),
          );

          it.effect(
            'a resume whose input the turn end takes with it answers at that commit',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                // The crash cut a turn short: its message taken, its answer not given.
                yield* Effect.gen(function* () {
                  yield* Context.get(session, SessionLog).hold(runId);
                  const parked = yield* Context.get(session, RunHistory).load(
                    runId,
                  );
                  if (parked === null)
                    throw new Error('The run has no history.');
                  const cell = yield* Context.get(session, RunHistory).open(
                    runId,
                  );
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
                yield* Effect.flatten(
                  wakeRun(runId).pipe(Effect.provide(session)),
                );
                expect(answersOf(storage, runId)).toHaveLength(2);
                writeFileSync(
                  join(testWorkspaceRoots().storage, 'golden-park.release'),
                  '',
                );
              }),
          );

          it.effect(
            'a run a live process elsewhere holds is refused before the host rearranges',
            () =>
              Effect.gen(function* () {
                // A live pid (this process's parent) whose start identity was
                // never read: no proof finds it dead.
                const owner = JSON.stringify([
                  'other-host',
                  process.ppid,
                  null,
                ]);
                const { session, runId, storage } = yield* parkedRunAfterCrash({
                  owner,
                });

                expect(yield* resume(runId, { session })).toEqual({
                  failed: { kind: 'ownedElsewhere', owner },
                });
                expect(activations(storage, runId)).toBe(1);
              }),
          );
          it.effect(
            "a user's stop while a resume decides ends the run cancelled, keeps the stop's reason, and the resume activates nothing",
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
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
                expect(Context.get(session, Runs).stopCause(runId)).toBe(
                  'user',
                );
                yield* stop.settlement.pipe(Effect.provide(session));
                yield* input.release;
                yield* Fiber.join(resumed);

                expect(endsOf(storage, runId)).toEqual(['cancelled']);
                expect(activations(storage, runId)).toBe(1);
              }),
          );

          it.effect(
            "a user's stop after a resume launched its generation, before admission, ends the run cancelled once",
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
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
                expect(Context.get(session, Runs).stopCause(runId)).toBe(
                  'user',
                );
                yield* launched.release;
                yield* Fiber.join(resumed);

                expect(endsOf(storage, runId)).toEqual(['cancelled']);
                expect(activations(storage, runId)).toBe(1);
              }),
          );

          it.effect(
            'a second SDK resumer is handed the run when the first leaves before admission',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
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

          it.effect(
            'a resume whose every caller leaves before it admits the run is stopped, activating nothing',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                const faults = yield* sessionStoreFaults(storage);
                const claim = yield* faults.holdNext('acquireClaims');
                const first = yield* Effect.forkChild(
                  resume(runId, { session }),
                  {
                    startImmediately: true,
                  },
                );
                yield* claim.reached;
                const second = yield* Effect.forkChild(
                  resume(runId, { session }),
                  {
                    startImmediately: true,
                  },
                );
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

          it.effect(
            "a message sent while a resume decides wakes the run though the resume's caller leaves",
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                const faults = yield* sessionStoreFaults(storage);
                // The resume reads the run's config, before its claim.
                const owner = yield* faults.holdNext('readRunRecords');
                const resumed = yield* Effect.forkChild(
                  resume(runId, { session }),
                );
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

          it.effect(
            'R20: a message retried under its id after its run took no more input answers with its receipt; a different message under it is a conflict',
            () =>
              Effect.gen(function* () {
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                const sdk = yield* packageSession(session);
                const message = {
                  kind: 'followUp.send',
                  runId,
                  id: 'note-1',
                  text: 'Add the lemma.',
                } as const;
                expect(yield* sdk.request(message)).toMatchObject({
                  kind: 'followUp',
                  id: 'note-1',
                });
                const { receipt } = yield* sdk.request({
                  kind: 'followUp.receipt',
                  runId,
                  id: 'note-1',
                  wait: true,
                });
                expect(receipt).toEqual({
                  state: 'answered',
                  turn: 2,
                  answer: expect.any(Number),
                });
                // The acknowledgement is lost, and the run's input closes.
                yield* Context.get(session, Inbox).closeInput(runId);
                yield* untilStored(
                  storage,
                  () => endsOf(storage, runId).at(-1) === 'cancelled',
                );

                expect(yield* sdk.request(message)).toEqual({
                  kind: 'followUp',
                  id: 'note-1',
                  status: 'sent',
                  receipt,
                });
                const conflict = yield* Effect.flip(
                  sdk.request({ ...message, text: 'Drop the lemma.' }),
                );
                expect(conflict).toBeInstanceOf(Conflict);
                expect(conflict).toMatchObject({ runId, id: 'note-1' });
                const queued = storedRows(storage).filter(
                  (row) => row.run === runId && row.type === 'followup.queued',
                );
                expect(queued).toHaveLength(1);
                expect(activations(storage, runId)).toBe(2);
              }),
          );

          it.effect(
            'a run the crash left untitled is titled once by its resume',
            () =>
              Effect.gen(function* () {
                // The title is lost with the killed process: its write fails.
                const faults = yield* sessionStoreFaults(
                  testWorkspaceRoots().storage,
                );
                yield* faults.failNext('appendAll', 'run.description');
                const { session, runId, storage } =
                  yield* parkedRunAfterCrash();
                const titles = () =>
                  storedRows(storage).filter(
                    (row) =>
                      row.run === runId && row.type === 'run.description',
                  );
                expect(titles()).toEqual([]);

                expect(yield* resume(runId, { session })).toMatchObject(
                  ACTIVATED,
                );
                yield* untilStored(storage, () => titles().length > 0);
                expect(titles()).toHaveLength(1);
              }),
          );
        },
      );
    });
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
 *  module `version`, on the module model. A case provides it `local`, so
 *  it is built whole: none of its services come from the block's memo map,
 *  where the block's own process holds the same layers. */
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
    layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-module-'), { buildPerTest: true })(
        (it) => {
          it.effect(
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
                  }).pipe(Effect.provide(moduleProcess(1), { local: true })),
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
                  }).pipe(Effect.provide(moduleProcess(2), { local: true })),
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
    });
  },
);

/** The text of the user messages after the model's last answer. */
const askedSinceAnswer = (
  messages: Parameters<Model['streamTurn']>[0]['messages'],
): string =>
  messages
    .slice(messages.findLastIndex((m) => m.role === 'assistant') + 1)
    .flatMap((m) =>
      m.role === 'user'
        ? m.content.flatMap((part) => (part.kind === 'text' ? [part.text] : []))
        : [],
    )
    .join('\n');

/**
 * The model of the receipt cases, behind the validation route: it answers
 * each turn with what it was asked since its last answer, once the gate a
 * `WAIT<n>` there names opens, and refuses, for good, a turn that asks
 * `FAIL`. A gate tells a case when a turn reached it.
 */
const receiptModel = () => {
  const gates = new Map<
    string,
    { reached: Deferred.Deferred<void>; open: Deferred.Deferred<void> }
  >();
  const gate = (name: string) => {
    const found = gates.get(name);
    if (found !== undefined) return found;
    const made = {
      reached: Deferred.makeUnsafe<void>(),
      open: Deferred.makeUnsafe<void>(),
    };
    gates.set(name, made);
    return made;
  };
  const layer = Layer.succeed(ValidationModel)({
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
              maxOutputTokens:
                request.maxOutputTokens ?? config.maxOutputTokens,
              store: false,
              parallelToolCalls: true,
              toolChoice: request.toolChoice ?? 'auto',
              reasoning: null,
              serviceTier: null,
            },
          }),
        streamTurn: (turn) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const asked = askedSinceAnswer(turn.messages);
              const waits = /WAIT\d/.exec(asked)?.[0];
              if (waits !== undefined) {
                yield* Deferred.succeed(gate(waits).reached, undefined);
                yield* Deferred.await(gate(waits).open);
              }
              const refused: Stream.Stream<TurnEvent, ModelError> = Stream.fail(
                new ModelError({
                  kind: 'invalid-request',
                  message: 'The request was refused.',
                  retryable: false,
                }),
              );
              if (asked.includes('FAIL')) return refused;
              return Stream.succeed<TurnEvent>({
                kind: 'completed',
                result: {
                  kind: 'http',
                  providerResponseId: `response-${asked.length}`,
                  requestedOrigin: origin,
                  returnedModel: config.id,
                  modelFingerprint: null,
                  content: [
                    {
                      kind: 'message',
                      content: [{ kind: 'text', text: `Answered: ${asked}` }],
                    },
                  ],
                  finishReason: 'stop',
                  usage: null,
                },
              });
            }),
          ),
      };
      return { origin, model };
    },
  });
  return { process: SessionGraph.with([], layer), gate };
};

/** The persona the receipt cases run. */
const NOTES_AGENT = {
  name: 'note_taker',
  description: 'Answers each message.',
  prompt: 'Answer each message.',
  tools: [],
};

describe('input receipts', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-receipt-'), { buildPerTest: true })((it) => {
      it.effect(
        'R21: messages merged into one turn share its answer; those of a turn that fails are unanswered for it',
        () => {
          const { process, gate } = receiptModel();
          return Effect.gen(function* () {
            const roots = testWorkspaceRoots();
            const sessions = yield* Sessions;
            const session = yield* sessions.open(roots, {
              persistent: true,
              host: {},
            });
            const run = yield* session.start({
              agent: NOTES_AGENT,
              instruction: 'WAIT1 Start the notes.',
              model: 'openai/gpt-5.6-sol',
              interactive: true,
            });
            const { runId } = run;
            const send = (id: string, text: string) =>
              session.request({ kind: 'followUp.send', runId, id, text });
            const receipt = (id: string) =>
              Effect.map(
                session.request({
                  kind: 'followUp.receipt',
                  runId,
                  id,
                  wait: true,
                }),
                (answer) => answer.receipt,
              );
            // Two messages typed while a turn runs become the next turn's.
            yield* Deferred.await(gate('WAIT1').reached);
            yield* send('a', 'WAIT2 First point.');
            yield* send('b', 'Second point.');
            yield* Deferred.succeed(gate('WAIT1').open, undefined);
            yield* Deferred.await(gate('WAIT2').reached);
            yield* send('c', 'FAIL Third point.');
            yield* send('d', 'Fourth point.');
            yield* Deferred.succeed(gate('WAIT2').open, undefined);

            const answered = yield* receipt('a');
            expect(answered).toEqual({
              state: 'answered',
              turn: 2,
              answer: expect.any(Number),
            });
            expect(yield* receipt('b')).toEqual(answered);
            const failed = {
              state: 'unanswered',
              turn: 3,
              reason: 'failed',
            } as const;
            expect(yield* receipt('c')).toEqual(failed);
            expect(yield* receipt('d')).toEqual(failed);
            yield* sessions.close(roots);
          }).pipe(Effect.scoped, Effect.provide(process, { local: true }));
        },
      );

      it.effect(
        'R18: a /compact sent while a resume runs its turn is answered once the run takes it',
        () => {
          const { process, gate } = receiptModel();
          return Effect.gen(function* () {
            const roots = testWorkspaceRoots();
            // The first process parks the run, then dies.
            const { runId, storage } = yield* Effect.scoped(
              Effect.gen(function* () {
                const sessions = yield* Sessions;
                const session = yield* sessions.open(roots, {
                  persistent: true,
                  host: {},
                });
                const run = yield* session.start({
                  agent: NOTES_AGENT,
                  instruction: 'Start the notes.',
                  model: 'openai/gpt-5.6-sol',
                  interactive: true,
                });
                yield* untilStored(
                  roots.storage,
                  parkedAfter(run.runId, 1, roots.storage),
                );
                const storage = crashedCopy(roots.storage);
                yield* sessions.close(roots);
                return { runId: run.runId, storage };
              }),
            );
            const sessions = yield* Sessions;
            const session = yield* sessions.open(
              { ...roots, storage },
              { persistent: true, host: {} },
            );
            // The message resumes the run, whose turn holds its model call.
            yield* session.request({
              kind: 'followUp.send',
              runId,
              text: 'WAIT1 Go on.',
            });
            yield* Deferred.await(gate('WAIT1').reached);

            expect(
              yield* session
                .request({ kind: 'run.compact', runId })
                .pipe(Effect.timeout('10 seconds')),
            ).toEqual({ kind: 'done' });
            expect(
              storedRows(storage).some(
                (row) =>
                  row.run === runId &&
                  row.type === 'followup.queued' &&
                  row.data.includes('"control":{"kind":"compact"}'),
              ),
            ).toBe(true);
            yield* Deferred.succeed(gate('WAIT1').open, undefined);
            yield* sessions.close({ ...roots, storage });
          }).pipe(Effect.scoped, Effect.provide(process, { local: true }));
        },
      );
    });
  });
});
