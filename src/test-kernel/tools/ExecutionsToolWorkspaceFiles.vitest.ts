import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedStreamStatusForTest } from '@test/helpers/streamStatusTestUtils';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { AgentExecutionHandle } from '@agent/runtime/executionRegistry';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { ExecutionsTool } from '@tools/ExecutionsTool';

import { createRecordingHost } from '../agent/progressTestUtils';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readMeta: vi.fn(),
  readChildren: vi.fn(),
  readTodos: vi.fn(),
  readReport: vi.fn(),
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
      readMeta: mocks.readMeta,
      readChildren: mocks.readChildren,
      readTodos: mocks.readTodos,
      readReport: mocks.readReport,
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

/** Creates a temp workspace dir for the test body, then always removes it. */
async function withTempWorkspace(
  run: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'texra-exec-files-'));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

describe('ExecutionsTool', () => {
  setupPlatform({}, { fs: nodeFilesystem });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExecutions.mockResolvedValue([]);
    mocks.readMeta.mockResolvedValue(null);
    mocks.readChildren.mockResolvedValue([]);
    mocks.readTodos.mockResolvedValue([]);
    mocks.readReport.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
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
    const explicit = createRecordingHost();
    const session = new SessionHandle();
    const executionId = 'abc123';
    const parentStreamId = 'stream:parent-report-suppression' as StreamTabId;
    const childStreamId = 'stream:child-report-suppression' as StreamTabId;
    const otherStreamId = 'stream:other-report-reader' as StreamTabId;
    const handle = new AgentExecutionHandle(
      executionId,
      parentStreamId,
      childStreamId,
      'review',
      'toolUse',
      explicit.host,
    );

    try {
      session.executions.track(handle);
      seedStreamStatusForTest(
        session.status,
        childStreamId,
        STREAM_PHASE.WAITING,
      );
      mocks.readMeta.mockResolvedValue({
        timestamp: '2026-06-15T09:36:02.345Z',
        category: 'toolUse',
        parentExecutionId: 'parent123',
      });
      mocks.readReport.mockResolvedValue(
        '<subagent-result>full report</subagent-result>',
      );

      const parentWaitResult = await withRunContext(
        createRunContext({
          runtimeHost: explicit.host,
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
          runtimeHost: explicit.host,
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
      session.dispose();
    }
  });

  it('keeps completed wait summary reports inline when parent delivery cannot be confirmed', async () => {
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-06-15T09:36:02.345Z',
      category: 'toolUse',
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

  it('lists and reads persisted workspace files for tool-use executions', async () => {
    await withTempWorkspace(async (workspace) => {
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
    await withTempWorkspace(async (workspace) => {
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

  it('reads recorded files inside a top-level workspace directory', async () => {
    await withTempWorkspace(async (workspace) => {
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
