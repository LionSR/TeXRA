import { describe, expect, it } from 'vitest';

import { isAllowedLatexInstallCommand } from '@texra/controllers/settingsView/LatexToolingController';
import { HOMEBREW_INSTALL_COMMAND } from '@texra/shared/constants/latexToolchain';

describe('LatexToolingController', () => {
  it('allowlists structured install commands only', () => {
    expect(isAllowedLatexInstallCommand(HOMEBREW_INSTALL_COMMAND)).toBe(true);
    expect(isAllowedLatexInstallCommand('rm -rf ~/.texra')).toBe(false);
  });
});
