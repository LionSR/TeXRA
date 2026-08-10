// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createHelperModelKit = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/helperModel', async (importActual) => ({
  ...(await importActual<typeof import('@agent/runtime/helperModel')>()),
  createHelperModelKit,
}));

describe('bestConnectionMethod helper model routing', () => {
  beforeEach(() => {
    vi.resetModules();
    createHelperModelKit.mockReset();
  });

  it('uses the configured helper model', async () => {
    const initializeMessages = vi.fn(async () => [{ role: 'user' }]);
    const createResponse = vi.fn(async () => ({ response: { id: 'r1' } }));
    const extractResponse = vi.fn(() => ({
      text: 'A',
      usage: {},
      stopReason: 'stop',
    }));

    createHelperModelKit.mockResolvedValue({
      kit: {
        handler: {
          initializeMessages,
          createResponse,
          extractResponse,
        },
        client: { provider: 'helper' },
        modelName: 'deepseekT',
      },
    });

    const { bestConnectionMethod } =
      await import('@agent/runtime/textConnection');
    const result = await bestConnectionMethod('left', 'right');

    expect(result).toEqual({ connector: '', choice: 'A' });
    expect(createHelperModelKit).toHaveBeenCalledTimes(1);
    expect(initializeMessages).toHaveBeenCalledWith(
      '',
      expect.stringContaining('Which string is grammatically correct'),
      undefined,
      expect.stringContaining('LaTeX document context'),
    );
    expect(createResponse).toHaveBeenCalledWith({
      client: { provider: 'helper' },
      messages: [{ role: 'user' }],
      temperature: 0,
      systemPrompt: expect.stringContaining('LaTeX document context'),
    });
  });
});
