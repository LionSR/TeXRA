import { it } from '@effect/vitest';
import { Effect, Exit, Schema, Scope } from 'effect';
import { describe, expect } from 'vitest';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { createCliRuntimeHost } from '@cli/runtime/cliPresentationHost';
import { attachCliSessionProgressProjection } from '@cli/runtime/sessionProgressSubscription';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { testSessionOf } from '@test/support/testProcessRuntime';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

/** Let the renderer's fiber observe the latest view before a case reads
 *  the output: a few turns of the event loop cover the stream pipeline. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
/** A run on a real session: its `run.start`, the config the fold reads the
 *  inputs from, and the RUNNING transition, then the fold's own settle. */
function publishRun(session: SessionHandle, runId: RunId): Effect.Effect<void> {
  const agent = 'polish';
  publishTestRows(session, [
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId),
      identity: { kind: 'agent', agent },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      worktree: null,
      parent: null,
      provenance: null,
      approvalPolicy: null,
    },
  ]);
  publishTestRows(session, [
    {
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
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
  ]);
  publishTestRows(session, [
    {
      type: 'run.activate',
      aggregateId: qualifyAggregateId('run', runId),
    },
    // The first step of the loop: what clears the activation's starting
    // substate, so the live line reads the plain running phase. A workflow
    // run's first turn is its first round.
    {
      type: 'run.position',
      aggregateId: qualifyAggregateId('run', runId),
      payload: { family: 'toolUse', at: 'turn.begin', turn: 1 },
    },
  ]);
  return Effect.promise(() => settle());
}
function captureStreamWrites<E, R>(
  stream: NodeJS.WriteStream,
  action: Effect.Effect<unknown, E, R>,
): Effect.Effect<string, E, R> {
  let output = '';
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      spyOnStreamWrite(stream, (chunk) => {
        output += chunk;
      }),
    ),
    () => action,
    (spy) => Effect.sync(() => spy.mockRestore()),
  ).pipe(Effect.map(() => output));
}

function ndjsonRecords(output: string): Record<string, unknown>[] {
  return output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('CLI run progress renderer', () => {
  it.live('writes human progress to stderr without polluting json stdout', () =>
    Effect.gen(function* () {
      let stderr = '';
      const stdout = yield* captureStreamWrites(
        process.stdout,
        Effect.gen(function* () {
          stderr = yield* captureStreamWrites(
            process.stderr,
            Effect.gen(function* () {
              const session = yield* createTestSession();
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
              yield* host
                .attachRunProgressRenderer(testSessionOf(session))
                .pipe(Scope.provide(scope));
              yield* publishRun(session, 'd4d4d4' as RunId);
              yield* Scope.close(scope, Exit.void);
              yield* host.close();
            }),
          );
        }),
      );

      expect(stderr).toContain('polish paper.tex · 0s');
      expect(stdout).toBe('');
    }),
  );

  it.live(
    'writes projected subagent progress records to stdout in ndjson mode',
    () =>
      Effect.gen(function* () {
        const parentRunId = 'a1a1a1' as RunId;
        const childRunId = 'b1b1b1' as RunId;
        const output = yield* captureStreamWrites(
          process.stdout,
          Effect.gen(function* () {
            const session = yield* createTestSession();
            publishTestRunStart(session, parentRunId);
            yield* Effect.promise(() => settle());
            // The child list is the fold's: the parent's `childIds` and the child's own
            // row, derived beside the line that folded them.
            const detach = yield* attachCliSessionProgressProjection(
              testSessionOf(session),
            );
            publishTestRows(session, [
              {
                type: 'run.start',
                aggregateId: qualifyAggregateId('run', childRunId),
                identity: { kind: 'agent', agent: 'review' },
                userFollowUpSupport: 'unsupported',
                parent: { id: parentRunId, callId: null },
                provenance: null,
              },
            ]);
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
            // The row carries the child's run id and identity under their own
            // names; `ready` is the fold's phase before the activation lands.
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
