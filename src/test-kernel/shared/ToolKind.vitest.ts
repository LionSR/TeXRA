// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared tools
import { toolDisplayKind } from '@shared/tools/toolKind';

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

  it('maps the native text-editor alias', () => {
    expect(toolDisplayKind('str_replace_based_edit_tool')).toBe('edit');
  });

  it.each(['unknown_tool', 'toString', '__proto__'])(
    'returns undefined for unrecognized name %s',
    (toolName) => {
      expect(toolDisplayKind(toolName)).toBeUndefined();
    },
  );
});
