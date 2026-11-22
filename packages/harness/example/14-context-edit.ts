/**
 * Example 14 — An agent edits its own context (`context`).
 *
 * 1. Starts an interactive run in a persistent session. Its first response
 *    runs a script that returns a long result; its second runs a script
 *    that reads the run's view as data (`tools.context({})`), finds that
 *    result, and replaces it and the call that made it with a note it
 *    writes (`action: 'replace'`).
 * 2. The next request carries the edited view: the note, and not the long
 *    result. The transcript a person reads still holds the result, and shows
 *    the edit as an activity row (messages replaced, tokens freed).
 * 3. Closes the session, reopens the store, resumes the run and sends a
 *    message: the resumed run's request sends the same view.
 */
import { Effect, Layer, Option, type Scope, Stream } from 'effect';
import { Sessions, type LocalSession } from '@texra-ai/worldline';
import { harnessBuiltins } from '@texra-ai/worldline/builtins';
import type { RunId } from '@texra-ai/worldline/schemas';

import { EXAMPLE_CLIENT, makeExampleWorkspace } from './_support.ts';

/** The long result, and the note that stands in for it. */
const LONG = 'measurement '.repeat(400);
const NOTE = 'Earlier: 400 measurements were listed; none is needed again.';

/** The script that reads the view and replaces the long result's exchange. */
const TRIM = `const view = await tools.context({})
const long = view.messages.find((message) => message.kind === 'tool-result' && message.tokens > 1000)
const edit = await tools.context({ action: 'replace', from: long.index - 1, to: long.index + 1, with: ${JSON.stringify(NOTE)} })
return { messages: view.messages.length, tokens: view.tokens, replaced: [edit.from, edit.to], freed: edit.freed }`;

const { platform, requests, route } = await makeExampleWorkspace([
  {
    expect: 'List the measurements.',
    toolCalls: [
      {
        name: 'script',
        input: { code: `return ${JSON.stringify(LONG)}` },
      },
    ],
  },
  { toolCalls: [{ name: 'script', input: { code: TRIM } }] },
  { expect: NOTE, text: 'Listed, and set aside.' },
  { expect: 'Which were they?', text: 'They are summarized in my note.' },
]);

const inSession = <A, E>(
  use: (session: LocalSession) => Effect.Effect<A, E, Scope.Scope>,
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

/** A request's messages as the model reads them, without the cache
 *  markers a request places on its newest blocks. */
const sentMessages = (request: Readonly<Record<string, unknown>>) =>
  JSON.stringify(request.messages, (key, value: unknown) =>
    key === 'cache_control' ? undefined : value,
  );

const runId = await inSession((session) =>
  Effect.gen(function* () {
    const run = yield* session.start({
      label: 'note_taker',
      system: 'Do what is asked, and keep your context to what you need.',
      tools: ['script', 'context'],
      instruction: 'List the measurements.',
      model: route.model,
      interactive: true,
    });
    yield* session.view.subscribe([{ id: run.runId, fromSeq: 0 }]);
    yield* waitsAtTurn(session, run.runId, 1);
    yield* session.drained;
    return run.runId;
  }),
);

// 2. The request after the edit: the note, not the long result.
const edited = requests[2];
if (
  edited === undefined ||
  !sentMessages(edited).includes(NOTE) ||
  sentMessages(edited).includes(LONG)
)
  throw new Error(
    `the edit did not reach the request: ${JSON.stringify(edited)}`,
  );
console.log(
  `[14] request 3 carries the note in place of a ${LONG.length}-character result`,
);

await inSession((session) =>
  Effect.gen(function* () {
    yield* session.view.subscribe([{ id: runId, fromSeq: 0 }]);
    // What a person reads: the result is still there, beside the edit.
    const rows = yield* Stream.runHead(
      Stream.filter(
        Stream.map(
          Stream.concat(
            Stream.succeed(session.view.current()),
            session.view.changes,
          ),
          (view) => view.runs.get(runId)?.transcript.rows ?? [],
        ),
        (shown) => shown.some((row) => row.kind === 'compactionActivity'),
      ),
    ).pipe(Effect.map(Option.getOrThrow), Effect.timeout('10 seconds'));
    const labels = rows.flatMap((row) =>
      row.kind === 'compactionActivity' ? [row.label] : [],
    );
    const kept = rows.some(
      (row) => row.kind === 'tool' && JSON.stringify(row).includes(LONG),
    );
    console.log(
      `[14] the transcript shows "${labels.join('", "')}", and ${kept ? 'still holds' : 'no longer holds'} the long result`,
    );

    // 3. Resumed in a new session, the run sends the same view.
    yield* session.resume(runId, { interactive: true });
    yield* session.request({
      kind: 'followUp.send',
      runId,
      text: 'Which were they?',
    });
    yield* waitsAtTurn(session, runId, 2);
    yield* session.drained;
    const resumed = requests[3];
    if (resumed === undefined)
      throw new Error('the resumed run sent no request');
    // The resumed request starts with every message the edited one sent.
    const sent = sentMessages(edited).slice(0, -1);
    if (!sentMessages(resumed).startsWith(sent))
      throw new Error(
        `the resumed view differs: ${sentMessages(resumed)} vs ${sent}`,
      );
    console.log(
      `[14] the resumed run's request starts with the edited view; ${requests.length} model requests in all`,
    );
    yield* session.request({ kind: 'run.stop', runId, reason: 'user' });
  }),
);
