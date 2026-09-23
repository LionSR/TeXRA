// Suites for loose src/shared/schemas helpers (work plan, agent CLI
// settings, main-view housekeeping messages, settings-view tab invariants).

import { describe, expect, it } from 'vitest';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  planSummaryLine,
  parseClaudeAgentModel,
  parseCodexApprovalPolicy,
} from '@shared/schemas';
import {
  dispatchSettingsViewOutbound,
  SETTINGS_TAB_GROUPS,
  SETTINGS_TAB_ORDER,
} from '@shared/settingsView/settingsViewMessages';

describe('parseCodexApprovalPolicy', () => {
  it('defaults to automatic approval for invalid persisted values', () => {
    expect(parseCodexApprovalPolicy('ask')).toBe('never');
  });
});

describe('parseClaudeAgentModel', () => {
  it('defaults invalid persisted selections to Sonnet', () => {
    expect(parseClaudeAgentModel('claude-opus-3')).toBe('claude-sonnet-5');
  });

  it('defaults a retired persisted id to Sonnet rather than mapping it', () => {
    expect(parseClaudeAgentModel('claude-fable-5')).toBe('claude-sonnet-5');
  });
});

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

describe('settings view tab definitions', () => {
  // Panel names cross the IPC boundary as `SET_TAB.tab`, so the set is pinned
  // literally. A retired internal panel must disappear from this contract
  // together with every producer and handler.

  // A group that silently omits a tab makes that panel unreachable from the
  // nav while it stays a valid IPC target; a tab listed twice renders two rows
  // for one panel.
  it('places every tab in exactly one nav group', () => {
    const grouped = SETTINGS_TAB_GROUPS.flatMap((group) => group.tabs);

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...SETTINGS_TAB_ORDER].sort());
  });
});
