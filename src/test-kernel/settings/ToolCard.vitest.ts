import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { ToolCard } from '@settingsView/frontend/components/tools/ToolCard';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  dispatchSettingsViewOutbound,
  type ToolDashboardItem,
} from '@shared/schemas';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

useLitComponentTestDom(
  () => import('@settingsView/frontend/components/tools/ToolCard'),
);

const ITEM: ToolDashboardItem = {
  id: 'codex',
  name: 'OpenAI Codex CLI',
  category: 'ai-agents',
  description: 'Codex tools',
  tools: [],
  status: 'not-found',
  requiresSetup: true,
  installActions: [
    { kind: 'guide', text: 'Install Codex, then sign in.' },
    { kind: 'command', command: 'npm install -g @openai/codex' },
    { kind: 'auth', command: 'codex login' },
    { kind: 'extension', extensionId: 'openai.chatgpt' },
    { kind: 'url', url: 'https://github.com/openai/codex' },
  ],
};

function dashboardMessage(installActions: unknown) {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD,
    items: [{ ...ITEM, installActions }],
  };
}

describe('tool-card install actions', () => {
  beforeEach(() => mocks.postMessage.mockClear());

  it('rejects malformed or legacy action combinations at the wire boundary', () => {
    const handler = vi.fn();
    const handlers = {
      [SETTINGS_VIEW_COMMANDS.UPDATE_TOOL_DASHBOARD]: handler,
    } as never;

    expect(
      dispatchSettingsViewOutbound(
        dashboardMessage(ITEM.installActions),
        handlers,
      ),
    ).toBe(true);
    expect(handler).toHaveBeenCalledOnce();

    for (const invalid of [
      [{ kind: 'guide', text: '' }],
      [{ kind: 'url', url: '' }],
      [{ kind: 'url', url: 'not a URL' }],
      [{ kind: 'url', url: 'https://example.com', extensionId: 'extra' }],
      [{ kind: 'extension', extensionId: '' }],
      [{ kind: 'command' }],
      [{ kind: 'command', command: '' }],
      [{ kind: 'auth', command: '' }],
      [{ kind: 'unknown', command: 'echo invalid' }],
    ]) {
      expect(
        dispatchSettingsViewOutbound(dashboardMessage(invalid), handlers),
      ).toBe(false);
    }

    expect(
      dispatchSettingsViewOutbound(
        {
          ...dashboardMessage([]),
          items: [
            { ...ITEM, installActions: [], installUrl: 'https://legacy' },
          ],
        },
        handlers,
      ),
    ).toBe(false);
  });

  it('renders every valid variant and routes each interactive action', async () => {
    const element = await mountComponent<ToolCard>('tool-card', { item: ITEM });
    const root = element.shadowRoot!;

    expect(root.textContent).toContain('Install Codex, then sign in.');
    const buttons = [...root.querySelectorAll('wa-button')];
    expect(
      buttons.map((button) =>
        button.textContent?.replaceAll(/\s+/g, ' ').trim(),
      ),
    ).toEqual([
      'Install in terminal',
      'Sign in',
      'Install extension',
      'Open install page',
    ]);

    for (const button of buttons) button.click();

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
        { toolId: 'codex', kind: 'install' },
      ],
      [
        SETTINGS_VIEW_COMMANDS.RUN_TOOL_COMMAND,
        { toolId: 'codex', kind: 'auth' },
      ],
      [
        SETTINGS_VIEW_COMMANDS.INSTALL_TOOL_EXTENSION,
        { extensionId: 'openai.chatgpt' },
      ],
      [
        SETTINGS_VIEW_COMMANDS.OPEN_TOOL_INSTALL_URL,
        { url: 'https://github.com/openai/codex' },
      ],
    ]);
  });
});
