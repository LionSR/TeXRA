// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { testRuntime } from '@test/support/testProcessRuntime';

describe('DesktopPromptController', () => {
  it.effect('settles cancellation once and ignores duplicate results', () =>
    Effect.gen(function* () {
      let requestId = '';
      const { DesktopPromptController } = yield* Effect.promise(
        () => import('@desktop/main/desktopPromptController'),
      );
      const controller = new DesktopPromptController({
        postToRenderer: (message) => {
          requestId = (message as { requestId: string }).requestId;
          return true;
        },
      });
      const resolution = vi.fn();
      const fiber = yield* Effect.forkChild(
        controller.request({ title: 'Name', prompt: 'Team name' }),
        { startImmediately: true },
      );
      fiber.addObserver((exit) => {
        if (Exit.isSuccess(exit)) resolution(exit.value);
      });

      // The renderer's settlement, run the way the window's router does.
      const settle = withProcessServices(
        testRuntime(),
        controller.routes['desktop:settlePrompt']!({
          command: 'desktop:settlePrompt',
          requestId,
          value: null,
        }),
      );
      yield* settle;
      // A duplicate settles nothing.
      yield* settle;
      // The asking fiber resumes on the Effect scheduler, not on a microtask.
      yield* Effect.promise(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      );

      expect(resolution).toHaveBeenCalledOnce();
      expect(resolution).toHaveBeenCalledWith(undefined);
    }),
  );
});
