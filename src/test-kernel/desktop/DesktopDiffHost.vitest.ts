// Standard library imports
import { existsSync, readdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// Third-party imports
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { createDeferred } from '@test/support/asyncTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { loadSourceModule } from './loadSourceModule.ts';

// `rm` keeps its real implementation by default; tests arm one-shot failures
// with mockRejectedValueOnce to exercise the cleanup-retry path. The source
// module observes the same mock because loadSourceModule imports it through
// Vitest's module runner.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: vi.fn(original.readFile),
    rm: vi.fn(original.rm),
  };
});

// Route `node:timers/promises` through the global timer functions so
// `vi.useFakeTimers()` can drive the source module's timeout bound without a
// real multi-second wait.
vi.mock('node:timers/promises', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...original,
    setTimeout: vi.fn(
      (_delay: number, _value?: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('Aborted'));
            return;
          }
          const timer = setTimeout(() => resolve(), _delay);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason ?? new Error('Aborted'));
            },
            { once: true },
          );
        }),
    ),
  } as typeof import('node:timers/promises');
});

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');
type DiffHostOptions = Parameters<
  DesktopDiffHostModule['createDesktopDiffHost']
>[0];
type DiffHost = ReturnType<DesktopDiffHostModule['createDesktopDiffHost']>;

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];

// Every case needs the external-editor fallback observable, so the harness owns
// `openPath` and the paths it received.
function createHost(overrides: Partial<DiffHostOptions> = {}) {
  const openedPaths: string[] = [];
  const openPath = vi.fn(async (filePath: string) => {
    openedPaths.push(filePath);
  });
  const host = createDesktopDiffHost({ openPath, ...overrides });
  hosts.push(host);
  return {
    host,
    openPath,
    openedPaths,
  };
}

function expectOpenedPatchFile(openedPaths: readonly string[]): void {
  expect(openedPaths).toHaveLength(1);
  expect(path.extname(openedPaths[0])).toBe('.diff');
}

/** A promise/resolver pair used to pause a mock implementation mid-flight
 * until the test is ready to release it. */
function createGate(): { promise: Promise<void>; release: () => void } {
  const { promise, resolve } = createDeferred<void>();
  return { promise, release: resolve };
}

/** Pauses the next `readFile` call so a test can hold `openDiff` mid-flight
 * between the read starting and its result resolving. */
function gateReadFile(): {
  readStarted: ReturnType<typeof createGate>;
  readGate: ReturnType<typeof createGate>;
} {
  const readStarted = createGate();
  const readGate = createGate();
  vi.mocked(readFile).mockImplementationOnce(async () => {
    readStarted.release();
    await readGate.promise;
    return 'a\n';
  });
  return { readStarted, readGate };
}

const tempDirs = useTempDirs();
const hosts: DiffHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.map((host) => host.dispose()));
  hosts.length = 0;
});

type OpenDiffArgs = Parameters<DiffHost['openDiff']>;
type OpenDiffSources = [OpenDiffArgs[0], OpenDiffArgs[1]];

async function prepareDiffPair(
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<OpenDiffSources> {
  const tempDir = await makeTempDir('texra-diff-host-test-', tempDirs);
  const originalPath = path.join(tempDir, names[0]);
  const proposedPath = path.join(tempDir, names[1]);
  await Promise.all([
    writeFile(originalPath, texts[0], 'utf8'),
    writeFile(proposedPath, texts[1], 'utf8'),
  ]);
  return [{ filePath: originalPath }, { filePath: proposedPath }];
}

async function openDiffPair(
  host: DiffHost,
  title: string,
  names: [string, string] = ['a.tex', 'b.tex'],
  texts: [string, string] = ['a\n', 'b\n'],
): Promise<void> {
  const [original, proposed] = await prepareDiffPair(names, texts);
  await host.openDiff(original, proposed, title);
}

// Sorted so two snapshots compare equal when nothing was created or removed.
function listDiffTempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith('texra-desktop-diff-'))
    .sort();
}

