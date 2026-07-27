// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - desktop terminal host
import { createDesktopPtyHost } from '@desktop/main/desktopPtyHost';

const spawn = vi.fn();

function createChild() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 42,
  };
}

describe('desktop pty host', () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it('shares one in-flight creation for the same session id', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);
    const host = createDesktopPtyHost({
      onData: vi.fn(),
      onExit: vi.fn(),
      loadPty: async () => ({ spawn }),
    });

    const first = host.create({ id: 'terminal:1', cols: 80, rows: 24 });
    const second = host.create({ id: 'terminal:1', cols: 80, rows: 24 });
    const [firstHandle, secondHandle] = await Promise.all([first, second]);

    expect(firstHandle).toBe(secondHandle);
    expect(spawn).toHaveBeenCalledOnce();
    host.disposeAll();
  });

  it('clamps initial and resized terminal geometry', async () => {
    const child = createChild();
    spawn.mockReturnValue(child);
    const host = createDesktopPtyHost({
      onData: vi.fn(),
      onExit: vi.fn(),
      loadPty: async () => ({ spawn }),
    });

    const handle = await host.create({
      id: 'terminal:large',
      cols: 2 ** 30,
      rows: 2 ** 30,
    });
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cols: 1_000, rows: 500 }),
    );

    handle.resize(0, 0);
    expect(child.resize).toHaveBeenCalledWith(20, 5);
    host.disposeAll();
  });
});
