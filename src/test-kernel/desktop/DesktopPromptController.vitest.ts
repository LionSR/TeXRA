// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { testRuntime } from '@test/support/testProcessRuntime';

type DesktopPromptControllerModule =
  typeof import('@desktop/main/desktopPromptController');
type DesktopPromptController = InstanceType<
  DesktopPromptControllerModule['DesktopPromptController']
>;

/** The renderer's settlement of a prompt, run the way the window's router does. */
function settlement(
  controller: DesktopPromptController,
  message: { command: string; requestId: string; value: string | null },
) {
  const route = controller.routes['desktop:settlePrompt'];
  if (!route) throw new Error('the prompt controller routes no settlement');
  return withProcessServices(testRuntime(), route(message));
}

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
      yield* settlement(controller, {
        command: 'desktop:settlePrompt',
        requestId: String(request.requestId),
        value: 'secret',
      });
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
      yield* settlement(controller, cancellation);
      // A duplicate settles nothing.
      yield* settlement(controller, cancellation);
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

      // A late answer to an abandoned prompt settles nothing.
      yield* settlement(controller, {
        command: 'desktop:settlePrompt',
        requestId,
        value: 'late',
      });
    }),
  );
});
