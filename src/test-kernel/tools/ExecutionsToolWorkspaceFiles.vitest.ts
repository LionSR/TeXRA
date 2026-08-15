// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flowKey } from '@agent/node/persistedFlow';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import { createTestSession } from '@test/support/sessionTestUtils';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { withTempDir } from '@test/support/tempDirPlatform';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { StreamSnapshotStore, streamDataDir } from '@transcript';
import { StorageFS } from '@utils/files/storageFS';

const tempDirs: string[] = [];

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readMeta: vi.fn(),
  readChildren: vi.fn(),
  readReport: vi.fn(),
  readResultMeta: vi.fn(),
  readTurnState: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  listExecutions: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    getExecutionStore: vi.fn(() => ({
      readConfig: mocks.readConfig,
      // The tool reads the record; this suite's fixtures are all agent-arm,
      // so the record IS the config.
      readRunRecord: mocks.readConfig,
      readMeta: mocks.readMeta,
      readChildren: mocks.readChildren,
      readReport: mocks.readReport,
      readResultMeta: mocks.readResultMeta,
      readTurnState: mocks.readTurnState,
      readWorkspaceFiles: mocks.readWorkspaceFiles,
    })),
    listExecutions: mocks.listExecutions,
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

const toolUseMeta = {
  timestamp: '2026-06-15T09:36:02.345Z',
  category: 'toolUse',
} as const;

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

