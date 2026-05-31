import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
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
      readWorkspaceFiles: mocks.readWorkspaceFiles,
    })),
    listExecutions: mocks.listExecutions,
  };
});

import { ExecutionsTool } from '@tools/ExecutionsTool';

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

describe('ExecutionsTool workspace files', () => {
  beforeEach(async () => {
    const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
      await Promise.all([
        import('@platform/platform'),
        import('@platform/defaults/nodeFilesystem'),
        import('@test/support/FakePlatform'),
      ]);
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    vi.clearAllMocks();
    mocks.listExecutions.mockResolvedValue([]);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
  });

  it('lists and reads persisted workspace files for tool-use executions', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'texra-exec-files-'));
    try {
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('refuses unrecorded workspace file reads', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'texra-exec-files-'));
    try {
      await writeFile(path.join(workspace, 'secret.md'), 'secret');
      mocks.readConfig.mockResolvedValue({
        ...config,
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['review.md']);

      const result = await new ExecutionsTool().call({
        path: '/executions/abc123/workspace-files/secret.md',
      });

      expect(result.isError).toBe(true);
      expect(result.error).toContain('Workspace file not found');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('reads recorded files inside a top-level workspace directory', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'texra-exec-files-'));
    try {
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
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
