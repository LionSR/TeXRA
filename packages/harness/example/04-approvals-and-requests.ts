/**
 * Example 04 — Approval gates (`Session.attach`) and runtime commands (`Session.request`).
 *
 * 1. Defines an approval-gated tool (`requiresApproval: true`).
 * 2. Attaches a `SessionHost` (`session.attach({ approve })`) that inspects
 *    `PendingRequest` and approves the tool call.
 * 3. Starts an `interactive: true` run, waits for its first cycle to reach
 *    `waiting`, sends a follow-up under an id of its own via
 *    `session.request({ kind: 'followUp.send' })`, waits for that follow-up's
 *    receipt to say it was answered (`followUp.receipt`), and stops the
 *    interactive run cleanly via `session.request({ kind: 'run.stop' })`,
 *    after which its `result` is the `cancelled` end it stored.
 */
import { Effect, Layer, Schema, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import {
  definePlugin,
  executed,
  harnessBuiltins,
  defineTool,
} from '@texra-ai/harness/plugins';
import type { PendingRequest } from '@texra-ai/harness/schemas';

import { makeExampleWorkspace } from './_support.ts';

const publishPreprintTool = defineTool({
  name: 'publish_preprint',
  description: 'Stage a preprint archive for submission.',
  lane: 'barrier',
  replay: 'unsafe',
  requiresApproval: true,
  schema: Schema.Struct({
    target: Schema.String.annotate({ description: 'Archive target name.' }),
  }),
  execute: ({ target }) =>
    Effect.succeed(
      executed(
        JSON.stringify({ target, staged: true }),
        `Staged preprint for ${target}`,
      ),
    ),
});

const preprintPlugin = definePlugin({
  id: 'preprint-tools',
  tools: [publishPreprintTool],
});

const { platform, route } = await makeExampleWorkspace([
  {
    toolCalls: [
      {
        id: 'call_pub_1',
        name: 'publish_preprint',
        input: { target: 'arXiv' },
      },
    ],
  },
  { text: 'Preprint staged for arXiv.' },
  { text: 'Tagged release v1.' },
]);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots);

  const approvedRequests: string[] = [];
  yield* session.attach({
    approve: (request: PendingRequest) =>
      Effect.sync(() => {
        approvedRequests.push(request.payload.kind);
        console.log(
          `[04] approving requestId=${request.requestId} kind=${request.payload.kind}`,
        );
        return { action: 'approve' as const };
      }),
  });

  const run = yield* session.start({
    agent: {
      name: 'release_manager',
      description: 'Stages preprints after approval.',
      prompt: 'Stage the preprint when asked.',
      tools: ['publish_preprint'],
    },
    instruction: 'Stage the manuscript for arXiv.',
    model: route.model,
    interactive: true,
  });

  // Wait for the first interactive cycle to pause for user input
  yield* Stream.runHead(
    Stream.filter(
      run.view,
      (view) => view.runs.get(run.runId)?.position === 'waiting',
    ),
  );
  console.log('[04] cycle 1 status=waiting');

  // Send a follow-up under an id of our own: a retry under the same id
  // answers with this message's receipt instead of sending it twice.
  const followUpOutcome = yield* session.request({
    kind: 'followUp.send',
    runId: run.runId,
    id: 'tag-release',
    text: 'Tag release v1.',
  });
  console.log(
    `[04] followUp ${followUpOutcome.id}: ${followUpOutcome.receipt.state}`,
  );

  // Wait for the turn that takes the follow-up to answer it
  const { receipt } = yield* session.request({
    kind: 'followUp.receipt',
    runId: run.runId,
    id: 'tag-release',
    wait: true,
  });
  if (receipt.state !== 'answered') {
    throw new Error(`Expected the follow-up answered, got ${receipt.state}`);
  }
  console.log(`[04] followUp answered by turn ${receipt.turn}`);

  // Stop the interactive run cleanly; `run.stop` awaits settlement
  yield* session.request({
    kind: 'run.stop',
    runId: run.runId,
    reason: 'user',
  });
  const finalStatus = session.view.current().runs.get(run.runId)?.outcome;
  // A stopped run has ended: its result is its `cancelled` end.
  const { outcome } = yield* run.result;
  if (outcome !== 'cancelled') {
    throw new Error(
      `Expected the stopped run to end cancelled, got ${outcome}`,
    );
  }
  console.log(
    `[04] stopped: outcome=${outcome} status=${finalStatus} approvals=${approvedRequests.length}`,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: [...harnessBuiltins, preprintPlugin],
    }).pipe(Layer.provideMerge(route.transport)),
  ),
);

await Effect.runPromise(program);
