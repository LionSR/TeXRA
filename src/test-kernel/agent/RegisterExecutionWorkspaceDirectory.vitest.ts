/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const mocks = vi.hoisted(() => ({
  getExecutionStore: vi.fn(),
  writeConfig: vi.fn(),
  writeMeta: vi.fn(),
}));

vi.mock('@agent/storage/ExecutionKVStore', () => ({
  getExecutionStore: mocks.getExecutionStore,
}));

vi.mock('@agent/storage/executionListing', () => ({
  invalidateListingCache: vi.fn(),
}));

import { registerExecution } from '@agent/storage/executionLifecycle';
import { setupPlatform } from '@test/support/setupPlatform';

const baseConfig = {
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

describe('registerExecution', () => {
  setupPlatform({ workspacePath: '/workspace/root' });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getExecutionStore.mockReturnValue({
      writeConfig: mocks.writeConfig,
      writeMeta: mocks.writeMeta,
    });
  });

  it('pins the active workspace path when a config has no working directory', async () => {
    await registerExecution(
      'abc123' as ExecutionId,
      baseConfig,
      'chat',
      undefined,
      'toolUse',
    );

    expect(mocks.writeConfig).toHaveBeenCalledWith({
      ...baseConfig,
      workingDirectory: '/workspace/root',
    });
  });
});