describe('createDesktopDiffHost', () => {
  // `loadSourceModule` pulls the full desktop main graph through the module
  // runner; keep the hook timeout generous for cold combined test runs.
  beforeAll(async () => {
    ({ createDesktopDiffHost } = await loadSourceModule(
      '@desktop/main/desktopDiffHost',
    ));
  }, 60_000);

  it('falls back to a generated patch file when no renderer is wired', async () => {
    const { host, openedPaths } = createHost();

    await openDiffPair(
      host,
      'Compare',
      ['original.txt', 'proposed.txt'],
      ['hello\nold\n', 'hello\nnew\n'],
    );

    expectOpenedPatchFile(openedPaths);
    const patch = await readFile(openedPaths[0], 'utf8');
    expect(patch).toContain('-old');
    expect(patch).toContain('+new');
  });

  it('posts desktop:showDiff to the renderer when wired', async () => {
    const posted: unknown[] = [];
    // External fallback should not be invoked when postToRenderer is set.
    const { host, openPath } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
    });

    await openDiffPair(
      host,
      'Compare doc.tex',
      ['doc.tex', 'doc.proposed.tex'],
      ['hello\nold\n', 'hello\nnew\n'],
    );

    expect(openPath).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      command: 'desktop:showDiff',
      title: 'Compare doc.tex',
      displayPath: 'Compare doc.tex',
      originalText: 'hello\nold\n',
      proposedText: 'hello\nnew\n',
      additions: 1,
      deletions: 1,
      language: 'latex',
    });
  });

  it('falls back to the external editor when postToRenderer returns false', async () => {
    // Simulates the renderer not being reachable — IPC bridge not yet
    // wired at startup or BrowserWindow already destroyed. Bot review
    // (#3815, Copilot + Cursor): the host previously silently dropped
    // the diff in this case.
    const { host, openedPaths } = createHost({ postToRenderer: () => false });

    await openDiffPair(host, 'Compare');

    expectOpenedPatchFile(openedPaths);
  });

  it('falls back to the external editor when postToRenderer throws', async () => {
    // Suppress the deliberate console.error from the host so the test
    // output stays clean.
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { host, openedPaths } = createHost({
      postToRenderer: () => {
        throw new Error('renderer destroyed');
      },
    });

    await openDiffPair(host, 'Compare');

    expectOpenedPatchFile(openedPaths);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('honors forceExternal even when postToRenderer is wired', async () => {
    const posted: unknown[] = [];
    const { host, openedPaths } = createHost({
      postToRenderer: (message) => {
        posted.push(message);
        return true;
      },
      forceExternal: true,
    });

    await openDiffPair(host, 'Compare', ['a.txt', 'b.txt']);

    expect(posted).toHaveLength(0);
    expectOpenedPatchFile(openedPaths);
  });

  it('removes external-editor patch directories when the host is disposed', async () => {
    const { host, openedPaths } = createHost();

    await openDiffPair(host, 'Compare');
    const diffPath = openedPaths[0];
    const diffDir = path.dirname(diffPath);

    expect(existsSync(diffPath)).toBe(true);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);

    await host.dispose();

    expect(existsSync(diffDir)).toBe(false);
  });

  it('removes the patch directory immediately when the editor fails to open', async () => {
    const failure = new Error('editor unavailable');
    const { host, openPath } = createHost();
    openPath.mockRejectedValue(failure);

    // The original failure reaches the caller, not a cleanup artifact.
    await expect(openDiffPair(host, 'Compare')).rejects.toBe(failure);

    expect(openPath).toHaveBeenCalledTimes(1);
    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);
    expect(existsSync(diffDir)).toBe(false);
  });

  it('keeps a failed immediate cleanup recorded so dispose() retries it', async () => {
    // The one-shot rm rejection simulates an OS-level removal failure: the
    // directory must stay recorded (and the failure logged) so the dispose
    // at window close can retry it instead of leaking it untracked.
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { host, openPath } = createHost();
    openPath.mockRejectedValue(new Error('editor unavailable'));
    vi.mocked(rm).mockRejectedValueOnce(new Error('simulated removal failure'));

    await expect(openDiffPair(host, 'Compare')).rejects.toThrow(
      'editor unavailable',
    );

    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(existsSync(diffDir)).toBe(true);
    expect(consoleSpy).toHaveBeenCalledTimes(1);

    await host.dispose();

    expect(existsSync(diffDir)).toBe(false);
    consoleSpy.mockRestore();
  });

  it('removes a fallback directory created after disposal instead of recording it', async () => {
    // Destroyed-window-mid-fallback race: dispose() snapshots and clears the
    // record set while this openDiff is still awaiting its reads, so the temp
    // directory it creates afterwards must be removed immediately rather than
    // recorded, where nothing would ever remove it.
    const { host, openPath } = createHost();
    const [original, proposed] = await prepareDiffPair();
    const diffDirsBefore = listDiffTempDirs();

    const openPromise = host.openDiff(original, proposed, 'Compare');
    await host.dispose();

    await expect(openPromise).rejects.toThrow(
      'Desktop window closed before the diff could be opened.',
    );
    expect(openPath).not.toHaveBeenCalled();
    expect(listDiffTempDirs()).toEqual(diffDirsBefore);
  });

  it('rechecks the drain before snapshotting a late fallback registration', async () => {
    // A fallback registered after `dispose()` starts but before the record
    // snapshot must still be awaited: the drain rechecks after yielding, so the
    // quit lifecycle cannot resolve before the `disposed` branch cleans up.
    const { host, openPath } = createHost();
    const [original, proposed] = await prepareDiffPair();
    const diffDirsBefore = listDiffTempDirs();

    const { readStarted, readGate } = gateReadFile();

    const disposePromise = host.dispose();
    const openPromise = host.openDiff(original, proposed, 'Compare');

    await readStarted.promise;
    let disposeSettled = false;
    void disposePromise.then(() => {
      disposeSettled = true;
    });
    await Promise.resolve();
    expect(disposeSettled).toBe(false);

    readGate.release();
    await expect(openPromise).rejects.toThrow(
      'Desktop window closed before the diff could be opened.',
    );
    await disposePromise;
    expect(disposeSettled).toBe(true);
    expect(openPath).not.toHaveBeenCalled();
    expect(listDiffTempDirs()).toEqual(diffDirsBefore);
  });

  it('keeps a disposed-branch removal failure tracked for the removal phase', async () => {
    // When the fallback still belongs to the disposal drain, a transient
    // EBUSY/EPERM on its self-cleanup must leave the directory tracked so the
    // removal phase retries it instead of dropping it after one warning.
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { host, openPath } = createHost();
      const [original, proposed] = await prepareDiffPair();
      const diffDirsBefore = listDiffTempDirs();

      const { readStarted, readGate } = gateReadFile();

      const openPromise = host.openDiff(original, proposed, 'Compare');
      await readStarted.promise;

      const disposePromise = host.dispose();
      let removalTarget: string | undefined;
      vi.mocked(rm).mockImplementationOnce(async (target) => {
        removalTarget = String(target);
        throw new Error('simulated EBUSY removal failure');
      });

      readGate.release();

      await expect(openPromise).rejects.toThrow(
        'Desktop window closed before the diff could be opened.',
      );
      await disposePromise;

      const targetCalls = vi
        .mocked(rm)
        .mock.calls.filter(([target]) => String(target) === removalTarget);
      expect(targetCalls).toHaveLength(2);
      expect(existsSync(removalTarget!)).toBe(false);
      expect(openPath).not.toHaveBeenCalled();
      expect(listDiffTempDirs()).toEqual(diffDirsBefore);
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('retries a failed removal once during dispose', async () => {
    // A transient OS-level failure during dispose() must be retried, not just
    // logged: the record set has already been cleared, so a single failed
    // attempt would otherwise leak the directory permanently.
    const { host, openedPaths } = createHost();

    await openDiffPair(host, 'Compare');
    const diffDir = path.dirname(openedPaths[0]);

    vi.mocked(rm).mockRejectedValueOnce(new Error('simulated removal failure'));

    await host.dispose();

    expect(existsSync(diffDir)).toBe(false);
  });

  it('settles every removal before dispose rejects when a removal keeps failing', async () => {
    // `Promise.all` would reject at the first failed `rm` while its siblings
    // are still running; the quit drain could then proceed to `app.quit()`
    // before those siblings finish. `dispose()` must settle all of them, retry
    // the failure once, and only then surface the failure.
    const { host, openedPaths } = createHost();

    await openDiffPair(host, 'Compare 1', ['a.tex', 'b.tex']);
    await openDiffPair(host, 'Compare 2', ['c.tex', 'd.tex']);
    const [firstDir, secondDir] = openedPaths.map((openedPath) =>
      path.dirname(openedPath),
    );
    // Record both so afterEach removes whichever directory dispose() leaves
    // behind after the removal failure below.
    tempDirs.push(firstDir, secondDir);

    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let firstDirAttempts = 0;
    vi.mocked(rm).mockImplementation(async (target, options) => {
      if (String(target) === firstDir) {
        firstDirAttempts += 1;
        throw new Error('simulated removal failure');
      }
      await actualFs.rm(
        target as string,
        options as Parameters<typeof actualFs.rm>[1],
      );
    });

    try {
      await expect(host.dispose()).rejects.toBeInstanceOf(AggregateError);

      // The failed removal leaves its directory behind (afterEach cleans it
      // up), but the sibling removal has already settled before dispose()
      // threw, and the failed directory got exactly one immediate retry.
      expect(firstDirAttempts).toBe(2);
      expect(existsSync(firstDir)).toBe(true);
      expect(existsSync(secondDir)).toBe(false);
    } finally {
      vi.mocked(rm).mockImplementation(actualFs.rm);
    }
  });

  it('keeps dispose pending until an in-flight fallback removes its post-disposal directory', async () => {
    // The disposal-race test above awaits `openPromise`, which hides the quit
    // gap: a normal window close does not await the untracked `openDiff`
    // promise. `dispose()` must instead await the fallback setup and the
    // removal its `disposed` branch performs.
    const { host, openPath } = createHost();
    const [original, proposed] = await prepareDiffPair();
    const diffDirsBefore = listDiffTempDirs();

    const removalGate = createGate();
    let removalTarget: string | undefined;
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(rm).mockImplementationOnce(async (target, options) => {
      removalTarget = String(target);
      await removalGate.promise;
      await actualFs.rm(
        target as string,
        options as Parameters<typeof actualFs.rm>[1],
      );
    });

    const openPromise = host.openDiff(original, proposed, 'Compare');
    const disposePromise = host.dispose();

    await vi.waitFor(() => {
      expect(removalTarget).toBeDefined();
    });

    let disposeSettled = false;
    void disposePromise.then(() => {
      disposeSettled = true;
    });
    await sleep(25);
    expect(disposeSettled).toBe(false);

    removalGate.release();
    await expect(openPromise).rejects.toThrow(
      'Desktop window closed before the diff could be opened.',
    );
    await disposePromise;

    expect(openPath).not.toHaveBeenCalled();
    expect(listDiffTempDirs()).toEqual(diffDirsBefore);
  });

  it('shares an in-flight error-path removal with dispose instead of double-removing', async () => {
    // If dispose() runs while the fallback error path is already removing its
    // directory, both sides must await the same per-path removal promise. Two
    // concurrent recursive `rm`s on one path can fail on Windows; the second
    // one could also fail after dispose() has cleared the record set, leaving
    // the directory untracked.
    const { host, openPath } = createHost();
    openPath.mockRejectedValue(new Error('editor unavailable'));

    const removalGate = createGate();
    let removalTarget: string | undefined;
    const actualFs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(rm).mockImplementationOnce(async (target, options) => {
      removalTarget = String(target);
      await removalGate.promise;
      await actualFs.rm(
        target as string,
        options as Parameters<typeof actualFs.rm>[1],
      );
    });

    const openPromise = openDiffPair(host, 'Compare');
    await vi.waitFor(() => {
      expect(removalTarget).toBeDefined();
    });

    const disposePromise = host.dispose();
    // Give dispose() time to snapshot the still-recorded directory and request
    // its removal. The per-path memo must return the gated removal above
    // instead of issuing a second `rm`.
    await sleep(25);
    const targetCalls = vi
      .mocked(rm)
      .mock.calls.filter(([target]) => String(target) === removalTarget);
    expect(targetCalls).toHaveLength(1);

    removalGate.release();
    await expect(openPromise).rejects.toThrow('editor unavailable');
    await disposePromise;

    expect(existsSync(removalTarget!)).toBe(false);
  });

  it('retries a shared in-flight error-path removal when it fails during dispose', async () => {
    // The error-path removal and dispose() share one per-path promise. When
    // the window closes while that shared removal is still in flight and the
    // shared `rm` rejects, dispose() must retry it after the memo clears;
    // otherwise the directory leaves the record set on the failed attempt and
    // leaks.
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { host, openPath } = createHost();
      openPath.mockRejectedValue(new Error('editor unavailable'));

      const removalGate = createGate();
      let removalTarget: string | undefined;
      vi.mocked(rm).mockImplementationOnce(async (target) => {
        removalTarget = String(target);
        await removalGate.promise;
        throw new Error('simulated removal failure');
      });

      const openPromise = openDiffPair(host, 'Compare');
      await vi.waitFor(() => {
        expect(removalTarget).toBeDefined();
      });

      const disposePromise = host.dispose();
      removalGate.release();

      await expect(openPromise).rejects.toThrow('editor unavailable');
      await disposePromise;

      const targetCalls = vi
        .mocked(rm)
        .mock.calls.filter(([target]) => String(target) === removalTarget);
      expect(targetCalls).toHaveLength(2);
      expect(existsSync(removalTarget!)).toBe(false);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('bounds the dispose wait for in-flight fallback setup', async () => {
    // Mirrors the file-local timeout in `desktopDiffHost.ts` so the fake
    // timers advance to the exact bound without publishing that detail.
    const diffHostFallbackSetupTimeoutMs = 5_000;
    vi.useFakeTimers();
    try {
      const { host, openPath } = createHost();
      const [original, proposed] = await prepareDiffPair();

      const { readStarted, readGate } = gateReadFile();

      const openPromise = host.openDiff(original, proposed, 'Compare');
      await readStarted.promise;

      const disposePromise = host.dispose();
      let disposeSettled = false;
      void disposePromise.then(() => {
        disposeSettled = true;
      });

      await vi.advanceTimersByTimeAsync(diffHostFallbackSetupTimeoutMs - 1);
      expect(disposeSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await disposePromise;
      expect(disposeSettled).toBe(true);

      // The hung setup is abandoned after the bound. Once it resumes, the
      // `disposed` branch still removes its own temp directory.
      readGate.release();
      await expect(openPromise).rejects.toThrow(
        'Desktop window closed before the diff could be opened.',
      );
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
