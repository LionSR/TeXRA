import { layer } from '@effect/vitest';
import { Layer } from 'effect';
import { expect } from 'vitest';

import {
  shouldRedactSlashInput,
  installSlashCommands,
} from '@cli/chat/tui/commands/slashRegistry';
import { SessionGraph } from '@test/support/testKernel';
import { boundTestSessionView } from './fixtures/sessionViewFixture';

layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('InputBar slash submit', (it) => {
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
});
