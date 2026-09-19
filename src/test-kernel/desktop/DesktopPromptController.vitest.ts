// Third-party imports
import { Effect, Fiber } from 'effect';
import { describe, expect, it, vi } from 'vitest';

type DesktopPromptControllerModule =
  typeof import('@desktop/main/desktopPromptController');
type DesktopPromptController = InstanceType<
  DesktopPromptControllerModule['DesktopPromptController']
>;

async function createPromptController(
  postToRenderer: (message: unknown) => boolean,
): Promise<DesktopPromptController> {
  const { DesktopPromptController: Controller } =
    await import('@desktop/main/desktopPromptController');
  return new Controller({ postToRenderer });
}

describe('DesktopPromptController', () => {
  it('correlates text and password prompt results', async () => {
    const messages: Record<string, unknown>[] = [];
    const controller = await createPromptController((message) => {
      messages.push(message as Record<string, unknown>);
      return true;
    });

    const result = Effect.runPromise(
      controller.request({
        title: 'Set API key',
        prompt: 'Enter API key',
        password: true,
      }),
    );
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
    void Effect.runPromise(
      controller.request({ title: 'Name', prompt: 'Team name' }),
    ).then(resolution);

    const cancellation = {
      command: 'desktop:settlePrompt',
      requestId,
      value: null,
    };
    expect(controller.handleMessage(cancellation)).toBe(true);
    expect(controller.handleMessage(cancellation)).toBe(false);
    // The asking fiber resumes on the Effect scheduler, not on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolution).toHaveBeenCalledOnce();
    expect(resolution).toHaveBeenCalledWith(undefined);
  });

  it('cancels requests when delivery fails or the controller disposes', async () => {
    const undelivered = await createPromptController(() => false);
    await expect(
      Effect.runPromise(
        undelivered.request({ title: 'Name', prompt: 'Team name' }),
      ),
    ).resolves.toBeUndefined();

    const delivered = await createPromptController(() => true);
    const first = Effect.runPromise(
      delivered.request({ title: 'First', prompt: 'First value' }),
    );
    const second = Effect.runPromise(
      delivered.request({ title: 'Second', prompt: 'Second value' }),
    );
    delivered.dispose();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
  });

  it('forgets a request whose asking fiber is interrupted', async () => {
    let requestId = '';
    const controller = await createPromptController((message) => {
      requestId = (message as { requestId: string }).requestId;
      return true;
    });

    const fiber = Effect.runFork(
      controller.request({ title: 'Name', prompt: 'Team name' }),
    );
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(
      controller.handleMessage({
        command: 'desktop:settlePrompt',
        requestId,
        value: 'late',
      }),
    ).toBe(false);
  });
});
