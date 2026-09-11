// Node imports
import { EventEmitter } from 'node:events';

// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - packaged desktop smoke boundaries
import { buildDesktopSmokeEnvironment } from '../../../scripts/desktop-package-smoke-environment.mjs';
import {
  stopChild,
  waitForExit,
  waitForTermination,
} from '../../../scripts/smoke-process-utils.mjs';

describe('packaged desktop smoke environment', () => {
  it('passes only required system variables and isolated TeXRA paths', () => {
    const environment = buildDesktopSmokeEnvironment(
      {
        DISPLAY: ':99',
        LC_ALL: 'C.UTF-8',
        PATH: '/usr/bin',
        DESKTOP_FUTURE_LINUX_GPG_SIGNING_KEY: 'private key',
        GITHUB_TOKEN: 'token',
        UNRELATED_PARENT_VALUE: 'not required',
      },
      {
        profile: '/isolation/profile',
        userData: '/isolation/user-data',
      },
    );

    expect(environment).toMatchObject({
      DISPLAY: ':99',
      LC_ALL: 'C.UTF-8',
      PATH: '/usr/bin',
      HOME: '/isolation/profile',
      TEXRA_DESKTOP_E2E_USER_DATA_PATH: '/isolation/user-data',
    });
    expect(environment).not.toHaveProperty(
      'DESKTOP_FUTURE_LINUX_GPG_SIGNING_KEY',
    );
    expect(environment).not.toHaveProperty('GITHUB_TOKEN');
    expect(environment).not.toHaveProperty('UNRELATED_PARENT_VALUE');
  });
});
