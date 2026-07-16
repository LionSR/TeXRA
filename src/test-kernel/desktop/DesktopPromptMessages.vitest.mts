import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadPromptMessages(): Promise<
  typeof import('../../../packages/desktop/src/desktopPromptMessages')
> {
  return import(
    moduleFileUrl(desktopSourcePath('desktopPromptMessages.ts'))
  ) as Promise<
    typeof import('../../../packages/desktop/src/desktopPromptMessages')
  >;
}

describe('desktop prompt messages', () => {
  it('round-trips text and password prompt requests', async () => {
    const { DesktopShowPromptMessageSchema, buildDesktopShowPromptMessage } =
      await loadPromptMessages();
    const message = buildDesktopShowPromptMessage({
      requestId: 'prompt-1',
      title: 'Set API key',
      prompt: 'Enter OpenAI API key',
      inputType: 'password',
      placeHolder: 'sk-...',
    });

    expect(DesktopShowPromptMessageSchema.parse(message)).toEqual(message);
  });

  it('omits absent optional prompt fields', async () => {
    const { buildDesktopShowPromptMessage } = await loadPromptMessages();
    expect(
      buildDesktopShowPromptMessage({
        requestId: 'prompt-1',
        title: 'Prompt',
        prompt: 'Value',
        inputType: 'text',
        placeHolder: undefined,
        value: undefined,
      }),
    ).toEqual({
      command: 'desktop:showPrompt',
      requestId: 'prompt-1',
      title: 'Prompt',
      prompt: 'Value',
      inputType: 'text',
    });
  });

  it('builds a strict prompt close command', async () => {
    const { buildDesktopClosePromptMessage, DesktopClosePromptMessageSchema } =
      await loadPromptMessages();
    expect(
      DesktopClosePromptMessageSchema.parse(buildDesktopClosePromptMessage()),
    ).toEqual({ command: 'desktop:closePrompt' });
  });

  it('rejects malformed input types and extra fields', async () => {
    const { DesktopShowPromptMessageSchema } = await loadPromptMessages();
    expect(
      DesktopShowPromptMessageSchema.safeParse({
        command: 'desktop:showPrompt',
        requestId: 'prompt-1',
        title: 'Prompt',
        prompt: 'Value',
        inputType: 'secret',
      }).success,
    ).toBe(false);
    expect(
      DesktopShowPromptMessageSchema.safeParse({
        command: 'desktop:showPrompt',
        requestId: 'prompt-1',
        title: 'Prompt',
        prompt: 'Value',
        inputType: 'text',
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it('distinguishes submitted empty text from cancellation', async () => {
    const { buildDesktopPromptResultMessage } = await loadPromptMessages();
    expect(buildDesktopPromptResultMessage('prompt-1', '')).toEqual({
      command: 'desktop:promptResult',
      requestId: 'prompt-1',
      value: '',
    });
    expect(buildDesktopPromptResultMessage('prompt-2')).toEqual({
      command: 'desktop:promptResult',
      requestId: 'prompt-2',
    });
  });
});
