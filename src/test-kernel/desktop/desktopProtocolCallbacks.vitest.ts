import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import {
  installDesktopProtocolCallbackLifecycle,
  type DesktopProtocolApp,
} from '@desktop/main/desktopProtocolCallbacks';

type SecondInstanceListener = (
  event: unknown,
  argv: string[],
  workingDirectory: string,
  additionalData?: unknown,
) => void;

type OpenUrlListener = (event: { preventDefault(): void }, url: string) => void;

class FakeDesktopProtocolApp implements DesktopProtocolApp {
  readonly isPackaged = true;
  requestCount = 0;
  quitCount = 0;
  protocolRegistrations: string[] = [];
  private readonly secondInstanceListeners: SecondInstanceListener[] = [];
  private readonly lockAvailable: boolean;

  constructor(options: { lockAvailable: boolean }) {
    this.lockAvailable = options.lockAvailable;
  }

  setAsDefaultProtocolClient(protocol: string): boolean {
    this.protocolRegistrations.push(protocol);
    return true;
  }

  requestSingleInstanceLock(): boolean {
    this.requestCount += 1;
    return this.lockAvailable;
  }

  quit(): void {
    this.quitCount += 1;
  }

  on(event: 'second-instance', listener: SecondInstanceListener): void;
  on(event: 'open-url', listener: OpenUrlListener): void;
  on(
    event: 'second-instance' | 'open-url',
    listener: SecondInstanceListener | OpenUrlListener,
  ): void {
    if (event === 'second-instance') {
      this.secondInstanceListeners.push(listener as SecondInstanceListener);
      return;
    }
  }

  emitSecondInstance(argv: string[]): void {
    for (const listener of this.secondInstanceListeners) {
      listener({}, argv, process.cwd());
    }
  }
}

describe('desktop protocol callback lifecycle', () => {
  it.each([
    {
      name: 'keeps normal launches behind the single-instance lock',
      lockAvailable: false,
      argv: [] as string[],
      shouldContinue: false,
      requestCount: 1,
      quitCount: 1,
      protocolRegistrations: [] as string[],
    },
    {
      name: 'lets explicit new-window launches run as separate processes',
      lockAvailable: false,
      argv: ['--texra-new-window', '--texra-workspace-path=/Users/ray/paper'],
      shouldContinue: true,
      requestCount: 1,
      quitCount: 0,
      protocolRegistrations: [] as string[],
    },
    {
      name: 'lets explicit new-window launches become primary when no owner exists',
      lockAvailable: true,
      argv: ['--texra-new-window', '--texra-workspace-path=/Users/ray/paper'],
      shouldContinue: true,
      requestCount: 1,
      quitCount: 0,
      protocolRegistrations: ['texra'],
    },
  ])(
    '$name',
    ({
      lockAvailable,
      argv,
      shouldContinue,
      requestCount,
      quitCount,
      protocolRegistrations,
    }) => {
      const app = new FakeDesktopProtocolApp({ lockAvailable });

      const lifecycle = installDesktopProtocolCallbackLifecycle({ app, argv });

      assert.equal(lifecycle.shouldContinue, shouldContinue);
      assert.equal(app.requestCount, requestCount);
      assert.equal(app.quitCount, quitCount);
      assert.deepEqual(app.protocolRegistrations, protocolRegistrations);
    },
  );

  it('does not focus the primary window for explicit new-window probes', () => {
    const app = new FakeDesktopProtocolApp({ lockAvailable: true });
    let focusCount = 0;

    installDesktopProtocolCallbackLifecycle({
      app,
      argv: [],
      focusMainWindow: () => {
        focusCount += 1;
      },
    });

    app.emitSecondInstance([
      '--texra-new-window',
      '--texra-workspace-path=/Users/ray/paper',
    ]);
    assert.equal(focusCount, 0);

    app.emitSecondInstance(['--texra-workspace-path=/Users/ray/other-paper']);
    assert.equal(focusCount, 1);
  });
});
