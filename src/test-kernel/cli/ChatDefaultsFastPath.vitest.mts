import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listExecutions } from '@agent/storage';
import { loadWorkspaceCliConfig } from '@cli/runtime/cliConfig';
import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import { GlobalStorageFS } from '@utils/files/storageFS';

vi.mock('@cli/runtime/cliConfig', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliConfig')>();
  return {
    ...actual,
    loadWorkspaceCliConfig: vi.fn(),
  };
});

vi.mock('@agent/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/storage')>()),
  listExecutions: vi.fn(async () => []),
}));

vi.mock('@utils/files/storageFS', () => ({
  GlobalStorageFS: {
    readJson: vi.fn(async () => ({})),
  },
}));

const mockedLoadWorkspaceCliConfig = vi.mocked(loadWorkspaceCliConfig);
const mockedReadJson = vi.mocked(GlobalStorageFS.readJson);
const mockedListExecutions = vi.mocked(listExecutions);

beforeEach(() => {
  mockedLoadWorkspaceCliConfig.mockReset();
  mockedLoadWorkspaceCliConfig.mockResolvedValue({
    values: { chat: { agent: 'assistant', model: 'sonnet46T' } },
    warnings: [],
  });
  mockedReadJson.mockReset();
  mockedReadJson.mockResolvedValue({
    chat: { agent: 'assistant', model: 'sonnet46T' },
  });
  mockedListExecutions.mockReset();
  mockedListExecutions.mockResolvedValue([]);
});

describe('CLI chat defaults direct-value fast path', () => {
  it('skips workspace, user, and history loaders when direct values are complete', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/workspace-with-defaults',
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      }),
    ).resolves.toMatchObject({
      agent: 'simplifier',
      model: 'deepseekT',
      agentSource: 'explicit-override',
      modelSource: 'explicit-override',
    });

    expect(mockedLoadWorkspaceCliConfig).not.toHaveBeenCalled();
    expect(mockedReadJson).not.toHaveBeenCalled();
    expect(mockedListExecutions).not.toHaveBeenCalled();
  });

  it('keeps default-tier loading when only one direct value is present', async () => {
    await expect(
      resolveChatDefaults({
        cwd: '/tmp/workspace-with-defaults',
        modelOverride: 'deepseekT',
      }),
    ).resolves.toMatchObject({
      agent: 'assistant',
      model: 'deepseekT',
      agentSource: 'workspace-config',
      modelSource: 'explicit-override',
    });

    expect(mockedLoadWorkspaceCliConfig).toHaveBeenCalledOnce();
  });
});
