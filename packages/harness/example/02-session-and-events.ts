/**
 * Example 02 — Sessions, a run written inline, typed launch refusals, and `run.events`.
 *
 * Composes `Sessions.layer({ platform, plugins: harnessBuiltins, client })`, opens a
 * session, checks a start against `StartRequestSchema`, handles a
 * `LaunchRefused` refusal on an unknown model, and runs the start while streaming its
 * `run.events` (through `responseText`) and awaiting `run.result` (`RunEnd`),
 * then reads the ended run's events again, replayed from the session.
 */
import { Effect, Layer, Result, Schema, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/builtins';
import { StartRequestSchema } from '@texra-ai/harness/schemas';

import { EXAMPLE_CLIENT, makeExampleWorkspace } from './_support.ts';

const { platform, route } = await makeExampleWorkspace([
  {
    text: 'The abstract is 94 words and states the main bound in sentence two.',
  },
]);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);

  const open = yield* sessions.list;
  console.log('[02] open sessions:', open.length);

  // 1. Validate a start against the published Effect Schema
  const startResult = Schema.decodeUnknownResult(StartRequestSchema)({
    label: 'abstract_editor',
    system: 'You review LaTeX abstracts for concision.',
    tools: ['read_file'],
    instruction: 'Check the abstract length.',
    model: route.model,
  });
  if (!Result.isSuccess(startResult)) {
    throw new Error(startResult.failure.message);
  }
  console.log('[02] start valid:', startResult.success);

  // 2. Typed launch refusal for a model the build does not know
  const refusal = yield* Effect.flip(
    session.start({
      system: 'Nothing to do.',
      instruction: 'Nothing to do.',
      model: 'no-such-provider/no-such-model',
    }),
  );
  console.log(`[02] refusal: ${refusal._tag} - ${refusal.message}`);

  // 3. Start the run and stream its events
  const run = yield* session.start(startResult.success);

  // The answer's text only: the run's events also stream the model's
  // thinking and tool output.
  const chunks: string[] = [];
  yield* Stream.runForEach(run.events.pipe(responseText), (text) =>
    Effect.sync(() => chunks.push(text)),
  );

  const end = yield* run.result;

  console.log(
    `[02] run ended: outcome=${end.outcome} streamed="${chunks.join('')}"`,
  );

  // 4. A second reader, after the run has ended, reads the same events
  // back: the same answer text, whole.
  const replayed = yield* Stream.runCollect(run.events.pipe(responseText));
  if ([...replayed].join('') !== chunks.join(''))
    return yield* Effect.fail(
      new Error(
        `replayed "${[...replayed].join('')}" differs from streamed "${chunks.join('')}"`,
      ),
    );
  console.log(`[02] replayed after the end: "${[...replayed].join('')}"`);
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
