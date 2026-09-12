// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import { RUN_PHASE, DEFAULT_TOOL_CONFIG, aggregateId } from '@shared/schemas';
import { RunIdSchema, type RunId, type TodoItem } from '@shared/schemas';
import {
  createFakeKv,
  createFakeRunRecords,
} from '@test/support/FakeRunKVStore';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { seedRunStatusForTest } from '@test/support/runStatusTestUtils';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { withTempDir } from '@test/support/tempDirPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { ensureError } from '@utils/errors/errorMessage';
import { StorageFS } from '@utils/files/storageFS';

const tempDirs = useTempDirs();

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readChildren: vi.fn(),
  readReport: vi.fn(),
  readResultMeta: vi.fn(),
  readRunEnd: vi.fn(),
  readTurnState: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('@agent/storage/RunKVStore', async () => {
  const actual = await vi.importActual<
    typeof import('@agent/storage/RunKVStore')
  >('@agent/storage/RunKVStore');
  return {
    ...actual,
    getRunStore: vi.fn((id: RunId) =>
      createFakeKv(id, { readTurnState: mocks.readTurnState }),
    ),
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
async function withTempStorage(run: () => Promise<void>): Promise<void> {
  await withTempDir('texra-exec-storage-', async (root) => {
    await installPlatform(
      {
        workspacePath: path.join(root, 'workspace'),
        storagePath: path.join(root, 'storage'),
      },
      { fs: nodeFilesystem },
    );
    await run();
  });
}

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuns.mockResolvedValue([]);
    mocks.readTurnState.mockResolvedValue(null);
    mocks.readChildren.mockResolvedValue([]);
    mocks.readReport.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readRunEnd.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  it("rejects '..' path traversal in /executions/{id}/files/{path}", async () => {
    const result = await new ExecutionsTool().call({
      path: '/executions/abc123def456/files/../../../../../../etc/passwd',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain("must not contain '..'");
  });

  it('does not duplicate auto-delivered live subagent reports for the parent run', async () => {
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
      session.runs.track(handle);
      seedRunStatusForTest(session.status, childRunId, {
        phase: RUN_PHASE.WAITING,
      });
      mocks.readReport.mockResolvedValue(
        '<subagent-result>full report</subagent-result>',
      );

      const parentWaitResult = await withRunContext(
        createRunContext({
          runId: parentRunId,
          session,
        }),
        () =>
          new ExecutionsTool().call({
            path: `/executions/${childRunId}`,
            action: 'wait',
          }),
      );
      const crossTreeWaitResult = await withRunContext(
        createRunContext({
          runId: otherRunId,
          session,
        }),
        () =>
          new ExecutionsTool().call({
            path: `/executions/${childRunId}`,
            action: 'wait',
          }),
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
  });

  it('reads running task lists from session snapshot state', () =>
    withTempStorage(async () => {
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
        await session.settlePublications();
        session.runs.track(handle);
        seedRunStatusForTest(session.status, childRunId, {
          phase: RUN_PHASE.RUNNING,
        });
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
        await session.settlePublications();
        const [summary, todos] = await withRunContext(
          createRunContext({ runId: parentRunId, session }),
          () =>
            Promise.all([
              new ExecutionsTool().call({
                path: `/executions/${childRunId}`,
              }),
              new ExecutionsTool().call({
                path: `/executions/${childRunId}/todos`,
              }),
            ]),
        );

        expect(summary.output).toContain('Read live snapshot state');
        expect(todos.output).toContain('Read live snapshot state');
      } finally {
        session.dispose();
      }
    }));

  // A completed run has no live handle, so nothing proves the caller is the
  // parent run that already received the report as a follow-up. The wait
  // summary must therefore keep the report inline rather than eliding it.
  it('keeps completed wait summary reports inline when parent delivery cannot be confirmed', () =>
    withTempStorage(async () => {
      const session = createTestSession();
      const runId = 'abc123' as RunId;
      const callerRunId = RunIdSchema.parse('ca11e0000001');

      try {
        publishTestRunStart(session, runId);
        await session.settlePublications();
        mocks.readConfig.mockResolvedValue(config);
        mocks.readReport.mockResolvedValue(
          '<subagent-result>full report</subagent-result>',
        );

        const [waitResult, reportResult] = await withRunContext(
          createRunContext({ runId: callerRunId, session }),
          () =>
            Promise.all([
              new ExecutionsTool().call({
                path: `/executions/${runId}`,
                action: 'wait',
              }),
              new ExecutionsTool().call({
                path: `/executions/${runId}/report`,
              }),
            ]),
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
    }));

  it.each([
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
  ])(
    'exposes only the final envelope for a $label result',
    async ({ record }) => {
      // The terminal fact comes from the `run.end` row; the producer record
      // contributes the delivery-enriched output and nothing else.
      const runEnd = {
        outcome: 'completed' as const,
        usage: { totalCost: 0.2 },
        output: { category: 'toolUse' as const, response: '', files: [] },
      };
      mocks.readResultMeta.mockResolvedValue(record);
      mocks.readRunEnd.mockResolvedValue(runEnd);

      const result = await new ExecutionsTool().call({
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
    },
  );

  it('keeps the background process result shape at /result', async () => {
    const record = {
      producer: 'backgroundBash' as const,
      command: 'echo hi',
      exitCode: 0,
      wallTimeMs: 10,
      success: true,
    };
    mocks.readResultMeta.mockResolvedValue(record);

    const result = await new ExecutionsTool().call({
      path: '/executions/abc123/result',
    });

    expect(JSON.parse(result.output ?? '')).toEqual(record);
  });

  // The advertised /executions/{id}/todos endpoint must resolve a task list
  // exactly as the completed summary does, from the same committed stream fold.
  it.each([
    { label: 'completed summary', toolPath: '/executions/abc123' },
    { label: 'todos endpoint', toolPath: '/executions/abc123/todos' },
  ])(
    'reads completed todos from committed stream events via the $label',
    async ({ toolPath }) => {
      await withTempStorage(async () => {
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
        await session.settlePublications();
        mocks.readConfig.mockResolvedValue(config);
        const result = await withRunContext(
          createRunContext({ runId, session }),
          () => new ExecutionsTool().call({ path: toolPath }),
        );

        expect(result.output).toContain('Read the committed task list');
      });
    },
  );

  it('lists and reads persisted workspace files for tool-use executions', async () => {
    await withTempDir('texra-exec-files-', async (workspace) => {
      await writeFile(path.join(workspace, 'review.md'), '# report\n');
      mocks.readConfig.mockResolvedValue({
        ...config,
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['review.md']);

      const tool = new ExecutionsTool();
      const listResult = await tool.call({
        path: '/executions/abc123/workspace-files',
      });
      const readResult = await tool.call({
        path: '/executions/abc123/workspace-files/review.md',
      });

      expect(listResult.output).toContain('review.md');
      expect(readResult.summary).toBe(
        'Read /executions/abc123/workspace-files/review.md',
      );
      expect(readResult.output).toContain('# report');
    });
  });

  it('refuses unrecorded workspace file reads', async () => {
    await withTempDir('texra-exec-files-', async (workspace) => {
      await writeFile(path.join(workspace, 'secret.md'), 'secret');
      mocks.readConfig.mockResolvedValue({
        ...config,
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['review.md']);

      const result = await new ExecutionsTool().call({
        path: '/executions/abc123/workspace-files/secret.md',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('Workspace file not found');
    });
  });

  // Exercises the real listing so every reserved KV filename — including the
  // child- and flow_ prefixed ones — stays out of the model-facing view.
  it('filters internal KV metadata files out of /executions/{id}/files', async () => {
    await withTempStorage(async () => {
      const runId = 'abc123' as RunId;
      const runDir = resolveRunStoragePath(runId);
      await StorageFS.ensureDir(runDir);
      const kvFiles = [
        'stable-subagent-attempt.json',
        'stable-subagent-sequence-abc123.json',
        'workflow-script-call-1.json',
        // The retired engine's checkpoint, before and after the rename the
        // first ledger append gives it.
        `flow_${runId}.json`,
        `flow_${runId}.json.superseded`,
      ];
      for (const name of kvFiles) {
        await StorageFS.write(path.join(runDir, name), '{}');
      }
      const retiredKvFiles = [
        'conversation.json',
        'todos.json',
        'meta.json',
        'config.json',
        'report.json',
        'workspace-files.json',
        'result-meta.json',
        'child-def456.json',
      ];
      for (const name of retiredKvFiles) {
        await StorageFS.write(path.join(runDir, name), '{}');
      }
      await StorageFS.write(path.join(runDir, 'output.tex'), 'generated');

      const result = await new ExecutionsTool().call({
        path: `/executions/${runId}/files`,
      });

      expect(result.output).toContain('output.tex');
      for (const name of retiredKvFiles) {
        expect(result.output).toContain(name);
      }
      for (const name of kvFiles) {
        expect(result.output).not.toContain(name);
      }
    });
  });

  // Every real KV entry is written as `{key}.json` (KVStore.keyToPath always
  // appends the suffix), so a generated file whose basename collides with a
  // reserved key name but carries no `.json` extension stays visible.

  it('reads recorded files inside a top-level workspace directory', async () => {
    await withTempDir('texra-exec-files-', async (workspace) => {
      await mkdir(path.join(workspace, 'workspace'));
      await writeFile(path.join(workspace, 'review.md'), 'wrong');
      await writeFile(path.join(workspace, 'workspace', 'review.md'), 'nested');
      mocks.readConfig.mockResolvedValue({
        ...config,
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['workspace/review.md']);

      const result = await new ExecutionsTool().call({
        path: '/executions/abc123/workspace-files/workspace/review.md',
      });

      expect(result.summary).toBe(
        'Read /executions/abc123/workspace-files/workspace/review.md',
      );
      expect(result.output).toContain('nested');
      expect(result.output).not.toContain('wrong');
    });
  });
});
