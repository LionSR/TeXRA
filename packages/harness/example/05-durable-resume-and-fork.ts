/**
 * Example 05 — SQLite persistence, run records, forking (`run.fork`), and `session.resume`.
 *
 * 1. Opens a persistent SQLite session (`{ persistent: true }`).
 * 2. Starts an interactive run (`run1`) that completes its first cycle and
 *    stops it so its checkpoint sits in SQLite.
 * 3. Inspects `session.listRuns()` and `session.records(run1.runId)`.
 * 4. Forks the conversation (`session.request({ kind: 'run.fork' })`) into a
 *    new run id, resumes the fork (`session.resume`), sends a follow-up on the
 *    fork, and verifies that both branches are persisted independently.
 */
import { Effect, Stream } from 'effect';
import { Sessions } from '@texra-ai/harness';
import { harnessBuiltins } from '@texra-ai/harness/plugins';

import { makeExampleWorkspace } from './_support.ts';

const { platform, requests } = await makeExampleWorkspace([
  { text: 'Drafted section 1 with an informal proof sketch.' },
  { text: 'Rewrote section 1 with Lemma 1 and a formal proof.' },
]);

const program = Effect.gen(function* () {
  const sessions = yield* Sessions;
  const session = yield* sessions.open(platform.roots, { persistent: true });

  const run1 = yield* session.start({
    agent: {
      name: 'section_drafter',
      description: 'Drafts paper sections.',
      prompt: 'Draft the requested section concisely.',
      tools: ['read_file'],
    },
    instruction: 'Draft section 1.',
    model: 'anthropic/claude-sonnet-5-5',
    interactive: true,
  });

  // Wait for turn 1 to settle at `waiting` so `forkPoint` is recorded
  yield* Stream.runHead(
    Stream.filter(
      run1.view,
      (view) => view.runs.get(run1.runId)?.status === 'waiting',
    ),
  );

  // Fork the conversation at its settled point
  const forkOutcome = yield* session.request({
    kind: 'run.fork',
    runId: run1.runId,
  });
  if (forkOutcome.kind !== 'forked') {
    throw new Error(`Expected forked outcome, got ${forkOutcome.kind}`);
  }
  const forkedRunId = forkOutcome.runId;
  console.log(`[05] forked ${run1.runId} -> ${forkedRunId}`);

  // Stop the original run (`run.stop` awaits settlement)
  yield* session.request({
    kind: 'run.stop',
    runId: run1.runId,
    reason: 'user',
  });

  // Send a follow-up to the forked run; sending to a stopped interactive run
  // resumes it from its committed history in SQLite
  const sendOutcome = yield* session.request({
    kind: 'followUp.send',
    runId: forkedRunId,
    text: 'Replace the sketch with Lemma 1 and a formal proof.',
  });
  console.log('[05] fork followUp:', sendOutcome.kind);

  yield* Stream.runHead(
    Stream.filter(session.view.changes, (view) => {
      const forked = view.runs.get(forkedRunId);
      const pendingFollowUps =
        view.queuedFollowUps.get(forkedRunId)?.length ?? 0;
      return (
        forked?.status === 'waiting' &&
        pendingFollowUps === 0 &&
        requests.length === 2
      );
    }),
  );

  yield* session.request({
    kind: 'run.stop',
    runId: forkedRunId,
    reason: 'user',
  });
  yield* session.settled;

  const listed = yield* session.listRuns();
  const originalConversation = yield* session
    .records(run1.runId)
    .readConversation();
  const forkedConversation = yield* session
    .records(forkedRunId)
    .readConversation();
  console.log(
    `[05] persisted runs=${listed.length} originalNodes=${originalConversation.length} forkedNodes=${forkedConversation.length}`,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(Sessions.layer({ platform, plugins: harnessBuiltins })),
);

await Effect.runPromise(program);
