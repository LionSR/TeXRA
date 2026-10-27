import { it as effectIt } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ImagePasteQueue } from '@cli/chat/tui/input/imagePasteQueue';
import {
  shouldRedactSlashInput,
  installSlashCommands,
} from '@cli/chat/tui/commands/slashRegistry';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { bindTestSessionView } from './fixtures/sessionViewFixture';

const clipboardMock = vi.hoisted(() => ({
  attachClipboardImage: vi.fn(),
}));

vi.mock('@cli/runtime/clipboardImage', () => clipboardMock);

describe('InputBar slash submit', () => {
  beforeAll(bindTestSessionView);

  it('does not persist commands whose input may contain a credential', () => {
    installSlashCommands([
      {
        pluginId: 'test',
        commands: [
          {
            name: 'key',
            aliases: ['keys'],
            description: 'Add an API key',
            redactInput: true,
          },
          {
            name: 'model',
            description: 'Choose a model',
          },
        ],
      },
    ]);

    try {
      const cases: ReadonlyArray<readonly [string, boolean]> = [
        ['/key private-value', false],
        ['/keys private-value', false],
        ['/key=private-value', false],
        ['/key:private-value', false],
        ['/key/private-value', false],
        ['/keysk-private-value', false],
        ['/keyArbitraryCredentialValue', false],
        ['/ky private-value', false],
        ['/kye:sk-private-value', false],
        ['/apikey private-value', false],
        ['/unknown', true],
        ['/unknown private-value', false],
        ['/unknown=value', true],
        ['/tmp=backup', true],
        ['/keyboard shortcuts', false],
        ['/keynote.tex', true],
        ['/model openai', true],
        ['ordinary message', true],
      ];
      for (const [input, expected] of cases) {
        expect(!shouldRedactSlashInput(input)).toBe(expected);
      }
    } finally {
      installSlashCommands([]);
    }
  });

  effectIt.live(
    'waits for pending image pastes and submits the latest draft',
    () =>
      Effect.gen(function* () {
        const chipSuffix = ' [Image #1]';
        const imagePasteQueue = new ImagePasteQueue();
        const paste = createDeferred();
        const submitted: string[] = [];
        let draft = '/h';

        const pasteFiber = yield* Effect.forkChild(
          Effect.promise(() => paste.promise).pipe(
            Effect.map(() => {
              draft = `/h${chipSuffix}`;
            }),
          ),
        );
        imagePasteQueue.add(pasteFiber, testRuntime());

        imagePasteQueue.runWhenIdle(() => {
          submitted.push(draft);
        });

        expect(submitted).toEqual([]);

        paste.resolve();
        yield* Fiber.await(pasteFiber);

        expect(submitted).toEqual([`/h${chipSuffix}`]);
      }),
  );
});
