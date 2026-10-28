/**
 * Example 02 — Sessions, inline personas, typed launch refusals, and `run.events`.
 *
 * Composes `Sessions.layer({ platform, plugins: harnessBuiltins })`, opens a
 * session, checks an `InlinePersonaSchema` definition, handles an `AgentNotFound`
 * refusal on a missing agent, and runs an inline persona while streaming its
 * `run.events` (through `responseText`) and awaiting `run.result` (`RunEndResult`).
 */
import { Effect, Result, Schema, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';
import { InlinePersonaSchema } from '@texra-ai/harness/schemas';

import { makeExampleWorkspace } from './_support.ts';

const { platform } = await makeExampleWorkspace([
  {
    text: 'The abstract is 94 words and states the main bound in sentence two.',
  },
]);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);

  const open = yield* sessions.list;
  console.log('[02] open sessions:', open.length);

  // 1. Validate an inline persona against the published Effect Schema
  const personaResult = Schema.decodeUnknownResult(InlinePersonaSchema)({
    name: 'abstract_editor',
    description: 'Reviews abstracts for concision.',
    prompt: 'You review LaTeX abstracts for concision.',
    tools: ['read_file'],
  });
  if (!Result.isSuccess(personaResult)) {
    throw new Error(personaResult.failure.message);
  }
  console.log('[02] inline persona valid:', personaResult.success.name);

  // 2. Typed launch refusal when an agent does not exist
  const refusal = yield* Effect.flip(
    session.start({ agent: 'no-such-agent', instruction: 'Nothing to do.' }),
  );
  console.log(`[02] refusal: ${refusal._tag} - ${refusal.message}`);

  // 3. Start a run with the inline persona and stream its live trace events
  const run = yield* session.start({
    agent: personaResult.success,
    instruction: 'Check the abstract length.',
    model: 'anthropic/claude-sonnet-5-5',
  });

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
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

await Effect.runPromise(program);
