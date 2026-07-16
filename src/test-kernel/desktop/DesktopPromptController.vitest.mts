// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopPromptController {
  request(input: {
    title: string;
    prompt: string;
    password?: boolean;
  }): Promise<string | undefined>;
  handleMessage(
    message: { command: string } & Record<string, unknown>,
  ): boolean;
  dispose(): void;
}

interface DesktopPromptControllerModule {
  DesktopPromptController: new (renderer: {
    postToRenderer(message: unknown): boolean;
  }) => DesktopPromptController;
}

async function loadDesktopPromptController(): Promise<DesktopPromptControllerModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopPromptController.ts'))
  ) as Promise<DesktopPromptControllerModule>;
}

describe('DesktopPromptController', () => {
  it('correlates text and password prompt results', async () => {
    const { DesktopPromptController } = await loadDesktopPromptController();
    const messages: Record<string, unknown>[] = [];
    const controller = new DesktopPromptController({
      postToRenderer: (message) => {
        messages.push(message as Record<string, unknown>);
        return true;
      },
    });

    const result = controller.request({
      title: 'Set API key',
      prompt: 'Enter API key',
      password: true,
    });
    const request = messages[0];

    expect(request).toMatchObject({
      command: 'desktop:showPrompt',
      title: 'Set API key',
      prompt: 'Enter API key',
      password: true,
    });
    expect(
      controller.handleMessage({
        command: 'desktop:settlePrompt',
        requestId: request.requestId,
        value: 'secret',
      }),
    ).toBe(true);
    await expect(result).resolves.toBe('secret');
  });

  it('settles cancellation once and ignores duplicate results', async () => {
    const { DesktopPromptController } = await loadDesktopPromptController();
    let requestId = '';
    const controller = new DesktopPromptController({
      postToRenderer: (message) => {
        requestId = (message as { requestId: string }).requestId;
        return true;
      },
    });
    const resolution = vi.fn();
    void controller
      .request({ title: 'Name', prompt: 'Team name' })
      .then(resolution);

    const cancellation = {
      command: 'desktop:settlePrompt',
      requestId,
      value: null,
    };
    expect(controller.handleMessage(cancellation)).toBe(true);
    expect(controller.handleMessage(cancellation)).toBe(true);
    await Promise.resolve();

    expect(resolution).toHaveBeenCalledOnce();
    expect(resolution).toHaveBeenCalledWith(undefined);
  });

  it('cancels requests when delivery fails or the controller disposes', async () => {
    const { DesktopPromptController } = await loadDesktopPromptController();
    const undelivered = new DesktopPromptController({
      postToRenderer: () => false,
    });
    await expect(
      undelivered.request({ title: 'Name', prompt: 'Team name' }),
    ).resolves.toBeUndefined();

    const delivered = new DesktopPromptController({
      postToRenderer: () => true,
    });
    const first = delivered.request({ title: 'First', prompt: 'First value' });
    const second = delivered.request({
      title: 'Second',
      prompt: 'Second value',
    });
    delivered.dispose();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });
});
