// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';

type DesktopPromptControllerModule =
  typeof import('@desktop/main/desktopPromptController');
type DesktopPromptController = InstanceType<
  DesktopPromptControllerModule['DesktopPromptController']
>;

async function createPromptController(
  postToRenderer: (message: unknown) => boolean,
): Promise<DesktopPromptController> {
  const { DesktopPromptController: Controller } = await loadSourceModule(
    '@desktop/main/desktopPromptController',
  );
  return new Controller({ postToRenderer });
}

describe('DesktopPromptController', () => {
  it('correlates text and password prompt results', async () => {
    const messages: Record<string, unknown>[] = [];
    const controller = await createPromptController((message) => {
      messages.push(message as Record<string, unknown>);
      return true;
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
    let requestId = '';
    const controller = await createPromptController((message) => {
      requestId = (message as { requestId: string }).requestId;
      return true;
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
    expect(controller.handleMessage(cancellation)).toBe(false);
    await Promise.resolve();

    expect(resolution).toHaveBeenCalledOnce();
    expect(resolution).toHaveBeenCalledWith(undefined);
  });

  it('cancels requests when delivery fails or the controller disposes', async () => {
    const undelivered = await createPromptController(() => false);
    await expect(
      undelivered.request({ title: 'Name', prompt: 'Team name' }),
    ).resolves.toBeUndefined();

    const delivered = await createPromptController(() => true);
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
