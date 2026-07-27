// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createDesktopPtyHost } from '@desktop/main/desktopPtyHost';

interface FakePty {
  emitData(data: string): void;
  emitExit(exitCode: number): void;
  kill: ReturnType<typeof vi.fn>;
}

function createFakePty(pid: number): FakePty & {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  readonly pid: number;
} {
  let dataListener = (_data: string): void => {};
  let exitListener = (_event: { exitCode: number }): void => {};
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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

describe('desktop pty host', () => {
  it('ignores callbacks from a disposed session after its id is reused', async () => {
    const oldPty = createFakePty(101);
    const replacementPty = createFakePty(102);
    const spawnPty = vi
      .fn()
      .mockReturnValueOnce(oldPty)
      .mockReturnValueOnce(replacementPty);
    const onData = vi.fn();
    const onExit = vi.fn();
    const host = createDesktopPtyHost({ onData, onExit, spawnPty });

    const oldSession = await host.create({
      id: 'workbench:terminal:1',
      cols: 80,
      rows: 24,
    });
    oldSession.dispose();
    const replacementSession = await host.create({
      id: 'workbench:terminal:1',
      cols: 100,
      rows: 30,
    });

    expect(replacementSession).not.toBe(oldSession);
    expect(spawnPty).toHaveBeenCalledTimes(2);
    oldPty.emitData('late output');
    oldPty.emitExit(0);

    expect(host.get('workbench:terminal:1')).toBe(replacementSession);
    expect(onData).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();

    replacementPty.emitData('new output');
    replacementPty.emitExit(7);

    expect(onData).toHaveBeenCalledWith('workbench:terminal:1', 'new output');
    expect(onExit).toHaveBeenCalledWith('workbench:terminal:1', 7);
    expect(host.get('workbench:terminal:1')).toBeUndefined();
  });
});
