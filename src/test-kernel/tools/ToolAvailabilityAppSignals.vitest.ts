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

  it('derives unavailable tool names from the last probe results, with no cache to refresh', async () => {
    vi.doMock('@tools/externalToolDefs', () => ({
      EXTERNAL_TOOL_DEFS: [
        {
          id: 'present-tool',
          tools: ['present'],
          name: 'Present tool',
          category: 'ai-agents',
          check: vi.fn(async () => true),
        },
        {
          id: 'missing-tool',
          tools: ['missing'],
          name: 'Missing tool',
          category: 'ai-agents',
          toggleable: true,
          check: vi.fn(async () => false),
        },
      ],
    }));
    const { getUnavailableToolNamesCached, runExternalToolChecks } =
      await import('@tools/toolAvailability');

    expect([...getUnavailableToolNamesCached()]).toEqual([]);

    await runExternalToolChecks();

    // Toggling a tool on or off never changes this set — it reports missing
    // external dependencies only — so there is nothing to rebuild after a
    // toggle, which is why the availability answer is derived on read.
    expect([...getUnavailableToolNamesCached()]).toEqual(['missing']);
  });
});
