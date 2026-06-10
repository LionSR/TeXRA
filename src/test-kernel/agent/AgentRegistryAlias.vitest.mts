// Standard library imports
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import {
  canonicalAgentName,
  getAgent,
  getVisibleAgents,
  loadAgents,
} from '@agent/index/agentRegistry';
import { setAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { initPlatform, platform } from '@platform/platform';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { createFakePlatform } from '@test/support/FakePlatform';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

describe('agent registry legacy aliases', () => {
  beforeAll(async () => {
    // Real bundled agent YAMLs on disk, so the test exercises the actual
    // rename (chat → assistant) rather than synthetic fixtures.
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
    setAgentDirectories({
      custom: async () => '',
      builtIn: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/agents'),
      builtInToolUse: async () =>
        resolve(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    });
    await loadAgents({ includeRemote: false });
  });

  it('maps chat to assistant in canonicalAgentName', () => {
    expect(canonicalAgentName('chat')).toBe('assistant');
    expect(canonicalAgentName('assistant')).toBe('assistant');
    expect(canonicalAgentName('research')).toBe('research');
  });

  it('resolves the legacy chat identifier to the assistant entry', () => {
    const entry = getAgent('chat');
    expect(entry?.name).toBe('assistant');
    expect(getAgent('assistant')?.name).toBe('assistant');
  });

  it('keeps assistant visible for workspaces that opted into chat', async () => {
    await platform().workspaceState.update(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ['chat'],
    );

    const visible = getVisibleAgents('toolUse').map((a) => a.name);
    expect(visible).toContain('assistant');
  });
});
