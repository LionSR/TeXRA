import '@test/support/defaultSessionTestSetup';

// Test composition imports

// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';

import { Effect } from 'effect';

import { beforeEach, describe, expect, vi } from 'vitest';
import type { ToolServices } from '@agent/runtime/ToolServices';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  defaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import { RUN_PHASE, DEFAULT_TOOL_CONFIG, aggregateId } from '@shared/schemas';
import {
  RunIdSchema,
  type RunId,
  type RunPhase,
  type TodoItem,
} from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { createFakeRunRecords } from '@test/support/FakeRunRecords';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { withTempDirEffect } from '@test/support/tempDirPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { ensureError } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';

/**
 * Move a run's phase the way its loop does: a `flow.step` row, which is the
 * one fact the fold derives a live phase from (one run model, 3.3).
 */
async function foldRunPhase(
  session: SessionHandle,
  runId: RunId,
  step: 'waiting' | 'turn.begin',
  expected: RunPhase,
): Promise<void> {
  session.publish([
    {
      type: 'flow.step',
      aggregateId: aggregateId('run', runId),
      payload: { family: 'toolUse', step },
    },
  ]);
  await vi.waitFor(() => {
    expect(session.runView(runId)?.status).toBe(expected);
  });
}

const tempDirs = useTempDirs();

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readChildren: vi.fn(),
  readReport: vi.fn(),
  readResultMeta: vi.fn(),
  readRunEnd: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('@agent/storage/runRecords', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/storage/runRecords')
  >('@agent/storage/runRecords');
  return {
    ...actual,
    getRunRecords: vi.fn(() =>
      createFakeRunRecords({
        readConfig: () =>
          Effect.tryPromise({
            try: () => mocks.readConfig(),
            catch: ensureError,
          }),
        readRunRecord: () =>
          Effect.tryPromise({
            try: () => mocks.readConfig(),
            catch: ensureError,
          }),
        readReport: () =>
          Effect.tryPromise({
            try: () => mocks.readReport(),
            catch: ensureError,
          }),
        readResultMeta: () =>
          Effect.tryPromise({
            try: () => mocks.readResultMeta(),
            catch: ensureError,
          }),
        readRunEnd: () =>
          Effect.tryPromise({
            try: () => mocks.readRunEnd(),
            catch: ensureError,
          }),
        readWorkspaceFiles: () =>
          Effect.tryPromise({
            try: () => mocks.readWorkspaceFiles(),
            catch: ensureError,
          }),
      }),
    ),
  };
});

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    listRuns: () =>
      Effect.tryPromise({
        try: () => mocks.listRuns(),
        catch: ensureError,
      }),
    readRunChildren: () =>
      Effect.tryPromise({
        try: () => mocks.readChildren(),
        catch: ensureError,
      }),
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
          installPlatform(
            {
              workspacePath: path.join(root, 'workspace'),
              storagePath: path.join(root, 'storage'),
            },
            { fs: nodeFilesystem },
          ),
        );
        yield* run();
      }),
    );
  });
}

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuns.mockResolvedValue([]);
    mocks.readChildren.mockResolvedValue([]);
    mocks.readReport.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readRunEnd.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  it.live("rejects '..' path traversal in /executions/{id}/files/{path}", () =>
    Effect.gen(function* () {
      const result = yield* new ExecutionsTool().call({
        path: '/executions/abc123def456/files/../../../../../../etc/passwd',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain("must not contain '..'");
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
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
      Effect.gen(function* () {
        const session = createTestSession();
        const parentRunId = RunIdSchema.parse('ba5e0000000a');
        const childRunId = RunIdSchema.parse('c41d0000000a');
        const otherRunId = RunIdSchema.parse('0f1e0000000a');
        const handle = testRunHandle({
          runId: childRunId,
          parent: parentRunId,
          agent: 'review',
        });

        try {
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          session.runs.track(handle);
          yield* Effect.promise(() =>
            foldRunPhase(session, childRunId, 'waiting', RUN_PHASE.WAITING),
          );
          mocks.readReport.mockResolvedValue(
            '<subagent-result>full report</subagent-result>',
          );

          const parentWaitResult = yield* new ExecutionsTool()
            .call({
              path: `/executions/${childRunId}`,
              action: 'wait',
            })
            .pipe(
              Effect.provide(
                nativeToolTestLayer({
                  run: { session: session, runId: parentRunId, toolPolicy: {} },
                }),
              ),
            );
          const crossTreeWaitResult = yield* new ExecutionsTool()
            .call({
              path: `/executions/${childRunId}`,
              action: 'wait',
            })
            .pipe(
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
        } finally {
          session.dispose();
        }
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live('reads running task lists from session snapshot state', () =>
    withTempStorage(() =>
      Effect.gen(function* () {
        const session = createTestSession();
        const parentRunId = RunIdSchema.parse('ba5e0000000b');
        const childRunId = RunIdSchema.parse('c41d0000000b');
        const handle = testRunHandle({
          runId: childRunId,
          parent: parentRunId,
          agent: 'review',
        });

        try {
          publishTestRunStart(session, parentRunId);
          publishTestRunStart(session, childRunId, { parent: parentRunId });
          yield* Effect.promise(() => session.settlePublications());
          session.runs.track(handle);
          yield* Effect.promise(() =>
            foldRunPhase(session, childRunId, 'turn.begin', RUN_PHASE.RUNNING),
          );
          session.publish([
            {
              type: 'updateTodos',
              aggregateId: aggregateId('run', childRunId),
              todos: [
                {
                  content: 'Read live snapshot state',
                  status: 'in_progress',
                  activeForm: 'Reading live snapshot state',
                },
              ],
            },
          ]);
          yield* Effect.promise(() => session.settlePublications());
          const [summary, todos] = yield* Effect.all([
            new ExecutionsTool().call({
              path: `/executions/${childRunId}`,
            }),
            new ExecutionsTool().call({
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
        } finally {
          session.dispose();
        }
      }),
    ).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
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
        Effect.gen(function* () {
          const session = createTestSession();
          const runId = 'abc123' as RunId;
          const callerRunId = RunIdSchema.parse('ca11e0000001');

          try {
            publishTestRunStart(session, runId);
            yield* Effect.promise(() => session.settlePublications());
            mocks.readConfig.mockResolvedValue(config);
            mocks.readReport.mockResolvedValue(
              '<subagent-result>full report</subagent-result>',
            );

            const [waitResult, reportResult] = yield* Effect.all([
              new ExecutionsTool().call({
                path: `/executions/${runId}`,
                action: 'wait',
              }),
              new ExecutionsTool().call({
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
          } finally {
            session.dispose();
          }
        }),
      ).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
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

      const result = yield* new ExecutionsTool().call({
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
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('keeps the background process result shape at /result', () =>
    Effect.gen(function* () {
      const record = {
        producer: 'backgroundBash' as const,
        command: 'echo hi',
        exitCode: 0,
        wallTimeMs: 10,
        success: true,
      };
      mocks.readResultMeta.mockResolvedValue(record);

      const result = yield* new ExecutionsTool().call({
        path: '/executions/abc123/result',
      });

      expect(JSON.parse(result.output ?? '')).toEqual(record);
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
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
          Effect.gen(function* () {
            const runId = 'abc123' as RunId;
            const session = createTestSession();
            publishTestRunStart(session, runId);
            session.publish([
              {
                type: 'updateTodos',
                aggregateId: aggregateId('run', runId),
                todos: [
                  {
                    content: 'Read the committed task list',
                    status: 'in_progress',
                    activeForm: 'Reading the committed task list',
                  },
                ],
              },
            ]);
            yield* Effect.promise(() => session.settlePublications());
            mocks.readConfig.mockResolvedValue(config);
            const result = yield* new ExecutionsTool()
              .call({ path: toolPath })
              .pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    run: { session: session, runId: runId, toolPolicy: {} },
                  }),
                ),
              );

            expect(result.output).toContain('Read the committed task list');
          }),
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'tool-test' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.live(
    'lists and reads persisted workspace files for tool-use executions',
    () =>
      Effect.gen(function* () {
        yield* withTempDirEffect('texra-exec-files-', (workspace) =>
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              writeFile(path.join(workspace, 'review.md'), '# report\n'),
            );
            mocks.readConfig.mockResolvedValue({
              ...config,
              workingDirectory: workspace,
            });
            mocks.readWorkspaceFiles.mockResolvedValue(['review.md']);

            const tool = new ExecutionsTool();
            const listResult = yield* tool.call({
              path: '/executions/abc123/workspace-files',
            });
            const readResult = yield* tool.call({
              path: '/executions/abc123/workspace-files/review.md',
            });

            expect(listResult.output).toContain('review.md');
            expect(readResult.summary).toBe(
              'Read /executions/abc123/workspace-files/review.md',
            );
            expect(readResult.output).toContain('# report');
          }),
        );
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
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

          const result = yield* new ExecutionsTool().call({
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
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  // A run's records are rows; every file in its directory is generated output.
  it.live('lists every file under /executions/{id}/files', () =>
    Effect.gen(function* () {
      yield* withTempStorage(() =>
        Effect.gen(function* () {
          const runId = 'abc123' as RunId;
          const runDir = resolveRunStoragePath(runId);
          yield* Effect.promise(() => StorageFS.ensureDir(runDir));
          const listedFiles = [
            'conversation.json',
            'todos.json',
            'meta.json',
            'config.json',
            'report.json',
            'workspace-files.json',
            'result-meta.json',
            'child-def456.json',
            'stable-subagent-attempt.json',
            'stable-subagent-sequence-abc123.json',
          ];
          for (const name of listedFiles) {
            yield* Effect.promise(() =>
              StorageFS.write(path.join(runDir, name), '{}'),
            );
          }
          yield* Effect.promise(() =>
            StorageFS.write(path.join(runDir, 'output.tex'), 'generated'),
          );

          const result = yield* new ExecutionsTool().call({
            path: `/executions/${runId}/files`,
          });

          expect(result.output).toContain('output.tex');
          for (const name of listedFiles) {
            expect(result.output).toContain(name);
          }
        }),
      );
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
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

          const result = yield* new ExecutionsTool().call({
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
            session: defaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
