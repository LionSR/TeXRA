import { describe, expect, it } from 'vitest';

import { isEditLikeToolName, toolDisplayKind } from '@shared/tools/toolKind';

describe('toolDisplayKind', () => {
  it.each([
    ['edit_file', 'edit'],
    ['str_replace_editor', 'edit'],
    ['read_file', 'read'],
    ['write_file', 'write'],
    ['bash', 'bash'],
  ] as const)('maps canonical tool %s to %s', (toolName, expectedKind) => {
    expect(toolDisplayKind(toolName)).toBe(expectedKind);
  });

  it.each([
    ['claude:Bash', 'bash'],
    ['mcp:terminal/bash', 'bash'],
    ['claude:Read_File', 'read'],
  ] as const)('normalizes %s before the lookup', (toolName, expectedKind) => {
    expect(toolDisplayKind(toolName)).toBe(expectedKind);
  });

  it.each(['unknown_tool', 'toString', '__proto__'])(
    'returns undefined for unrecognized name %s',
    (toolName) => {
      expect(toolDisplayKind(toolName)).toBeUndefined();
    },
  );
});

describe('isEditLikeToolName', () => {
  it.each(['edit_file', 'str_replace_editor'])(
    'classifies registered edit tool %s',
    (toolName) => {
      expect(isEditLikeToolName(toolName)).toBe(true);
    },
  );

  it.each([
    'edit',
    'multiedit',
    'claude:Edit',
    'my_str_replace_tool',
    'mcp:server/text_editor',
  ])('classifies delegated/provider variant %s', (toolName) => {
    expect(isEditLikeToolName(toolName)).toBe(true);
  });

  it.each(['read_file', 'write_file', 'bash', 'unknown_tool'])(
    'does not classify %s as edit-like',
    (toolName) => {
      expect(isEditLikeToolName(toolName)).toBe(false);
    },
  );
});
