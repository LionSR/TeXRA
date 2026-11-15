import { layer } from '@effect/vitest';
import { Layer } from 'effect';
import { expect, it as test } from 'vitest';

import { textInputCappedRowCount } from '@cli/chat/tui/input/textInputDisplay';
import {
  deleteBeforeCursor,
  insertText,
  previousGraphemeCursor,
} from '@cli/chat/tui/input/textInputEditing';
import { applyTerminalInputChunk } from '@cli/chat/tui/input/textInputBindings';
import { slashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { SessionGraph } from '@test/support/testKernel';
import { boundTestSessionView } from '@test/cli/fixtures/sessionViewFixture';

layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('InputBar slash submit', (it) => {
  it('does not persist commands whose input may contain a credential', () => {
    const commands = slashCommands([
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
      expect(!commands.shouldRedact(input)).toBe(expected);
    }
  });
});

test('the input edits and measures an emoji sequence as one character', () => {
  const family = '👨‍👩‍👧';
  const draft = `a${family}`;
  expect(deleteBeforeCursor(draft, draft.length)).toEqual({
    value: 'a',
    cursor: 1,
  });
  expect(previousGraphemeCursor(draft, draft.length)).toBe(1);
  // A regional indicator typed before a flag joins it; the caret follows
  // to the end of the joined character.
  expect(insertText('🇺🇸', 0, '🇨')).toEqual({ value: '🇨🇺🇸', cursor: 4 });
  // A sequence arriving in one chunk goes in whole, before what follows.
  expect(applyTerminalInputChunk('👩', 0, '👨‍👧').value).toBe('👨‍👧👩');
  // Two columns wide, so two of them fill a four-column row; the caret
  // takes the second row.
  expect(textInputCappedRowCount(family + family, 4, 8)).toBe(2);
});