/** Writes a stream sidecar work plan for the run and returns its stream id. */
async function writeSidecarTodos(
  executionId: ExecutionId,
  todos: TodoItem[],
): Promise<StreamTabId> {
  const streamId = `codex#${executionId}` as StreamTabId;
  const snapshots = new StreamSnapshotStore();
  snapshotFacts(snapshots).setTodos(streamId, todos);
  await snapshots.flush();
  await StorageFS.write(
    path.join(streamDataDir(streamId), 'meta.json'),
    JSON.stringify({
      schemaVersion: 1,
      executionId,
    }),
  );
  return streamId;
}

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExecutions.mockResolvedValue([]);
    mocks.readMeta.mockResolvedValue(null);
    mocks.readChildren.mockResolvedValue([]);
    mocks.readReport.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it.each([
    { label: 'caps oversized', timeout: 3600 },
    { label: 'raises sub-minimum', timeout: 30 },
  ])(
    '$label wait timeouts instead of rejecting the tool call',
    async ({ timeout }) => {
      const result = await new ExecutionsTool().call({
        path: '/executions',
        action: 'wait',
        timeout,
      });

      expect(result.status).toBe('executed');
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('No execution history found.');
    },
  );

  it('rejects non-finite wait timeouts', async () => {
    const result = await new ExecutionsTool().call({
      path: '/executions',
      action: 'wait',
      timeout: Number.NaN,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain('Invalid input');
  });

  it("rejects '..' path traversal in /executions/{id}/files/{path}", async () => {
    const result = await new ExecutionsTool().call({
      path: '/executions/abc123def456/files/../../../../../../etc/passwd',
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain("must not contain '..'");
  });

  it('does not duplicate auto-delivered live subagent reports for the parent stream', async () => {
    const session = createTestSession();
    const executionId = 'abc123';
    const parentStreamId = 'stream:parent-report-suppression' as StreamTabId;
    const childStreamId = 'stream:child-report-suppression' as StreamTabId;
    const otherStreamId = 'stream:other-report-reader' as StreamTabId;
    const handle = testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'review',
    });

    try {
      session.executions.track(handle);
      seedStreamStatusForTest(session.status, childStreamId, {
        phase: STREAM_PHASE.WAITING,
      });
      mocks.readMeta.mockResolvedValue({
        ...toolUseMeta,
        parentExecutionId: 'parent123',
      });
      mocks.readReport.mockResolvedValue(
        '<subagent-result>full report</subagent-result>',
      );

      const parentWaitResult = await withRunContext(
        createRunContext({
          streamId: parentStreamId,
          session,
        }),
        () =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}`,
            action: 'wait',
          }),
      );
      const crossTreeWaitResult = await withRunContext(
        createRunContext({
          streamId: otherStreamId,
          session,
        }),
        () =>
          new ExecutionsTool().call({
            path: `/executions/${executionId}`,
            action: 'wait',
          }),
      );

      expect(parentWaitResult.output).toContain(
        'Result: delivered automatically to this parent stream as a follow-up message.',
      );
      expect(parentWaitResult.output).toContain('/executions/abc123/report');
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
      await session.snapshots.flush();
      session.dispose();
    }
  });

  it('reads running task lists from session snapshot state', () =>
    withTempStorage(async () => {
      const session = createTestSession();
      const executionId = 'abc124';
      const parentStreamId = 'stream:parent-live-todos' as StreamTabId;
      const childStreamId = 'stream:child-live-todos' as StreamTabId;
      const handle = testExecutionHandle({
        executionId,
        parentStreamId,
        childStreamId,
        agent: 'review',
      });

      try {
        session.executions.track(handle);
        seedStreamStatusForTest(session.status, childStreamId, {
          phase: STREAM_PHASE.RUNNING,
        });
        snapshotFacts(session.snapshots).setTodos(childStreamId, [
          {
            content: 'Read live snapshot state',
            status: 'in_progress',
            activeForm: 'Reading live snapshot state',
          },
        ]);
        await session.snapshots.flush();
        mocks.readMeta.mockResolvedValue(toolUseMeta);

        const [summary, todos] = await withRunContext(
          createRunContext({ streamId: parentStreamId, session }),
          () =>
            Promise.all([
              new ExecutionsTool().call({
                path: `/executions/${executionId}`,
              }),
              new ExecutionsTool().call({
                path: `/executions/${executionId}/todos`,
              }),
            ]),
        );

        expect(summary.output).toContain('Read live snapshot state');
        expect(todos.output).toContain('Read live snapshot state');
      } finally {
        session.dispose();
      }
    }));

  it('keeps completed wait summary reports inline when parent delivery cannot be confirmed', async () => {
    mocks.readMeta.mockResolvedValue({
      ...toolUseMeta,
      parentExecutionId: 'parent123',
    });
    mocks.readConfig.mockResolvedValue(config);
    mocks.readReport.mockResolvedValue(
      '<subagent-result>full report</subagent-result>',
    );

    const waitResult = await new ExecutionsTool().call({
      path: '/executions/abc123',
      action: 'wait',
    });
    const reportResult = await new ExecutionsTool().call({
      path: '/executions/abc123/report',
    });

    expect(waitResult.output).toContain(
      '<subagent-result>full report</subagent-result>',
    );
    expect(waitResult.output).not.toContain('delivered automatically');
    expect(reportResult.output).toBe(
      '<subagent-result>full report</subagent-result>',
    );
  });

  it.each([
    {
      label: 'subagent',
      record: {
        producer: 'subagent' as const,
        agentName: 'reviewer',
        wallTimeMs: 20,
        result: {
          category: 'toolUse' as const,
          outcome: 'completed' as const,
          response: 'Checked the proof.',
          files: ['notes.md'],
          cost: 0.2,
        },
      },
    },
    {
      label: 'CLI workflow',
      record: {
        producer: 'cliWorkflow' as const,
        copiedOutput: '/workspace/polished.tex',
        result: {
          category: 'workflow' as const,
          outcome: 'completed' as const,
          outputs: [],
          compileFailures: [],
          diffs: [],
          cost: 0.4,
        },
      },
    },
  ])(
    'exposes only the final envelope for a $label result',
    async ({ record }) => {
      mocks.readResultMeta.mockResolvedValue(record);

      const result = await new ExecutionsTool().call({
        path: '/executions/abc123/result',
      });

      expect(JSON.parse(result.output ?? '')).toEqual(record.result);
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
  // exactly as the completed summary does, sidecar first (#7300).
  it.each([
    { label: 'completed summary', toolPath: '/executions/abc123' },
    { label: 'todos endpoint', toolPath: '/executions/abc123/todos' },
  ])(
    'reads completed todos from stream sidecars via the $label',
    async ({ toolPath }) => {
      await withTempStorage(async () => {
        const executionId = 'abc123' as ExecutionId;
        const streamId = await writeSidecarTodos(executionId, [
          {
            content: 'Read the sidecar work plan',
            status: 'in_progress',
            activeForm: 'Reading the sidecar work plan',
          },
        ]);
        mocks.readMeta.mockResolvedValue({ ...toolUseMeta, streamId });
        mocks.readConfig.mockResolvedValue(config);
        const result = await new ExecutionsTool().call({ path: toolPath });

        expect(result.output).toContain('Read the sidecar work plan');
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
      const executionId = 'abc123' as ExecutionId;
      const runDir = resolveRunStoragePath(executionId);
      await StorageFS.ensureDir(runDir);
      const kvFiles = [
        'meta.json',
        'config.json',
        'report.json',
        'workspace-files.json',
        'result-meta.json',
        'child-def456.json',
        'stable-subagent-attempt.json',
        'stable-subagent-sequence-abc123.json',
        'workflow-script-call-1.json',
        `${flowKey(executionId)}.json`,
      ];
      for (const name of kvFiles) {
        await StorageFS.write(path.join(runDir, name), '{}');
      }
      const retiredKvFiles = ['conversation.json', 'todos.json'];
      for (const name of retiredKvFiles) {
        await StorageFS.write(path.join(runDir, name), '{}');
      }
      await StorageFS.write(path.join(runDir, 'output.tex'), 'generated');

      const result = await new ExecutionsTool().call({
        path: `/executions/${executionId}/files`,
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
  it('keeps extensionless generated files named like reserved KV keys', async () => {
    await withTempStorage(async () => {
      const executionId = 'abc123' as ExecutionId;
      const runDir = resolveRunStoragePath(executionId);
      await StorageFS.ensureDir(runDir);
      const bareNames = ['meta', 'config', 'report', 'child-def456'];
      for (const name of bareNames) {
        await StorageFS.write(path.join(runDir, name), 'generated');
      }

      const result = await new ExecutionsTool().call({
        path: `/executions/${executionId}/files`,
      });

      for (const name of bareNames) {
        expect(result.output).toContain(name);
      }
    });
  });

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
