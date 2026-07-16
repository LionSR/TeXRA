import { describe, expect, it, vi } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadPromptIpc(): Promise<
  typeof import('../../../packages/desktop/src/main/desktopPromptIpc')
> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopPromptIpc.ts'))
  ) as Promise<
    typeof import('../../../packages/desktop/src/main/desktopPromptIpc')
  >;
}

describe('desktop prompt IPC', () => {
  it('serializes prompts and correlates submitted results', async () => {
    const { createDesktopPromptIpc } = await loadPromptIpc();
    const messages: Array<Record<string, unknown>> = [];
    const prompt = createDesktopPromptIpc({
      postToRenderer: (message) => {
        messages.push(message as Record<string, unknown>);
        return true;
      },
    });

    const first = prompt.input({ prompt: 'First' });
    const second = prompt.input({ prompt: 'Second', password: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      command: 'desktop:showPrompt',
      prompt: 'First',
      inputType: 'text',
    });

    prompt.handleMessage({
      command: 'desktop:promptResult',
      requestId: String(messages[0]?.requestId),
      value: 'one',
    });
    await expect(first).resolves.toBe('one');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      prompt: 'Second',
      inputType: 'password',
    });

    prompt.handleMessage({
      command: 'desktop:promptResult',
      requestId: String(messages[1]?.requestId),
    });
    await expect(second).resolves.toBeUndefined();
  });

  it('ignores malformed and unknown results without settling the active prompt', async () => {
    const { createDesktopPromptIpc } = await loadPromptIpc();
    const messages: Array<Record<string, unknown>> = [];
    const prompt = createDesktopPromptIpc({
      postToRenderer: (message) => {
        messages.push(message as Record<string, unknown>);
        return true;
      },
    });
    let settled = false;
    const result = prompt.input({ prompt: 'Value' }).then((value) => {
      settled = true;
      return value;
    });

    expect(prompt.handleMessage({ command: 'desktop:promptResult' })).toBe(
      true,
    );
    expect(
      prompt.handleMessage({
        command: 'desktop:promptResult',
        requestId: 'unknown',
        value: 'spoofed',
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);

    prompt.handleMessage({
      command: 'desktop:promptResult',
      requestId: String(messages[0]?.requestId),
      value: 'accepted',
    });
    await expect(result).resolves.toBe('accepted');
  });

  it('settles active and queued prompts exactly once when disposed', async () => {
    const { createDesktopPromptIpc } = await loadPromptIpc();
    const prompt = createDesktopPromptIpc({
      postToRenderer: () => true,
    });
    const firstResolution = vi.fn();
    const secondResolution = vi.fn();
    const first = prompt.input({ prompt: 'First' }).then(firstResolution);
    const second = prompt.input({ prompt: 'Second' }).then(secondResolution);

    prompt.dispose();
    prompt.dispose();
    await Promise.all([first, second]);
    expect(firstResolution).toHaveBeenCalledOnce();
    expect(firstResolution).toHaveBeenCalledWith(undefined);
    expect(secondResolution).toHaveBeenCalledOnce();
    expect(secondResolution).toHaveBeenCalledWith(undefined);
    await expect(
      prompt.input({ prompt: 'After close' }),
    ).resolves.toBeUndefined();
  });

  it('cancels pending prompts while allowing a recovered renderer to continue', async () => {
    const { createDesktopPromptIpc } = await loadPromptIpc();
    const messages: Array<Record<string, unknown>> = [];
    const prompt = createDesktopPromptIpc({
      postToRenderer: (message) => {
        messages.push(message as Record<string, unknown>);
        return true;
      },
    });
    const interrupted = prompt.input({ prompt: 'Before reload' });

    prompt.cancelPending();
    await expect(interrupted).resolves.toBeUndefined();
    expect(messages[1]).toEqual({ command: 'desktop:closePrompt' });

    const recovered = prompt.input({ prompt: 'After reload' });
    expect(messages).toHaveLength(3);
    prompt.handleMessage({
      command: 'desktop:promptResult',
      requestId: String(messages[2]?.requestId),
      value: 'available',
    });
    await expect(recovered).resolves.toBe('available');
  });

  it('cancels immediately when the renderer is unavailable', async () => {
    const { createDesktopPromptIpc } = await loadPromptIpc();
    const prompt = createDesktopPromptIpc({ postToRenderer: () => false });
    await expect(
      prompt.input({ prompt: 'Unavailable' }),
    ).resolves.toBeUndefined();
  });
});
