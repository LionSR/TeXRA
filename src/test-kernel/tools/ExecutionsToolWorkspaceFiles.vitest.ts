import '@test/support/sessionGraphTestSetup';

// Test composition imports

// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';

import { Effect, Fiber } from 'effect';

import { beforeEach, describe, expect } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';
import type { ToolServices } from '@agent/runtime/ToolServices';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_PHASE,
  emptyRunEndOutput,
  qualifyAggregateId,
  RunIdSchema,
  type RunId,
  type RunPhase,
} from '@shared/schemas';
import {
  closeSessionOf,
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  seedEditedFiles,
  seedReport,
  seedRunRecord,
} from '@test/support/runRecordSeeds';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTempDirPlatform,
  useTempDirs,
  withTempDirEffect,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import {
  createProcessSession,
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { ExecutionsTool } from '@tools/ExecutionsTool';

/**
 * Move a run's phase the way its loop does: a `run.position` row, which is the
 * one fact the fold derives a live phase from (one run model, 3.3).
 */
function foldRunPhase(
  session: SessionHandle,
  runId: RunId,
  step: 'waiting' | 'turn.begin',
  expected: RunPhase,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    publishTestRows(session, [
      {
        type: 'run.position',
        aggregateId: qualifyAggregateId('run', runId),
        payload: { family: 'toolUse', at: step },
      },
    ]);
    yield* session.log.settled.pipe(Effect.orDie);
    expect(session.view.run(runId)?.status).toBe(expected);
  });
}

/** Own an isolated session for the complete Effect and its finalizers: the
 *  `finally` this replaces is skipped when the test fiber is interrupted. */
function withSession<A, E, R>(
  fn: (session: SessionHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    createTestSession().pipe(Effect.orDie),
    fn,
    (session) => closeSessionOf(session),
  );
}

const tempDirs = useTempDirs();

const config = {
  agent: 'chat',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Check the proof.',
  inputFiles: [],
  outputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  memories: [],
} as AgentConfig;

/** A stored run of `config` in the default session, run in `workspace`,
 *  whose settled calls edited `edited`. */
function seedEditingRun(
  runId: RunId,
  workspace: string,
  edited: readonly string[],
) {
  return Effect.gen(function* () {
    const session = testDefaultSession();
    publishTestRunStart(session, runId);
    yield* session.log.settled;
    yield* seedRunRecord(session, runId, {
      ...config,
      workingDirectory: workspace,
    });
    yield* seedEditedFiles(session, runId, edited);
  });
}

