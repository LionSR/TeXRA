import { describe, expect, it, vi } from 'vitest';

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

// The guide assertions below read live tool definitions, which offer a
// package-manager command when the host has that manager. Today the probe
// cannot succeed under vitest anyway — setupFakePlatform points every command
// at a workspace directory that does not exist, so execaSync fails before PATH
// is consulted — but that is an accident of an unrelated stub, not something
// these assertions should depend on. Pin the fallback explicitly.
vi.mock('@utils/system/toolUtils', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@utils/system/toolUtils')>();
  return { ...actual, hasPackageManager: () => false };
});

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

  it.each<{
    overrides: Partial<CliToolStatusRecord>;
    expected: string;
  }>([
    {
      overrides: {
        enabled: null,
        detected: true,
        toggleable: false,
        status: 'available',
      },
      expected: 'always on · detected · Ready',
    },
    {
      overrides: { enabled: true, detected: false, status: 'not-found' },
      expected: 'enabled · not detected · Needs setup',
    },
    {
      overrides: { enabled: true, detected: null, status: 'unknown' },
      expected: 'enabled · Not checked',
    },
    {
      overrides: {
        enabled: null,
        detected: true,
        toggleable: false,
        comingSoon: true,
        status: 'coming-soon',
      },
      expected: 'coming soon',
    },
  ])(
    'formats interactive tool description as $expected',
    ({ overrides, expected }) => {
      expect(formatToolDescriptionForTui(record(overrides))).toBe(expected);
    },
  );
});
