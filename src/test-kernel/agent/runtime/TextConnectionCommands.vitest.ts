import { beforeEach, describe, expect, it, vi } from 'vitest';

const createHelperModelKit = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/helperModel', () => ({
  createHelperModelKit,
}));

import { runRuntimeTextConnectionDiagnostics } from '@agent/runtime/textConnectionCommands';

function helperKitReturning(choices: readonly string[]) {
  let index = 0;
  return {
    kit: {
      handler: {
        initializeMessages: vi.fn(async () => [{ role: 'user' }]),
        createResponse: vi.fn(async () => ({ response: { id: 'r1' } })),
        extractResponse: vi.fn(() => {
          const choice = choices[index] ?? 'B';
          index += 1;
          return {
            text: choice,
            usage: {},
            stopReason: 'stop',
          };
        }),
      },
      client: { provider: 'helper' },
      modelName: 'deepseekT',
    },
  };
}

describe('runtime text-connection commands', () => {
  beforeEach(() => {
    createHelperModelKit.mockReset();
  });

  it('runs provider diagnostics and returns host-loggable rows', async () => {
    createHelperModelKit
      .mockResolvedValueOnce(helperKitReturning(['B']))
      .mockResolvedValueOnce(helperKitReturning(['C']));

    await expect(
      runRuntimeTextConnectionDiagnostics([{ str1: 'A', str2: 'B' }]),
    ).resolves.toEqual([
      {
        provider: 'OpenAI',
        str1: 'A',
        str2: 'B',
        result: { connector: ' ', choice: 'B' },
        connectedText: 'A B',
      },
      {
        provider: 'Anthropic',
        str1: 'A',
        str2: 'B',
        result: { connector: '\n', choice: 'C' },
        connectedText: 'A\nB',
      },
    ]);

    expect(createHelperModelKit).toHaveBeenCalledTimes(2);
  });
});
