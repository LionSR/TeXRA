// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

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
  it.effect('correlates text and password prompt results', () =>
    Effect.gen(function* () {
      const messages: Record<string, unknown>[] = [];
      const controller = yield* Effect.promise(() =>
        createPromptController((message) => {
          messages.push(message as Record<string, unknown>);
          return true;
        }),
      );

      const fiber = yield* Effect.forkChild(
        controller.request({
          title: 'Set API key',
          prompt: 'Enter API key',
          password: true,
        }),
        { startImmediately: true },
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
      expect(yield* Fiber.join(fiber)).toBe('secret');
    }),
  );

  it.effect('settles cancellation once and ignores duplicate results', () =>
    Effect.gen(function* () {
      let requestId = '';
      const controller = yield* Effect.promise(() =>
        createPromptController((message) => {
          requestId = (message as { requestId: string }).requestId;
          return true;
        }),
      );
      const resolution = vi.fn();
      const fiber = yield* Effect.forkChild(
        controller.request({ title: 'Name', prompt: 'Team name' }),
        { startImmediately: true },
      );
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) resolution(exit.value);
      });

      const cancellation = {
        command: 'desktop:settlePrompt',
        requestId,
        value: null,
      };
      expect(controller.handleMessage(cancellation)).toBe(true);
      expect(controller.handleMessage(cancellation)).toBe(false);
      // The asking fiber resumes on the Effect scheduler, not on a microtask.
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      );

      expect(resolution).toHaveBeenCalledOnce();
      expect(resolution).toHaveBeenCalledWith(undefined);
    }),
  );

  it.effect(
    'cancels requests when delivery fails or the controller disposes',
    () =>
      Effect.gen(function* () {
        const undelivered = yield* Effect.promise(() =>
          createPromptController(() => false),
        );
        expect(
          yield* undelivered.request({ title: 'Name', prompt: 'Team name' }),
        ).toBeUndefined();

        const delivered = yield* Effect.promise(() =>
          createPromptController(() => true),
        );
        const first = yield* Effect.forkChild(
          delivered.request({ title: 'First', prompt: 'First value' }),
          { startImmediately: true },
        );
        const second = yield* Effect.forkChild(
          delivered.request({ title: 'Second', prompt: 'Second value' }),
          { startImmediately: true },
        );
        delivered.dispose();

        expect(yield* Fiber.join(first)).toBeUndefined();
        expect(yield* Fiber.join(second)).toBeUndefined();
      }),
  );

  it.effect('forgets a request whose asking fiber is interrupted', () =>
    Effect.gen(function* () {
      let requestId = '';
      const controller = yield* Effect.promise(() =>
        createPromptController((message) => {
          requestId = (message as { requestId: string }).requestId;
          return true;
        }),
      );

      const fiber = yield* Effect.forkChild(
        controller.request({ title: 'Name', prompt: 'Team name' }),
        { startImmediately: true },
      );
      yield* Fiber.interrupt(fiber);

      expect(
        controller.handleMessage({
          command: 'desktop:settlePrompt',
          requestId,
          value: 'late',
        }),
      ).toBe(false);
    }),
  );
});
