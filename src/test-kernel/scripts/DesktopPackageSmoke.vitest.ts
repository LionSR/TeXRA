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

describe('packaged desktop smoke process observation', () => {
  function fakeChild() {
    return Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    });
  }

  it('observes an exit that races with listener registration', async () => {
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      off: vi.fn(),
      once(event: string): void {
        if (event === 'exit') this.exitCode = 0;
      },
    };

    await expect(waitForTermination(child)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    expect(child.off).toHaveBeenCalledOnce();
  });

  it('reports a process error to callers that require launch success', async () => {
    const child = fakeChild();
    const exit = waitForExit(child);

    child.emit('error', new Error('spawn failed'));

    await expect(exit).rejects.toThrow('spawn failed');
  });

  it('does not mistake a process error for an exit during forced teardown', async () => {
    const child = Object.assign(fakeChild(), { kill: vi.fn() });
    child.on('error', () => {});
    child.kill.mockImplementation((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => child.emit('error', new Error('kill failed')));
      } else {
        queueMicrotask(() => {
          child.signalCode = 'SIGKILL';
          child.emit('exit', null, 'SIGKILL');
        });
      }
      return true;
    });

    const exit = await stopChild(child, waitForTermination(child), {
      graceMs: 5,
      label: 'test child',
    });

    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      'SIGTERM',
      'SIGKILL',
    ]);
    expect(exit).toEqual({ code: null, signal: 'SIGKILL' });
  });
});
