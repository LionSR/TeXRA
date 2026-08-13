import { describe, expect, it } from 'vitest';

import {
  displayToolName,
  isMcpToolName,
  normalizeToolName,
} from '@shared/tools/toolDisplayName';

describe('normalizeToolName', () => {
  it.each([
    ['bash', 'bash'],
    ['claude:Edit', 'edit'],
    ['claude:Bash', 'bash'],
    ['mcp:terminal/bash', 'bash'],
    ['CustomTool', 'customtool'],
  ] as const)('normalizes %s to %s', (toolName, expected) => {
    expect(normalizeToolName(toolName)).toBe(expected);
  });
});

describe('displayToolName', () => {
  it('strips provider namespaces but keeps the tool name as written', () => {
    expect(displayToolName('claude:Edit')).toBe('Edit');
    expect(displayToolName('CustomTool')).toBe('CustomTool');
  });

  it('applies friendly labels after stripping the namespace', () => {
    expect(displayToolName('delegate_multi_agents')).toBe(
      'Multi-agent workflow',
    );
    expect(displayToolName('codex:codex_turn')).toBe('Codex Turn');
  });

  it('keeps the MCP provenance marker for the emitted mcp:server/tool shape', () => {
    expect(displayToolName('mcp:github/search')).toBe('MCP github/search');
  });

  it('falls back to a generic label for an empty name', () => {
    expect(displayToolName('')).toBe('tool');
  });
});

describe('isMcpToolName', () => {
  it('matches only the mcp: prefix', () => {
    expect(isMcpToolName('mcp:github/search')).toBe(true);
    expect(isMcpToolName('claude:Edit')).toBe(false);
    expect(isMcpToolName('bash')).toBe(false);
  });
});
