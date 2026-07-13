import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({ lm: undefined }));

const { createLanguageModelPort } =
  await import('@frontend/lm/createLanguageModelPort');

describe('createLanguageModelPort without vscode.lm', () => {
  it('uses the shared unavailable implementation', async () => {
    const port = createLanguageModelPort(
      {} as Parameters<typeof createLanguageModelPort>[0],
    );

    expect(port.isAvailable()).toBe(false);
    await expect(port.selectModels()).resolves.toEqual([]);
    await expect(port.countTokens('missing', 'text')).rejects.toThrow(
      'unavailable in this host',
    );
  });
});
