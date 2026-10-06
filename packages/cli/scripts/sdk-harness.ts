// Validation harness: an embedder of `@texra-ai/harness` that runs one
// inline persona (no agent file anywhere) on the validation model and prints
// the run's id, its outcome and the identity its session view gives it as
// one JSON line. The package's sessions keep an in-memory store, so the
// view is where the run's record is read. Built with the validator's
// bundle (`build-bundle.mjs --sdk-harness`), so the model's gate can open.
//
//   node sdk-harness.js <workspace> <storageDir> <instruction>

import { Effect, Option, Stream } from 'effect';

import { Sessions } from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

const [workspace, storageDir, instruction] = process.argv.slice(2);
if (
  workspace === undefined ||
  storageDir === undefined ||
  instruction === undefined
)
  throw new Error('usage: sdk-harness <workspace> <storageDir> <instruction>');

const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open();
  const run = yield* session.start({
    agent: {
      name: 'inline_echo',
      description: 'Say what the model was shown.',
      prompt: 'Say what you were shown.',
    },
    instruction,
    model: 'openai/gpt-5.6-sol',
  });
  const result = yield* run.result;
  const level = yield* Stream.runHead(session.view.changes);
  const identity = Option.getOrUndefined(level)?.runs.get(run.runId)?.identity;
  return { runId: run.runId, result, identity };
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform: nodePlatform({
        agentsDir: `${storageDir}/no-agents`,
        storageDir,
        workspaceDir: workspace,
      }),
      plugins: harnessBuiltins.all,
    }),
  ),
);

process.stdout.write(`${JSON.stringify(await Effect.runPromise(program))}\n`);
