import { describe, expect, it } from 'vitest';

import { formatToolDescriptionForTui } from '@cli/chat/tui/forms/ToolsListForm';
import {
  cliToolIds,
  findCliToolDef,
  formatCliBoolean,
  formatCliToolList,
  formatCliToolMissingInstallCommandMessage,
  formatCliToolNotFoundMessage,
  formatCliToolNotToggleableMessage,
  formatCliToolStatus,
  readCliToolGuide,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';

function record(
  overrides: Partial<CliToolStatusRecord> = {},
): CliToolStatusRecord {
  return {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    category: 'ai-agents',
    enabled: true,
    detected: false,
    status: 'not-found',
    toggleable: true,
    comingSoon: false,
    note: 'npm install -g @openai/codex',
    installCommand: 'npm install -g @openai/codex',
    authCommand: 'codex login',
    ...overrides,
  };
}

describe('CLI tools runtime', () => {
  it('exposes external tool definition ids', () => {
    expect(cliToolIds()).toEqual(
      expect.arrayContaining(['codex', 'claude-agent']),
    );
    // External inquiry is a VS Code / desktop feature; the CLI hides it.
    expect(cliToolIds()).not.toContain('external-inquiry');
    expect(findCliToolDef('external-inquiry')).toBeUndefined();
    expect(cliToolIds()).not.toContain('texra-cli');
    expect(findCliToolDef('texra-cli')).toBeUndefined();
  });

  it('formats nullable booleans consistently', () => {
    expect(formatCliBoolean(true)).toBe('yes');
    expect(formatCliBoolean(false)).toBe('no');
    expect(formatCliBoolean(null)).toBe('-');
  });

  it('formats tool list rows for text output', () => {
    expect(formatCliToolList([record()])).toContain(
      'codex\tOpenAI Codex CLI\tai-agents\tyes\tno\tnpm install -g @openai/codex',
    );
  });

  it('formats detailed tool status for text output', () => {
    expect(
      formatCliToolStatus(record({ statusDetail: 'Codex not found.' })),
    ).toContain('authCommand: codex login\n\nCodex not found.');
  });

  it('formats tool command errors from the runtime owner', () => {
    expect(formatCliToolNotFoundMessage('missing')).toBe(
      'Tool integration not found: missing',
    );
    expect(formatCliToolNotToggleableMessage('lean4')).toBe(
      'Tool integration is not toggleable: lean4',
    );
    expect(formatCliToolMissingInstallCommandMessage('external-inquiry')).toBe(
      'No install command is registered for external-inquiry.',
    );
  });

  it('reads install and auth guides from external tool definitions', () => {
    const installGuide = readCliToolGuide('codex', 'install');
    expect(installGuide?.text).toContain(
      'Command: npm install -g @openai/codex',
    );
    expect(installGuide?.command).toBe('npm install -g @openai/codex');

    const authGuide = readCliToolGuide('codex', 'auth');
    expect(authGuide?.text).toContain('Command: codex login');
    expect(authGuide?.command).toBe('codex login');

    expect(readCliToolGuide('texra-cli', 'install')).toBeUndefined();
  });

  it('formats interactive tool descriptions with human state labels', () => {
    expect(
      formatToolDescriptionForTui(
        record({
          enabled: null,
          detected: true,
          toggleable: false,
          status: 'available',
        }),
      ),
    ).toBe('always on · detected · Ready');

    expect(
      formatToolDescriptionForTui(
        record({
          enabled: true,
          detected: false,
          status: 'not-found',
        }),
      ),
    ).toBe('enabled · not detected · Needs setup');

    expect(
      formatToolDescriptionForTui(
        record({
          enabled: true,
          detected: null,
          status: 'unknown',
        }),
      ),
    ).toBe('enabled · detection unknown · Not checked');

    expect(
      formatToolDescriptionForTui(
        record({
          enabled: null,
          detected: true,
          toggleable: false,
          comingSoon: true,
          status: 'coming-soon',
        }),
      ),
    ).toBe('coming soon · detected · not yet usable');
  });
});
