// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installPlatform } from '../support/setupPlatform';

afterEach(async () => {
  vi.doUnmock('@tools/externalToolDefs');
  vi.resetModules();
  await installPlatform();
});

describe('notifyUnavailableTools', () => {
  it('no-ops when the host omits toolNotificationHandler (optional Platform port)', async () => {
    vi.doMock('@tools/externalToolDefs', () => ({
      EXTERNAL_TOOL_DEFS: [
        {
          id: 'test-tool',
          tools: ['test_tool'],
          name: 'Test tool',
          category: 'ai-agents',
          check: vi.fn(async () => true),
        },
      ],
    }));
    await installPlatform({}, { toolNotificationHandler: undefined });
    const { notifyUnavailableTools } =
      await import('@tools/toolUnavailableNotification');

    // Must not throw even though the host has no notification surface.
    expect(() => notifyUnavailableTools(['test_tool'])).not.toThrow();
  });
});
