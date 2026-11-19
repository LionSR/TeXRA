/**
 * Example 12 — `/model` and `/compact` on a run that was just resumed.
 *
 * A model switch (`run.model`) and a compaction (`run.compact`) are queued
 * on the run's input and answered as soon as the input holds them, not when
 * the run ends. A run nobody runs here takes neither, and says why.
 *
 * 1. Starts an interactive run in a persistent session, lets it wait for
 *    input, and closes the session.
 * 2. Reopens the store. Before the resume, `run.model` is refused as
 *    `Unavailable`, with the reason.
 * 3. Resumes the run and, as soon as the handle is back, switches its model
 *    and asks for a compaction. Both are answered while the run is still
 *    live with no end.
 * 4. Sends a message. The new model wrote the compaction's summary, the
 *    conversation after it holds the summary instead of the earlier turns,
 *    and the message's turn is requested once, from the new model.
 */
import { Effect, Layer, Option, Stream } from 'effect';
import { Sessions, type LocalSession } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import type { RunId } from '@texra-ai/harness/schemas';

import { EXAMPLE_CLIENT, makeExampleWorkspace } from './_support.ts';

const SWITCHED = 'anthropic/claude-haiku-5-5';
const SUMMARY = 'So far: a three-step outline of the proof.';

const { platform, requests, route } = await makeExampleWorkspace([
  { expect: 'Outline the proof.', text: 'Outlined the proof in three steps.' },
  // The compaction's summary, asked of the model the run switched to.
  { text: SUMMARY },
  // The turn a `/compact` is, over the summary alone.
  { expect: SUMMARY, text: 'Compacted.' },
  { expect: 'Fill in step 2.', text: 'Filled in step 2.' },
]);

const inSession = <A, E>(
  use: (session: LocalSession) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* (yield* Sessions).open(platform.roots, {
        persistent: true,
      });
      return yield* use(session);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sessions.layer({
          platform,
          plugins: harnessBuiltins,
          client: EXAMPLE_CLIENT,
        }).pipe(Layer.provideMerge(route.transport)),
      ),
    ),
  );

/** The view once the run waits for input with `turn` turns behind it. */
const waitsAtTurn = (session: LocalSession, runId: RunId, turn: number) =>
  Stream.runHead(
    Stream.filter(
      Stream.concat(
        Stream.succeed(session.view.current()),
        session.view.changes,
      ),
      (view) => {
        const run = view.runs.get(runId);
        return run?.position === 'waiting' && (run.turn ?? 0) >= turn;
      },
    ),
  ).pipe(Effect.map(Option.getOrThrow), Effect.timeout('10 seconds'));

const runId = await inSession((session) =>
  Effect.gen(function* () {
    const run = yield* session.start({
      agent: {
        name: 'proof_writer',
        description: 'Writes a proof step by step.',
        prompt: 'Write what is asked, briefly.',
        tools: [],
      },
      instruction: 'Outline the proof.',
      model: route.model,
      interactive: true,
    });
    yield* waitsAtTurn(session, run.runId, 1);
    return run.runId;
  }),
);

await inSession((session) =>
  Effect.gen(function* () {
    const model = { kind: 'run.model', runId, model: SWITCHED } as const;
    // 2. Nobody runs it here yet: the switch is refused, with the reason.
    const refused = yield* Effect.flip(session.request(model));
    if (refused._tag !== 'Unavailable')
      throw new Error(
        `run.model before the resume: ${JSON.stringify(refused)}`,
      );
    console.log(`[12] before the resume: ${refused._tag} (${refused.reason})`);

    // 3. Asked the moment the resume hands the run back.
    const resumed = yield* session.resume(runId, { interactive: true });
    const switched = yield* session
      .request(model)
      .pipe(Effect.timeout('5 seconds'));
    const compacted = yield* session
      .request({ kind: 'run.compact', runId })
      .pipe(Effect.result, Effect.timeout('5 seconds'));
    const live = session.view.current().runs.get(runId);
    if (session.held(runId) === undefined || live?.outcome != null)
      throw new Error(
        `the controls were answered by the run's end: ${JSON.stringify(live?.outcome)}`,
      );
    console.log(
      `[12] after it: run.model answered ${switched.kind}, run.compact ${compacted._tag === 'Success' ? `answered ${compacted.success.kind}` : `refused (${compacted.failure._tag}: ${'reason' in compacted.failure ? compacted.failure.reason : ''})`}; the run is live`,
    );

    // 4. The next turn is the switched model's.
    yield* session.request({
      kind: 'followUp.send',
      runId,
      text: 'Fill in step 2.',
    });
    yield* waitsAtTurn(session, runId, 3);
    yield* session.drained;
    const models = requests.map((request) => request.model);
    // The turn a `/compact` is: the summary stands in for the earlier turns.
    const compact = JSON.stringify(requests[2]);
    const viewed = session.view.current().runs.get(runId)?.model;
    if (
      models.join() !==
        'claude-sonnet-5-5,claude-haiku-5-5,claude-haiku-5-5,claude-haiku-5-5' ||
      viewed !== SWITCHED ||
      !compact.includes(SUMMARY) ||
      compact.includes('Outlined the proof in three steps.')
    )
      throw new Error(
        `the controls did not take: ${JSON.stringify({ models, viewed, compact })}`,
      );
    console.log(
      `[12] compacted to the summary, and the message's turn was requested from ${models.at(-1)}; ${requests.length} model requests in all`,
    );
    yield* session.request({ kind: 'run.stop', runId, reason: 'user' });
    const end = yield* resumed.result.pipe(Effect.timeout('10 seconds'));
    if (end.outcome !== 'cancelled')
      throw new Error(`the stopped run: ${JSON.stringify(end)}`);
  }),
);
