import { describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { polishTextWithAI } from '@agent/runtime/textEnhancement';

const mocks = vi.hoisted(() => ({
  createHelperModelKit: vi.fn(),
  renderPolishPrompt: vi.fn(async () => 'polish prompt'),
  runHelperModelCompletion: vi.fn(),
}));

vi.mock('@agent/runtime/helperModel', () => ({
  createHelperModelKit: mocks.createHelperModelKit,
  runHelperModelCompletion: mocks.runHelperModelCompletion,
}));

vi.mock('@agent/runtime/bundledPrompts', () => ({
  renderPolishPrompt: mocks.renderPolishPrompt,
}));

describe('text enhancement session ownership', () => {
  it('passes an explicit host session to helper-model creation', async () => {
    const session = {} as SessionHandle;
    const kit = { handler: {}, client: {}, modelName: 'helper' };
    mocks.createHelperModelKit.mockResolvedValue({ kit });
    mocks.runHelperModelCompletion.mockResolvedValue(
      '<corrected_text>polished</corrected_text>',
    );

    await expect(
      polishTextWithAI('draft', undefined, session),
    ).resolves.toEqual({
      success: true,
      text: 'polished',
    });
    expect(mocks.createHelperModelKit).toHaveBeenCalledExactlyOnceWith(session);
  });
});
