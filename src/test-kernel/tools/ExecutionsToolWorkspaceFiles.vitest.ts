import '@test/support/sessionGraphTestSetup';

// Test composition imports

// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';

import { Effect, Fiber } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';
import type { ToolServices } from '@agent/runtime/ToolServices';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { initializeDefaultSession } from '@agent/runtime/sessionGraph';
import { closeSession } from '@agent/runtime/sessionGraph';
import { RUN_PHASE, DEFAULT_TOOL_CONFIG, aggregateId } from '@shared/schemas';
import { RunIdSchema, type RunId, type RunPhase } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { createFakeRunRecords } from '@test/support/FakeRunRecords';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import {
  createProcessSession,
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { ExecutionsTool } from '@tools/ExecutionsTool';

/**
 * Move a run's phase the way its loop does: a `flow.step` row, which is the
 * one fact the fold derives a live phase from (one run model, 3.3).
 */
function foldRunPhase(
  session: SessionHandle,
  runId: RunId,
  step: 'waiting' | 'turn.begin',
  expected: RunPhase,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    session.publish([
      {
        type: 'flow.step',
        aggregateId: aggregateId('run', runId),
        payload: { family: 'toolUse', step },
      },
    ]);
    yield* session.settlePublications().pipe(Effect.orDie);
    expect(session.runView(runId)?.status).toBe(expected);
  });
}

/** Own an isolated session for the complete Effect and its finalizers: the
 *  `finally` this replaces is skipped when the test fiber is interrupted. */
function withSession<A, E, R>(
  fn: (session: SessionHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(createTestSession),
    fn,
    (session) => session.dispose(),
  );
}

const tempDirs = useTempDirs();

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readReport: vi.fn(),
  readResultMeta: vi.fn(),
  readRunEnd: vi.fn(),
  readWorkspaceFiles: vi.fn(),
}));

vi.mock('@agent/storage/runRecords', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/storage/runRecords')
  >('@agent/storage/runRecords');
  return {
    ...actual,
    getRunRecords: vi.fn(() =>
      createFakeRunRecords({
        readConfig: () => Effect.promise(() => mocks.readConfig()),
        readRunRecord: () => Effect.promise(() => mocks.readConfig()),
        readReport: () => Effect.promise(() => mocks.readReport()),
        readResultMeta: () => Effect.promise(() => mocks.readResultMeta()),
        readRunEnd: () => Effect.promise(() => mocks.readRunEnd()),
        readWorkspaceFiles: () =>
          Effect.promise(() => mocks.readWorkspaceFiles()),
      }),
    ),
  };
});

