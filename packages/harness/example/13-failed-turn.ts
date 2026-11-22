/**
 * Example 13 — A turn the provider refuses: what the run's history and its
 * result say, and what becomes of the messages that turn had taken.
 *
 * 1. Starts an interactive run whose first model request is held. While it
 *    is held, two messages are sent: both are queued, and the run takes
 *    them together as the message of its second turn (each
 *    `followup.consumed` row names that turn).
 * 2. The provider refuses that turn's request with a 400. The run records
 *    the classified failure, stores no answer, and waits for input again.
 * 3. A third message starts the next turn: its request holds the two
 *    earlier messages once each, and the run answers.
 * 4. A run launched to run once ends on the same refusal: `run.result`
 *    succeeds with the stored end, `outcome: 'failed'` and a classified
 *    `error` (`kind: 'model'`, a `provider-rejection` with its status).
 */
import { Effect, Layer, Stream } from 'effect';
import { Sessions } from '@texra-ai/worldline';
import { harnessBuiltins } from '@texra-ai/worldline/builtins';

import { EXAMPLE_CLIENT, makeExampleWorkspace } from './_support.ts';

const FIRST = 'Also cite Lemma 2.';
const SECOND = 'And shorten the introduction.';
const ANSWER = 'Cited Lemma 2 and shortened the introduction.';

/** Releases the first model request. */
let release = (): void => {};
const held = new Promise<void>((resolve) => {
  release = resolve;
});
const { platform, requests, route } = await makeExampleWorkspace([
  {
    expect: 'Revise section 1.',
    text: 'Revised section 1.',
    after: held,
  },
  { expect: FIRST, refuse: 400 },
  { expect: 'Go on.', text: ANSWER },
  { expect: 'Check the references.', refuse: 400 },
]);

/** How often `text` occurs in `value`'s JSON. */
const count = (value: unknown, text: string) =>
  JSON.stringify(value).split(text).length - 1;
/** How many requests the model has been sent. */
const asked = () => requests.length;

const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots, {
    persistent: true,
  });
  const from = session.view.head();
  const run = yield* session.start({
    label: 'section_reviser',
    system: 'Revise what is asked, briefly.',
    tools: [],
    instruction: 'Revise section 1.',
    model: route.model,
    interactive: true,
  });
  const send = (text: string) =>
    session.request({ kind: 'followUp.send', runId: run.runId, text });
  /** The run's rows up to its wait after turn `turn`. */
  const rowsToWaitAfter = (turn: number) =>
    session.view.events(from).pipe(
      Stream.takeUntil(
        (row) =>
          row.type === 'run.position' &&
          row.payload.at === 'waiting' &&
          row.payload.turn === turn,
      ),
      Stream.runCollect,
      Effect.timeout('10 seconds'),
    );

  // 1. Two messages while the first turn waits on the model.
  yield* send(FIRST);
  yield* send(SECOND);
  release();

  // 2. The turn that took them is refused; the run waits again.
  const rows = yield* rowsToWaitAfter(2);
  const takenBy = rows.flatMap((row) =>
    row.type === 'followup.consumed' && row.disposition.kind === 'turn'
      ? [row.disposition.turn]
      : [],
  );
  const failures = rows.flatMap((row) =>
    row.type === 'log' && row.level === 'error' ? [row.data] : [],
  );
  const refused = yield* session.records(run.runId).readConversation;
  yield* session.drained;
  const waiting = session.view.current().runs.get(run.runId);
  if (
    takenBy.join() !== '2,2' ||
    failures.length !== 1 ||
    count(failures, 'provider-rejection') !== 1 ||
    count(requests[1], FIRST) !== 1 ||
    count(requests[1], SECOND) !== 1 ||
    count(refused, FIRST) !== 1 ||
    count(refused, SECOND) !== 1 ||
    count(refused, ANSWER) !== 0 ||
    waiting?.outcome != null
  )
    throw new Error(
      `the refused turn: ${JSON.stringify({ takenBy, failures, refused, outcome: waiting?.outcome })}`,
    );
  console.log(
    `[13] both messages went into turn ${takenBy[0]}; its request was refused (${JSON.stringify(failures[0])}), no answer is stored, and the run waits`,
  );

  // 3. The next turn carries them once each, and is answered.
  yield* send('Go on.');
  yield* rowsToWaitAfter(3);
  const answered = yield* session.records(run.runId).readConversation;
  if (
    asked() !== 3 ||
    count(requests[2], FIRST) !== 1 ||
    count(requests[2], SECOND) !== 1 ||
    count(answered, FIRST) !== 1 ||
    count(answered, SECOND) !== 1 ||
    count(answered, ANSWER) !== 1
  )
    throw new Error(
      `the next turn: ${JSON.stringify({ requests: asked(), answered })}`,
    );
  console.log(
    `[13] the next turn's request held each message once and was answered; ${asked()} model requests so far`,
  );
  yield* session.request({
    kind: 'run.stop',
    runId: run.runId,
    reason: 'user',
  });

  // 4. A run launched to run once ends on the refusal, and its result is
  //    that end.
  const once = yield* session.start({
    label: 'reference_checker',
    system: 'Check what is asked.',
    tools: [],
    instruction: 'Check the references.',
    model: route.model,
  });
  const end = yield* once.result.pipe(Effect.timeout('10 seconds'));
  const failure =
    end.error?.kind === 'model' && end.error.failure.source === 'model'
      ? end.error.failure
      : undefined;
  if (
    end.outcome !== 'failed' ||
    failure?.kind !== 'provider-rejection' ||
    failure.status !== 400 ||
    asked() !== 4
  )
    throw new Error(
      `the failed run's result: ${JSON.stringify({ end, requests: asked() })}`,
    );
  console.log(
    `[13] run.result of the run-once root: outcome=${end.outcome} error.kind=${end.error?.kind} failure=${failure.kind} status=${failure.status}`,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: EXAMPLE_CLIENT,
    }).pipe(Layer.provideMerge(route.transport)),
  ),
);

await Effect.runPromise(program);
