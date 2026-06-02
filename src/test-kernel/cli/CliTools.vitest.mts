import { describe, expect, it } from 'vitest';

import { formatToolDescriptionForTui } from '@cli/chat/tui/forms/ToolsListForm';
import {
  cliToolIds,
  findCliToolDef,
  formatCliBoolean,
  formatCliToolList,
  formatCliToolStatus,
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
      expect.arrayContaining(['codex', 'claude-agent', 'external-inquiry']),
    );
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
    ).toBe('always on · detected · available');

    expect(
      formatToolDescriptionForTui(
        record({
          enabled: true,
          detected: false,
          status: 'not-found',
          statusLabel: 'Needs setup',
        }),
      ),
    ).toBe('enabled · not detected · Needs setup');

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
