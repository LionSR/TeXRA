// Suites for loose src/shared/schemas helpers (work plan, main-view
// housekeeping messages, settings-view messages).

import { describe, expect, it } from 'vitest';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchSettingsViewOutbound } from '@shared/settingsView/settingsViewMessages';

describe('settings view tool install actions', () => {
  it.each([
    ['empty guide', [{ kind: 'guide', text: '' }]],
    ['empty URL', [{ kind: 'url', url: '' }]],
    ['invalid URL', [{ kind: 'url', url: 'not a URL' }]],
    [
      'mixed URL and extension fields',
      [{ kind: 'url', url: 'https://example.com', extensionId: 'extra' }],
    ],
    ['empty extension ID', [{ kind: 'extension', extensionId: '' }]],
    ['missing command', [{ kind: 'command' }]],
    ['empty command', [{ kind: 'command', command: '' }]],
    ['empty auth command', [{ kind: 'auth', command: '' }]],
    ['unknown action kind', [{ kind: 'unknown', command: 'echo invalid' }]],
  ])('rejects %s', (_case, installActions) => {
    expect(
      dispatchSettingsViewOutbound(
        {
          command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
          items: [
            {
              id: 'tool',
              name: 'Tool',
              category: 'system',
              description: 'Tool description',
              tools: [],
              status: 'not-found',
              requiresSetup: true,
              installActions,
            },
          ],
        },
        { [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: () => {} } as never,
      ),
    ).toBe(false);
  });
});
