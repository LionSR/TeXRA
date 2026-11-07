import { layer } from '@effect/vitest';
import { Effect, Fiber, Exit, Schema, Scope, type Context } from 'effect';
import { expect } from 'vitest';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { holdTestRun, publishTestRows } from '@test/support/sessionTestUtils';
import { waitForCondition } from '@test/support/asyncTestUtils';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

/** Let the session's fibers catch up with what was just published: a few
 *  turns of the event loop cover the stream pipeline. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
/** A run on a real session: its `run.start`, the config the fold reads the
 *  inputs from, and the RUNNING transition. */
const publishRun = (
  session: Context.Context<SessionServices>,
  runId: RunId,
) => {
  const agent = 'polish';
  const aggregateId = qualifyAggregateId('run', runId);
  // One batch, so the renderer's first view of the run already holds its
  // inputs and its running phase.
  return publishTestRows(session, [
    {
      type: 'run.start',
      aggregateId,
      identity: { kind: 'agent', agent },
      takesFollowUps: true,
      worktree: null,
      parent: null,
      provenance: null,
      approvalPolicy: null,
    },
    {
      type: 'run.config',
      aggregateId,
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent,
        model: 'deepseek/deepseek-v4-flash',
        inputFiles: ['paper.tex'],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
        editedFile: null,
        memories: [],
        instruction: '',
        workingDirectory: '/tmp/project',
      }),
    },
    { type: 'run.activate', aggregateId },
    // The first step of the loop: what clears the activation's starting
    // substate, so the live line reads the plain running phase. A workflow
    // run's first turn is its first round.
    {
      type: 'run.position',
      aggregateId,
      payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
    },
  ]);
};

/** What `action` writes to `stream`; `action` reads it as it grows. */
function captureStreamWrites<E, R>(
  stream: NodeJS.WriteStream,
  action: (written: () => string) => Effect.Effect<unknown, E, R>,
): Effect.Effect<string, E, R> {
  let output = '';
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      spyOnStreamWrite(stream, (chunk) => {
        output += chunk;
      }),
    ),
    () => action(() => output),
    (spy) => Effect.sync(() => spy.mockRestore()),
  ).pipe(Effect.map(() => output));
}

const decodeRecord = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown),
);

function ndjsonRecords(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => decodeRecord(JSON.parse(line)));
}

const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);

// Live clock: the renderer paints on real event-loop turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'CLI run progress renderer',
  (it) => {
    // A session of its own per case.
    it.layer(TestSession.layer(), { buildPerTest: true })((it) => {
      it.effect(
        'writes human progress to stderr without polluting json stdout',
        () =>
          Effect.gen(function* () {
            const line = 'polish paper.tex · 0s';
            let stderr = '';
            const stdout = yield* captureStreamWrites(process.stdout, () =>
              Effect.gen(function* () {
                stderr = yield* captureStreamWrites(process.stderr, (written) =>
                  Effect.gen(function* () {
                    const session = yield* TestSession;
                    const handle = yield* sessionHandleOf(session);
                    const host = createCliRuntimeHost(
                      createTestCliContext({
                        mode: 'interactive',
                        outputFormat: 'json',
                        renderRunProgress: true,
                        stderrIsTty: true,
                        stdoutColorEnabled: true,
                        stderrColorEnabled: false,
                      }),
                    );
                    const scope = yield* Scope.make();
                    const runId = decodeRunId('d4d4d4');
                    yield* host
                      .attachRunProgressRenderer(session, runId)
                      .pipe(Scope.provide(scope));
                    // The rows land once this process holds the run, as a
                    // launch's do: forked behind the hold's start, and
                    // joined so a refused batch fails the case.
                    const published = yield* Effect.forkChild(
                      publishRun(handle, runId),
                    );
                    yield* holdTestRun(handle, runId);
                    yield* Fiber.join(published);
                    // Painted once the renderer's fiber sees the running
                    // view, as many event-loop turns later as Effect's
                    // scheduling takes.
                    yield* Effect.promise(() =>
                      waitForCondition(() => written().includes(line), {
                        timeoutMessage:
                          'The run progress line was never painted.',
                      }),
                    );
                    yield* Scope.close(scope, Exit.void);
                    yield* host.close();
                  }),
                );
              }),
            );

            expect(stderr).toContain(line);
            expect(stdout).toBe('');
          }),
      );

      it.effect(
        'writes projected subagent progress records to stdout in ndjson mode',
        () =>
          Effect.gen(function* () {
            const parentRunId = decodeRunId('a1a1a1');
            const childRunId = decodeRunId('b1b1b1');
            const output = yield* captureStreamWrites(process.stdout, () =>
              Effect.gen(function* () {
                const session = yield* TestSession;
                const handle = yield* sessionHandleOf(session);
                // The child list is the fold's: the parent's `childIds` and
                // the child's own row, derived beside the line that folded
                // them. Both runs land in one batch, so the projection's
                // first sight of the parent already holds its child.
                const detach =
                  yield* attachCliSessionProgressProjection(session);
                yield* publishTestRows(handle, [
                  {
                    type: 'run.start',
                    aggregateId: qualifyAggregateId('run', parentRunId),
                    identity: { kind: 'agent', agent: 'chat' },
                    takesFollowUps: true,
                    parent: null,
                    provenance: null,
                  },
                  {
                    type: 'run.start',
                    aggregateId: qualifyAggregateId('run', childRunId),
                    identity: { kind: 'agent', agent: 'review' },
                    takesFollowUps: false,
                    parent: { id: parentRunId, call: null },
                    provenance: null,
                  },
                ]);
                yield* holdTestRun(handle, childRunId);
                yield* Effect.promise(() => settle());
                yield* detach;
              }),
            );

            const records = ndjsonRecords(output).filter(
              (record) => record.event === 'run.children',
            );

            expect(records).toEqual([
              expect.objectContaining({
                kind: 'progress',
                event: 'run.children',
                // The row carries the child's run id and identity under
                // their own names; `ready` is the fold's phase before the
                // activation lands.
                payload: {
                  runId: parentRunId,
                  children: [
                    {
                      childRunId,
                      agentName: 'review',
                      identity: { kind: 'agent', agent: 'review' },
                      status: 'ready',
                    },
                  ],
                },
                contract: 2,
              }),
            ]);
          }),
      );
    });
  },
);
