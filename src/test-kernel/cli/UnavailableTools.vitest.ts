// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { CLI_UNAVAILABLE_TOOLS } from '@cli/runtime/unavailableTools';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

describe('CLI unavailable tools', () => {
  it('excludes only VS Code-specific setup tools', () => {
    expect(CLI_UNAVAILABLE_TOOLS).toEqual([
      'inquiry',
      ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
      'inline_comment',
      'diagnostics.add',
    ]);
  });
});
