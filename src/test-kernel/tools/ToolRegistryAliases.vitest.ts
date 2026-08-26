import { describe, expect, it } from 'vitest';

import { getDefaultUnavailableToolNames } from '@tools/registry';

describe('tool registry host exclusions', () => {
  it('derives product-host exclusions from each registered tool', () => {
    expect(getDefaultUnavailableToolNames('cli')).toEqual([
      'diagnostics',
      'inline_comment',
      'inquiry',
      'invoke_command',
      'install_vscode_extension',
      'send_to_terminal',
    ]);
    expect(getDefaultUnavailableToolNames('desktop')).toEqual([
      'diagnostics',
      'inline_comment',
      'invoke_command',
      'install_vscode_extension',
      'send_to_terminal',
    ]);
    expect(getDefaultUnavailableToolNames('extension')).toEqual([]);
  });
});
