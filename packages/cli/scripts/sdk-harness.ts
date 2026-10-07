// Validation harness: an embedder of `@texra-ai/harness` on the validation
// model, which prints what it saw as JSON lines. Built with the validator's
// bundle (`build-bundle.mjs --sdk-harness`), so the model's gate can open.
//
//   node sdk-harness.js <workspace> <storageDir> inline <instruction>
//     Runs one inline persona (no agent file anywhere) on an in-memory
//     session and prints the run's id, its result and the identity its
//     session view gives it.
//   node sdk-harness.js <workspace> <storageDir> ask <instruction>
//     Starts a run whose custom tool asks for approval on a persistent
//     session, and
//     prints the request its approval handler receives. The handler never
//     answers, so the process waits there until it is killed.
//   node sdk-harness.js <workspace> <storageDir> resume <runId>
//     Reopens the persistent session, resumes the run, approves what its
//     handler receives, and prints the requests it answered and the result.

import { appendFileSync } from 'node:fs';
import path from 'node:path';

import { Effect, Option, Stream } from 'effect';
import { z } from 'zod';

import {
  defineTool,
  Sessions,
  type ApprovalHandler,
  type PendingRequest,
  type RunId,
} from '@texra-ai/harness';
import { nodePlatform } from '@texra-ai/harness/node';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

const [workspace, storageDir, mode, argument] = process.argv.slice(2);
if (
  workspace === undefined ||
  storageDir === undefined ||
  argument === undefined
)
  throw new Error(
    'usage: sdk-harness <workspace> <storageDir> inline|ask|resume <instruction|runId>',
  );

const print = (line: object): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(line)}\n`);
  });

const asked = (request: PendingRequest) => ({
  runId: request.runId,
  requestId: request.requestId,
  kind: request.payload.kind,
});

/** Reports each request, and answers none: the run stays parked on it. */
const reportOnly: ApprovalHandler = (request) =>
  print({ asked: asked(request) }).pipe(Effect.andThen(Effect.never));

/** The embedder's own tool, which runs only once approved: it records the
 *  approval in `approved.txt` in the workspace (the scripted model calls it
 *  as it calls a command). Both phases pass it, as a
 *  resumed run needs its custom tools again. */
const recordApproval = defineTool({
  name: 'record_approval',
  description: 'Record a note once it is approved.',
  schema: z.strictObject({ command: z.string() }),
  requiresApproval: true,
  execute: () =>
    Effect.sync(() => {
      appendFileSync(path.join(workspace, 'approved.txt'), 'approved\n');
      return { status: 'executed' as const, output: 'approved' };
    }),
});
const tools = [recordApproval];

const answered: ReturnType<typeof asked>[] = [];
/** Approves each request, recording it. */
const approveAll: ApprovalHandler = (request) =>
  Effect.sync(() => {
    answered.push(asked(request));
    return { action: 'approve' } as const;
  });

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  switch (mode) {
    case 'inline': {
      const session = yield* sessions.open();
      const run = yield* session.start({
        agent: {
          name: 'inline_echo',
          description: 'Say what the model was shown.',
          prompt: 'Say what you were shown.',
        },
        instruction: argument,
        model: 'openai/gpt-5.6-sol',
      });
      const result = yield* run.result;
      const level = yield* Stream.runHead(session.view.changes);
      const identity = Option.getOrUndefined(level)?.runs.get(
        run.runId,
      )?.identity;
      return yield* print({ runId: run.runId, result, identity });
    }
    case 'ask': {
      const session = yield* sessions.open(undefined, {
        persistent: true,
        approve: reportOnly,
      });
      const run = yield* session.start({
        agent: {
          name: 'approval_validation',
          description: 'Record one note once it is approved.',
          prompt: 'GOLDEN-APPROVAL record_approval',
          tools: [],
        },
        instruction: argument,
        model: 'openai/gpt-5.6-sol',
        tools,
      });
      yield* print({ started: run.runId });
      return yield* run.result;
    }
    case 'resume': {
      const session = yield* sessions.open(undefined, {
        persistent: true,
        approve: approveAll,
      });
      // `argument` is the id the `ask` phase printed.
      const run = yield* session.resume(argument as RunId, { tools });
      const result = yield* run.result;
      return yield* print({ runId: run.runId, answered, result });
    }
    default:
      throw new Error(`unknown mode: ${String(mode)}`);
  }
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

await Effect.runPromise(program);