/** Installs a real filesystem-backed storage root for sidecar persistence tests. */
function withTempStorage(
  run: () => Effect.Effect<void, unknown, ToolServices>,
) {
  return Effect.gen(function* () {
    yield* withTempDirEffect('texra-exec-storage-', (root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            workspacePath: path.join(root, 'workspace'),
            storagePath: path.join(root, 'storage'),
          }),
        );
        const session = yield* createProcessSession();
        yield* run().pipe(
          Effect.provide(
            nativeToolTestLayer({
              run: { session, runId: 'tool-test' as RunId, toolPolicy: {} },
            }),
          ),
          Effect.ensuring(closeTestSession(session.roots.storage)),
        );
      }),
    );
  });
}

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(async () => {
    await Effect.runPromise(
      openTestDefaultSession({
        roots: testWorkspaceRoots(),
        transcriptMode: { kind: 'ephemeral', reason: 'executions tool test' },
      }),
    );
  });

  it.live("rejects '..' path traversal in /executions/{id}/files/{path}", () =>
    Effect.gen(function* () {
      const result = yield* ExecutionsTool.call({
        path: '/executions/abc123def456/files/../../../../../../etc/passwd',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain("must not contain '..'");
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live(
    'does not duplicate auto-delivered live subagent reports for the parent run',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000a');
          const childRunId = RunIdSchema.parse('c41d0000000a');
          const otherRunId = RunIdSchema.parse('0f1e0000000a');
          const handle = testRunHandle({
            runId: childRunId,
            parent: parentRunId,
            agent: 'review',
          });

          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          registryOf(session.runs).track(handle);
          yield* foldRunPhase(
            session,
            childRunId,
            'waiting',
            RUN_PHASE.WAITING,
          );
          yield* session.log.settled;
          yield* seedReport(
            session,
            childRunId,
            '<subagent-result>full report</subagent-result>',
          );

          const parentWaitResult = yield* ExecutionsTool.call({
            path: `/executions/${childRunId}`,
            action: 'wait',
          }).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session: session, runId: parentRunId, toolPolicy: {} },
              }),
            ),
          );
          const crossTreeWaitResult = yield* ExecutionsTool.call({
            path: `/executions/${childRunId}`,
            action: 'wait',
          }).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session: session, runId: otherRunId, toolPolicy: {} },
              }),
            ),
          );

          expect(parentWaitResult.output).toContain(
            'Result: delivered automatically to this parent run as a follow-up message.',
          );
          expect(parentWaitResult.output).toContain(
            `/executions/${childRunId}/report`,
          );
          expect(parentWaitResult.output).not.toContain(
            '<subagent-result>full report',
          );
          expect(crossTreeWaitResult.output).toContain(
            '<subagent-result>full report</subagent-result>',
          );
          expect(crossTreeWaitResult.output).not.toContain(
            'delivered automatically',
          );
        }),
      ).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: testDefaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  // Regression: a wait that returned a finished child's result left the
  // child's queued delivery pending, so the parent took the same result
  // again as a follow-up and ran a second turn.
  it.live(
    'answers the queued delivery of a child whose result a wait returned',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000d');
          const childRunId = RunIdSchema.parse('c41d0000000d');
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          registryOf(session.runs).track(
            testRunHandle({
              runId: childRunId,
              parent: parentRunId,
              agent: 'review',
            }),
          );
          yield* foldRunPhase(
            session,
            childRunId,
            'waiting',
            RUN_PHASE.WAITING,
          );
          yield* session.log.settled;
          yield* seedReport(
            session,
            childRunId,
            '<subagent-result>full report</subagent-result>',
          );
          const delivery = {
            text: 'child result',
            from: { kind: 'run' as const, runId: childRunId },
            deliveryId: `${childRunId}:turn:1:delivery`,
          };
          yield* session.followUps.send(parentRunId, delivery);
          expect(
            (yield* session.followUps.read(parentRunId)).followUps,
          ).toHaveLength(1);

          const waited = yield* ExecutionsTool.call({
            path: `/executions/${childRunId}`,
            action: 'wait',
          }).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session, runId: parentRunId, toolPolicy: {} },
              }),
            ),
          );

          expect(waited.output).toContain(
            '<subagent-result>full report</subagent-result>',
          );
          // The result names the delivery it answers; the call's settlement
          // consumes it, so until then it stays queued.
          expect(
            waited.status === 'executed' ? waited.consumedFollowUps : null,
          ).toEqual([delivery.deliveryId]);
          expect(
            (yield* session.followUps.read(parentRunId)).followUps,
          ).toHaveLength(1);
        }),
      ),
  );

  // The blocking wait wakes on the fold's own phase move, read off the
  // session's view stream, well inside its deadline.
  it.live(
    'wakes a blocking wait when a waited run changes phase',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000c');
          const childRunId = RunIdSchema.parse('c41d0000000c');
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          registryOf(session.runs).track(
            testRunHandle({
              runId: childRunId,
              parent: parentRunId,
              agent: 'review',
            }),
          );
          yield* foldRunPhase(
            session,
            childRunId,
            'turn.begin',
            RUN_PHASE.RUNNING,
          );
          const wait = yield* Effect.forkChild(
            ExecutionsTool.call({
              path: `/executions/${childRunId}`,
              action: 'wait',
              timeout: 600,
            }).pipe(
              Effect.provide(
                nativeToolTestLayer({
                  run: { session, runId: parentRunId, toolPolicy: {} },
                }),
              ),
            ),
          );
          yield* Effect.yieldNow;
          yield* foldRunPhase(
            session,
            childRunId,
            'waiting',
            RUN_PHASE.WAITING,
          );
          const result = yield* Fiber.join(wait);
          expect(result.status).not.toBe('error');
        }),
      ),
    { timeout: 5000 },
  );

  it.live(
    "wakes a blocking wait when the waiting run is sent a child's report",
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000d');
          const childRunId = RunIdSchema.parse('c41d0000000d');
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          registryOf(session.runs).track(
            testRunHandle({
              runId: childRunId,
              parent: parentRunId,
              agent: 'review',
            }),
          );
          yield* foldRunPhase(
            session,
            childRunId,
            'turn.begin',
            RUN_PHASE.RUNNING,
          );
          const wait = yield* Effect.forkChild(
            ExecutionsTool.call({
              path: `/executions/${childRunId}`,
              action: 'wait',
              timeout: 600,
            }).pipe(
              Effect.provide(
                nativeToolTestLayer({
                  run: { session, runId: parentRunId, toolPolicy: {} },
                }),
              ),
            ),
          );
          yield* Effect.yieldNow;
          // The child stays RUNNING: only the committed report can end it.
          publishTestRows(session, [
            {
              type: 'followup.queued',
              aggregateId: qualifyAggregateId('run', parentRunId),
              followUpId: 'child-report',
              content: {
                text: '<subagent-progress id="c41d0000000d" agent="review" type="started" />',
                from: { kind: 'run', runId: childRunId, relation: 'child' },
              },
            },
          ]);
          const result = yield* Fiber.join(wait);
          expect(result.status).not.toBe('error');
        }),
      ),
    { timeout: 5000 },
  );

  // A completed run has no live handle, so nothing proves the caller is the
  // parent run that already received the report as a follow-up. The wait
  // summary must therefore keep the report inline rather than eliding it.
  it.live(
    'keeps completed wait summary reports inline when parent delivery cannot be confirmed',
    () =>
      withTempStorage(() =>
        withSession((session) =>
          Effect.gen(function* () {
            const runId = 'abc123' as RunId;
            const callerRunId = RunIdSchema.parse('ca11e0000001');

            publishTestRunStart(session, runId);
            yield* session.log.settled;
            yield* seedRunRecord(session, runId, config);
            yield* seedReport(
              session,
              runId,
              '<subagent-result>full report</subagent-result>',
            );

            const [waitResult, reportResult] = yield* Effect.all([
              ExecutionsTool.call({
                path: `/executions/${runId}`,
                action: 'wait',
              }),
              ExecutionsTool.call({
                path: `/executions/${runId}/report`,
              }),
            ]).pipe(
              Effect.provide(
                nativeToolTestLayer({
                  run: { session: session, runId: callerRunId, toolPolicy: {} },
                }),
              ),
            );

            expect(waitResult.output).toContain(
              '<subagent-result>full report</subagent-result>',
            );
            expect(waitResult.output).not.toContain('delivered automatically');
            expect(reportResult.output).toBe(
              '<subagent-result>full report</subagent-result>',
            );
          }),
        ),
      ).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: testDefaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live("serves the run's joined result envelope", () =>
    Effect.gen(function* () {
      // The subagent's record holds its reply; the run's end holds the
      // outcome. The endpoint serves the two joined.
      const runId = 'abc123' as RunId;
      const session = testDefaultSession();
      publishTestRunStart(session, runId);
      publishTestRows(session, [
        {
          type: 'run.result',
          aggregateId: qualifyAggregateId('run', runId),
          result: {
            producer: 'subagent',
            output: { response: 'Checked the proof.', files: ['notes.md'] },
          },
        },
        {
          type: 'run.end',
          aggregateId: qualifyAggregateId('run', runId),
          outcome: 'completed',
          output: emptyRunEndOutput(),
        },
      ]);
      yield* session.log.settled;

      const result = yield* ExecutionsTool.call({
        path: `/executions/${runId}/result`,
      });

      expect(JSON.parse(result.output ?? '')).toEqual({
        outcome: 'completed',
        output: { response: 'Checked the proof.', files: ['notes.md'] },
      });
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('refuses unrecorded workspace file reads', () =>
    Effect.gen(function* () {
      yield* withTempDirEffect('texra-exec-files-', (workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(path.join(workspace, 'secret.md'), 'secret'),
          );
          yield* seedEditingRun('abc123' as RunId, workspace, ['review.md']);

          const result = yield* ExecutionsTool.call({
            path: '/executions/abc123/workspace-files/secret.md',
          });

          expect(result.status).toBe('error');
          expect(result.error).toContain('Workspace file not found');
        }),
      );
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('reads recorded files inside a top-level workspace directory', () =>
    Effect.gen(function* () {
      yield* withTempDirEffect('texra-exec-files-', (workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => mkdir(path.join(workspace, 'workspace')));
          yield* Effect.promise(() =>
            writeFile(path.join(workspace, 'review.md'), 'wrong'),
          );
          yield* Effect.promise(() =>
            writeFile(path.join(workspace, 'workspace', 'review.md'), 'nested'),
          );
          yield* seedEditingRun('abc123' as RunId, workspace, [
            'workspace/review.md',
          ]);

          const result = yield* ExecutionsTool.call({
            path: '/executions/abc123/workspace-files/workspace/review.md',
          });

          expect(result.summary).toBe(
            'Read /executions/abc123/workspace-files/workspace/review.md',
          );
          expect(result.output).toContain('nested');
          expect(result.output).not.toContain('wrong');
        }),
      );
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