const config = {
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
  inputFiles: [],
  outputFiles: [],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  editedFiles: [],
  memories: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
} as AgentConfig;

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
          Effect.ensuring(closeSession(session.roots.storage)),
        );
      }),
    );
  });
}

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(async () => {
    await Effect.runPromise(
      initializeDefaultSession({
        roots: testWorkspaceRoots(),
        transcriptMode: { kind: 'ephemeral', reason: 'executions tool test' },
      }),
    );
    vi.clearAllMocks();
    mocks.readReport.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readRunEnd.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
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
          session.runs.track(handle);
          yield* foldRunPhase(
            session,
            childRunId,
            'waiting',
            RUN_PHASE.WAITING,
          );
          mocks.readReport.mockResolvedValue(
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
    'withdraws the queued delivery of a child whose result a wait returned',
    () =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000d');
          const childRunId = RunIdSchema.parse('c41d0000000d');
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          session.runs.track(
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
          mocks.readReport.mockResolvedValue(
            '<subagent-result>full report</subagent-result>',
          );
          session.followUps.claimLive(parentRunId, 'flow');
          const delivery = {
            text: 'child result',
            from: { kind: 'run' as const, runId: childRunId },
            deliveryId: `${childRunId}:turn:1:delivery`,
          };
          yield* session.followUps.submit(parentRunId, delivery, 'live_owner');
          expect(
            session.events.pendingFollowUps(aggregateId('run', parentRunId)),
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
          expect(
            session.events.pendingFollowUps(aggregateId('run', parentRunId)),
          ).toEqual([]);
          // The child loop's replayed wake finds the row consumed.
          expect(
            yield* session.followUps.submit(
              parentRunId,
              delivery,
              'live_owner',
            ),
          ).toEqual({ kind: 'duplicate' });
          expect(
            session.events.pendingFollowUps(aggregateId('run', parentRunId)),
          ).toEqual([]);
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
          session.runs.track(
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
          session.runs.track(
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
          session.publish([
            {
              type: 'followup.queued',
              aggregateId: aggregateId('run', parentRunId),
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

  it.live('reads running task lists from session snapshot state', () =>
    withTempStorage(() =>
      withSession((session) =>
        Effect.gen(function* () {
          const parentRunId = RunIdSchema.parse('ba5e0000000b');
          const childRunId = RunIdSchema.parse('c41d0000000b');
          const handle = testRunHandle({
            runId: childRunId,
            parent: parentRunId,
            agent: 'review',
          });

          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          yield* session.settlePublications();
          session.runs.track(handle);
          yield* foldRunPhase(
            session,
            childRunId,
            'turn.begin',
            RUN_PHASE.RUNNING,
          );
          session.publish([
            {
              type: 'run.fact',
              aggregateId: aggregateId('run', childRunId),
              fact: {
                key: 'todos',
                todos: [
                  {
                    content: 'Read live snapshot state',
                    status: 'in_progress',
                    activeForm: 'Reading live snapshot state',
                  },
                ],
              },
            },
          ]);
          yield* session.settlePublications();
          const [summary, todos] = yield* Effect.all([
            ExecutionsTool.call({
              path: `/executions/${childRunId}`,
            }),
            ExecutionsTool.call({
              path: `/executions/${childRunId}/todos`,
            }),
          ]).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session: session, runId: parentRunId, toolPolicy: {} },
              }),
            ),
          );

          expect(summary.output).toContain('Read live snapshot state');
          expect(todos.output).toContain('Read live snapshot state');
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
            yield* session.settlePublications();
            mocks.readConfig.mockResolvedValue(config);
            mocks.readReport.mockResolvedValue(
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

  it.live.each([
    {
      label: 'subagent',
      record: {
        producer: 'subagent' as const,
        agentName: 'reviewer',
        wallTimeMs: 20,
        output: {
          category: 'toolUse' as const,
          response: 'Checked the proof.',
          files: ['notes.md'],
        },
      },
    },
    {
      label: 'CLI workflow',
      record: {
        producer: 'cliWorkflow' as const,
        copiedOutput: '/workspace/polished.tex',
        output: {
          category: 'workflow' as const,
          outputs: [],
          compileFailures: [],
          diffs: [],
        },
      },
    },
  ])('exposes only the final envelope for a $label result', ({ record }) =>
    Effect.gen(function* () {
      // The terminal fact comes from the `run.end` row; the producer record
      // contributes the delivery-enriched output and nothing else.
      const runEnd = {
        outcome: 'completed' as const,
        usage: { totalCost: 0.2 },
        output: { category: 'toolUse' as const, response: '', files: [] },
      };
      mocks.readResultMeta.mockResolvedValue(record);
      mocks.readRunEnd.mockResolvedValue(runEnd);

      const result = yield* ExecutionsTool.call({
        path: '/executions/abc123/result',
      });

      expect(JSON.parse(result.output ?? '')).toEqual({
        outcome: 'completed',
        usage: { totalCost: 0.2 },
        output: record.output,
      });
      expect(result.output).not.toContain('producer');
      expect(result.output).not.toContain('agentName');
      expect(result.output).not.toContain('wallTimeMs');
      expect(result.output).not.toContain('copiedOutput');
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

  // The advertised /executions/{id}/todos endpoint must resolve a task list
  // exactly as the completed summary does, from the same committed stream fold.
  it.live.each([
    { label: 'completed summary', toolPath: '/executions/abc123' },
    { label: 'todos endpoint', toolPath: '/executions/abc123/todos' },
  ])(
    'reads completed todos from committed stream events via the $label',
    ({ toolPath }) =>
      Effect.gen(function* () {
        yield* withTempStorage(() =>
          withSession((session) =>
            Effect.gen(function* () {
              const runId = 'abc123' as RunId;
              publishTestRunStart(session, runId);
              session.publish([
                {
                  type: 'run.fact',
                  aggregateId: aggregateId('run', runId),
                  fact: {
                    key: 'todos',
                    todos: [
                      {
                        content: 'Read the committed task list',
                        status: 'in_progress',
                        activeForm: 'Reading the committed task list',
                      },
                    ],
                  },
                },
              ]);
              yield* session.settlePublications();
              mocks.readConfig.mockResolvedValue(config);
              const result = yield* ExecutionsTool.call({
                path: toolPath,
              }).pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    run: { session: session, runId: runId, toolPolicy: {} },
                  }),
                ),
              );

              expect(result.output).toContain('Read the committed task list');
            }),
          ),
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

  it.live('refuses unrecorded workspace file reads', () =>
    Effect.gen(function* () {
      yield* withTempDirEffect('texra-exec-files-', (workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(path.join(workspace, 'secret.md'), 'secret'),
          );
          mocks.readConfig.mockResolvedValue({
            ...config,
            workingDirectory: workspace,
          });
          mocks.readWorkspaceFiles.mockResolvedValue(['review.md']);

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
          mocks.readConfig.mockResolvedValue({
            ...config,
            workingDirectory: workspace,
          });
          mocks.readWorkspaceFiles.mockResolvedValue(['workspace/review.md']);

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
