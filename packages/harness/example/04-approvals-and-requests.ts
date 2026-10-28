/**
 * Example 04 — Approval gates (`Session.attach`) and runtime commands (`Session.request`).
 *
 * 1. Defines an approval-gated tool (`requiresApproval: true`).
 * 2. Attaches a `SessionHost` (`session.attach({ approve })`) that inspects
 *    `PendingRequest` and approves the tool call.
 * 3. Starts an `interactive: true` run, waits for its first cycle to reach
 *    `waiting`, sends a follow-up via `session.request({ kind: 'followUp.send' })`,
 *    and stops the interactive run cleanly via `session.request({ kind: 'run.stop' })`,
 *    after which its `result` is the `cancelled` end it stored.
 */
import { Effect, Schema, Stream } from 'effect';
import { defineTool, Sessions } from '@texra-ai/harness';
import {
  definePlugin,
  executed,
  harnessBuiltins,
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
  tools: { publish_preprint: publishPreprintTool },
});

const { platform, requests } = await makeExampleWorkspace([
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
    model: 'anthropic/claude-sonnet-5-5',
    interactive: true,
  });

  // Wait for the first interactive cycle to pause for user input
  yield* Stream.runHead(
    Stream.filter(
      run.view,
      (view) => view.runs.get(run.runId)?.status === 'waiting',
    ),
  );
  console.log('[04] cycle 1 status=waiting modelTurns=', requests.length);

  // Send a follow-up message through the runtime command protocol
  const followUpOutcome = yield* session.request({
    kind: 'followUp.send',
    runId: run.runId,
    text: 'Tag release v1.',
  });
  console.log('[04] followUp outcome:', followUpOutcome.kind);

  // Wait for the second cycle to consume the follow-up and return to waiting
  yield* Stream.runHead(
    Stream.filter(run.view, (view) => {
      const current = view.runs.get(run.runId);
      const pendingFollowUps = view.queuedFollowUps.get(run.runId)?.length ?? 0;
      return (
        current?.status === 'waiting' &&
        pendingFollowUps === 0 &&
        requests.length === 3
      );
    }),
  );
  console.log('[04] cycle 2 status=waiting modelTurns=', requests.length);

  // Stop the interactive run cleanly; `run.stop` awaits settlement
  yield* session.request({
    kind: 'run.stop',
    runId: run.runId,
    reason: 'user',
  });
  const finalStatus = session.view.current().runs.get(run.runId)?.status;
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
    }),
  ),
);

await Effect.runPromise(program);
