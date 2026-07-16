import { describe, expect, it } from 'vitest';

import { bashCwdDisplayLine } from '@cli/chat/tui/modals/BashApproval';

describe('CLI bash approval layout', () => {
  it('includes the working directory when one is available', () => {
    const line = bashCwdDisplayLine({
      cwd: '/tmp/texra-project',
      width: 76,
    });

    expect(line).toBe('Directory: /tmp/texra-project');
  });

  it('omits the directory row when the payload has no cwd', () => {
    expect(bashCwdDisplayLine({ cwd: '   ', width: 76 })).toBeUndefined();
    expect(bashCwdDisplayLine({ width: 76 })).toBeUndefined();
  });
});
