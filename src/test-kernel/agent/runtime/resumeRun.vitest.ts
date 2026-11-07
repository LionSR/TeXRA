/**
 * `resumeRun`, the one door every host resumes a persisted run through, over
 * a real store: each case parks a root run, crashes its process, and resumes
 * it in a fresh session on the validation model, failing or holding the
 * store's own operations where the case needs a race (`StoreFaults`).
 *
 * Failure modes:
 * - a store failure during a resume reads as a refusal, or loses input;
 * - input sent while a resume reads the run is lost or left unread;
 * - a host that cannot answer approval prompts has approval-gated tools
 *   offered to the run it resumed;
 * - a run another live process holds is resumed here, or the host
 *   rearranges itself before the refusal;
 * - a user's stop while a resume decides is lost: the stop writes no
 *   `run.stop` row or no end, or the resume activates the stopped run anyway;
 * - R20: a message retried under its id once the run's input closed is
 *   refused, sent again or resumes the run, instead of answering with the
 *   first send's receipt; or a different message under that id is sent.
 * - R13: a receipt answered before a crash changes once the resumed run
 *   takes later input.
 */
import { layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Context, Layer, Stream } from 'effect';
import { describe, expect } from 'vitest';

import {
  ModelError,
  originOf,
  type Model,
  type TurnEvent,
} from '@texra-ai/llm';
import { Conflict, type LocalSession, Sessions } from '@texra-ai/harness';
import { ValidationModel } from '@texra-ai/harness/host';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { resumeRun, type ResumeRunOptions } from '@agent/runtime/resumeRun';
import { Inbox } from '@agent/followUp/Inbox';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import { queuedFollowUps } from '@test/support/sessionTestUtils';
import {
  answersOf,
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
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';
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
  return rows.map((row) => {
    // cast: a `tools.offered` row's data holds its ToolsOfferedPayload.
    const { payload } = JSON.parse(row.data) as {
      payload: { tools: readonly { name: string }[] };
    };
    return payload.tools.map((tool) => tool.name);
  });
};

/** The outcomes of the run's `run.end` rows, in order. */
const endsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.end')
    // cast: a `run.end` row's data holds the run's outcome.
    .map((row) => (JSON.parse(row.data) as { outcome: string }).outcome);

/** The reasons of the run's `run.stop` rows, in order. */
const stopsOf = (storage: string, runId: RunId) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.stop')
    // cast: a `run.stop` row's data holds the stop's reason.
    .map((row) => (JSON.parse(row.data) as { reason: string }).reason);

/** `session` as the package hands it to an embedder (`Sessions.open`),
 *  over the block's process services. */
const packageSession = (session: Context.Context<SessionServices>) =>
  Effect.gen(function* () {
    const sessions = yield* makeSessions(
      // cast: the owner opens the one session this case holds.
      { open: () => Effect.succeed(session) } as never,
      yield* AgentCatalog,
    );
    return yield* sessions.open(testWorkspaceRoots());
  });

/** What a resume that activated the run answers. */
const ACTIVATED = { activation: expect.any(Number) };

