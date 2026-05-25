import { describe, expect, it } from 'vitest';

import {
  cliToolIds,
  formatCliToolList,
  formatCliToolStatus,
  type CliToolStatusRecord,
} from '../../../packages/cli/src/runtime/tools';

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
});
