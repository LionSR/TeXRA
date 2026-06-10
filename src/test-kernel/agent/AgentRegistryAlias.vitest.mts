// Standard library imports
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform } from '@platform/platform';
import { createFakePlatform } from '@test/support/FakePlatform';
import { setAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import {
  canonicalAgentName,
  getAgent,
  getVisibleAgents,
  loadAgents,
} from '@agent/index/agentRegistry';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

describe('agent registry legacy aliases', () => {
  beforeAll(async () => {
    // Real bundled agent YAMLs on disk, so the test exercises the actual
    // rename (chat → assistant) rather than synthetic fixtures.
    const { initPlatform } = await import('@platform/platform');
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
    // Unknown names pass through unchanged and must not recurse.
    expect(canonicalAgentName('no-such-agent')).toBe('no-such-agent');
    expect(getAgent('no-such-agent')).toBeUndefined();
  });

  it('resolves the legacy chat identifier to the assistant entry', () => {
    const entry = getAgent('chat');
    expect(entry?.name).toBe('assistant');
    expect(getAgent('assistant')?.name).toBe('assistant');
  });

  it('resolves source-qualified legacy keys', () => {
    expect(getAgent('builtInToolUse:chat')?.name).toBe('assistant');
    expect(getAgent('builtInToolUse:assistant')?.name).toBe('assistant');
    expect(getAgent('custom:no-such-agent')).toBeUndefined();
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