describe(
  'resumeRun over a crashed store',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(texraHosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-resume-', TEXRA_APP), {
        buildPerTest: true,
      })((it) => {
        it.effect(
          "a store read that fails under a resume fails it with the store's error, activates nothing and keeps the queued input",
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* parkedRunAfterCrash();
              yield* send(session, runId, 'Keep this input.');
              const faults = yield* sessionStoreFaults(storage);
              // The resume reads the run's queued input and then its lineage
              // (`persistedParentRunId`): that read fails.
              const input = yield* faults.holdNext('readAggregate');
              const resumed = yield* Effect.forkChild(
                Effect.flip(resume(runId, { session })),
              );
              yield* input.reached;
              yield* faults.failNext('readRunRecords');
              yield* input.release;

              const error = yield* Fiber.join(resumed);
              expect(error.message).toContain('injected readRunRecords fault');
              expect(activations(storage, runId)).toBe(1);
              expect(yield* queuedTexts(session, runId)).toEqual([
                'Keep this input.',
              ]);
            }),
        );

        it.effect(
          'input sent while a resume reads the run reaches the resumed run',
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* parkedRunAfterCrash();
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
              });
              yield* config.release;
              expect(yield* Fiber.join(resumed)).toMatchObject(ACTIVATED);
              yield* untilStored(
                storage,
                () =>
                  answersOf(storage, runId).at(-1)?.includes('raced') ?? false,
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
                // cast: a `log` row's data holds its message.
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
          "a user's stop while a resume decides records its reason, ends the run cancelled, and the resume activates nothing",
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* parkedRunAfterCrash();
              const faults = yield* sessionStoreFaults(storage);
              // Past its record checks, the resume reads the run's input
              // before it launches: the stop lands there.
              const input = yield* faults.holdNext('readAggregate');
              const resumed = yield* Effect.forkChild(
                resume(runId, { session }),
              );
              yield* input.reached;

              // The resume holds the run as it decides: the stop is taken,
              // and the resume ends the run in the batch that records it.
              expect(
                yield* Context.get(session, Runs).stop(runId, 'user'),
              ).toBe(true);
              yield* input.release;
              expect(yield* Fiber.join(resumed)).toHaveProperty('failed');

              expect(stopsOf(storage, runId)).toEqual(['user']);
              expect(endsOf(storage, runId)).toEqual(['cancelled']);
              expect(activations(storage, runId)).toBe(1);
            }),
        );

        it.effect(
          'R20: a message retried under its id after its run took no more input answers with its receipt; a different message under it is a conflict',
          () =>
            Effect.gen(function* () {
              const { session, runId, storage } = yield* parkedRunAfterCrash();
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
      });
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
            controls: {
              temperature: 0,
              maxOutputTokens:
                request.maxOutputTokens ?? config.maxOutputTokens,
              store: false,
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

/**
 * A run of the notes agent that answered its first turn and waits, then
 * `before` on its session, in a process that then dies; and a session of a
 * second process over the store the crash left. Both run on the calling
 * case's process.
 */
const resumedNotesRun = <E = never>(
  before: (
    session: LocalSession,
    runId: RunId,
  ) => Effect.Effect<void, E> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const roots = testWorkspaceRoots();
    const sessions = yield* Sessions;
    const { runId, storage } = yield* Effect.scoped(
      Effect.gen(function* () {
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
        yield* before(session, run.runId);
        const storage = crashedCopy(roots.storage);
        yield* sessions.close(roots);
        return { runId: run.runId, storage };
      }),
    );
    const session = yield* sessions.open(
      { ...roots, storage },
      { persistent: true, host: {} },
    );
    return { runId, storage, session };
  });

/** What `session` answers for the receipt of message `id` to `runId`,
 *  once it has one. */
const receiptOf = (session: LocalSession, runId: RunId, id: string) =>
  Effect.map(
    session.request({ kind: 'followUp.receipt', runId, id, wait: true }),
    (answer) => answer.receipt,
  );

describe('input receipts', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(texraHosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-receipt-', TEXRA_APP), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'R13: a receipt answered before a crash reads the same once the resumed run takes later input',
        () => {
          const { process, gate } = receiptModel();
          return Effect.gen(function* () {
            let answered: Effect.Success<ReturnType<typeof receiptOf>> | null =
              null;
            const { runId, session } = yield* resumedNotesRun(
              (session, runId) =>
                Effect.gen(function* () {
                  yield* session.request({
                    kind: 'followUp.send',
                    runId,
                    id: 'a',
                    text: 'First point.',
                  });
                  answered = yield* receiptOf(session, runId, 'a');
                }),
            );
            expect(answered).toEqual({
              state: 'answered',
              turn: 2,
              answer: expect.any(Number),
            });
            // The next message resumes the run; its turn holds the model
            // call, then answers.
            yield* session.request({
              kind: 'followUp.send',
              runId,
              id: 'b',
              text: 'WAIT1 Second point.',
            });
            yield* Deferred.await(gate('WAIT1').reached);
            expect(yield* receiptOf(session, runId, 'a')).toEqual(answered);
            yield* Deferred.succeed(gate('WAIT1').open, undefined);
            expect(yield* receiptOf(session, runId, 'b')).toEqual({
              state: 'answered',
              turn: 3,
              answer: expect.any(Number),
            });
            expect(yield* receiptOf(session, runId, 'a')).toEqual(answered);
          }).pipe(Effect.scoped, Effect.provide(process, { local: true }));
        },
      );
    });
  });
});
