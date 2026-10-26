// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
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
});
