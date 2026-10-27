// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import {
  createDesktopPtyHost,
  type DesktopPtyHostOptions,
} from '@desktop/main/desktopPtyHost';

type LoadPty = NonNullable<DesktopPtyHostOptions['loadPty']>;
type PtyModule = Awaited<ReturnType<LoadPty>>;
type SpawnPty = PtyModule['spawn'];
type PtyProcess = ReturnType<SpawnPty>;

interface FakePty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
}

function createFakePty(): FakePty & PtyProcess {
  let dataListener = (_data: string): void => {};
  let exitListener: Parameters<PtyProcess['onExit']>[0] = () => {};
  return {
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn<(signal?: string) => void>(),
    onData(listener) {
      dataListener = listener;
    },
    onExit(listener) {
      exitListener = listener;
    },
    emitData: (data) => dataListener(data),
    emitExit: (exitCode) => exitListener({ exitCode }),
  };
}

const TERMINAL_ID = 'workbench:terminal:1';

describe('desktop pty host', () => {
  it('ignores callbacks from a disposed session after its id is reused', async () => {
    const oldPty = createFakePty();
    const replacementPty = createFakePty();
    const spawnPty = vi
      .fn<SpawnPty>()
      .mockReturnValueOnce(oldPty)
      .mockReturnValueOnce(replacementPty);
    const onData = vi.fn();
    const onExit = vi.fn();
    const host = createDesktopPtyHost({
      cwd: '/workspace',
      onData,
      onExit,
      onError: vi.fn(),
      loadPty: async () => ({ spawn: spawnPty }),
    });

    const oldSession = await host.create({
      id: TERMINAL_ID,
      cols: 80,
      rows: 24,
    });
    if (!oldSession) throw new Error('Expected the old session to start.');
    oldSession.dispose();
    const replacementSession = await host.create({
      id: TERMINAL_ID,
      cols: 100,
      rows: 30,
    });
    if (!replacementSession) {
      throw new Error('Expected the replacement session to start.');
    }

    oldPty.emitData('late output');
    oldPty.emitExit(0);

    expect(host.get(TERMINAL_ID)).toBe(replacementSession);
    expect(onData).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    replacementPty.emitData('new output');
    replacementPty.emitExit(7);

    expect(onData).toHaveBeenCalledWith(TERMINAL_ID, 'new output');
    expect(onExit).toHaveBeenCalledWith(TERMINAL_ID, 7);
    expect(host.get(TERMINAL_ID)).toBeUndefined();
  });
});
