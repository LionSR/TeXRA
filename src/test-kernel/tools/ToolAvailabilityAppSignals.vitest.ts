// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@tools/externalToolDefs');
  vi.resetModules();
});

describe('tool availability app signals', () => {
  it('emits toolAvailabilityChanged after a refresh', async () => {
    vi.doMock('@tools/externalToolDefs', () => ({
      EXTERNAL_TOOL_DEFS: [
        {
          id: 'test-tool',
          tools: [],
          name: 'Test tool',
          category: 'ai-agents',
          check: vi.fn(async () => true),
        },
      ],
    }));
    const { appSignals } = await import('@eventBus/AppSignals');
    const { refreshToolAvailability } = await import('@tools/toolAvailability');
    const events: undefined[] = [];
    const dispose = appSignals.on('toolAvailabilityChanged', (payload) => {
      events.push(payload);
    });

    try {
      await refreshToolAvailability();

      expect(events).toEqual([undefined]);
    } finally {
      dispose();
    }
  });
});
