// Node imports
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { handoffDesktopWorkspaceRelaunch } from '@desktop/main/desktopWorkspaceRelaunch';
import { withWorkspacePathArg } from '@desktop/shared/workspacePath';
import { createModuleMocks } from '@test/support/moduleMocks';

// Local imports - desktop test paths
import { moduleFileUrl, repoPath } from './desktopTestPaths.ts';

const mocks = createModuleMocks();

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly stdio?: unknown;
  };
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const originalArgv = [...process.argv];
const originalNpmExecPath = process.env.npm_execpath;
const originalElectronDistPath = process.env.ELECTRON_OVERRIDE_DIST_PATH;
const originalSigintListeners = new Set(process.listeners('SIGINT'));
const originalSigtermListeners = new Set(process.listeners('SIGTERM'));

function restoreEnvVar(name: string, original: string | undefined): void {
  if (original == null) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function removeAddedListeners(
  signal: NodeJS.Signals,
  original: ReadonlySet<NodeJS.SignalsListener>,
): void {
  for (const listener of process.listeners(signal)) {
    if (!original.has(listener)) {
      process.removeListener(signal, listener);
    }
  }
}

afterEach(() => {
  process.argv = [...originalArgv];
  restoreEnvVar('npm_execpath', originalNpmExecPath);
  restoreEnvVar('ELECTRON_OVERRIDE_DIST_PATH', originalElectronDistPath);
  removeAddedListeners('SIGINT', originalSigintListeners);
  removeAddedListeners('SIGTERM', originalSigtermListeners);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

interface LauncherHarness {
  readonly calls: SpawnCall[];
  readonly children: FakeChild[];
  readonly events: string[];
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly port: number;
}

async function launchDesktopDev(): Promise<LauncherHarness> {
  const calls: SpawnCall[] = [];
  const events: string[] = [];
  const children: FakeChild[] = [];
  const port = 43_217;

  const spawn = vi.fn(
    (
      command: string,
      args: readonly string[],
      options: SpawnCall['options'],
    ) => {
      const child = new FakeChild();
      calls.push({ command, args: [...args], options });
      children.push(child);
      if (args.includes('build:main') || args.includes('build:preload')) {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit('exit', 0, null);
        });
      } else if (args.includes('watch:main')) {
        events.push('main-watch');
      } else if (args.includes('vite')) {
        events.push('vite');
      } else {
        events.push('electron');
      }
      return child;
    },
  );

  const server = Object.assign(new EventEmitter(), {
    address: vi.fn(() => ({
      address: '127.0.0.1',
      family: 'IPv4',
      port,
    })),
    close: vi.fn((callback?: (error?: Error) => void) => callback?.()),
    listen: vi.fn(
      (requestedPort: number, host: string, callback: () => void) => {
        expect(requestedPort).toBe(0);
        expect(host).toBe('127.0.0.1');
        events.push('port');
        callback();
      },
    ),
  });
  const fetch = vi.fn(async (url: string) => {
    events.push('ready');
    expect(url).toBe(`http://127.0.0.1:${port}`);
    return { ok: true };
  });

  mocks.doMock('node:child_process', () => ({ spawn }));
  mocks.doMock('node:net', () => ({
    createServer: vi.fn(() => server),
  }));
  mocks.doMock('node:timers/promises', () => ({
    setTimeout: vi.fn(async () => {}),
  }));
  vi.stubGlobal('fetch', fetch);
  // dev.mjs resolves the Electron binary at module load (`require('electron')`),
  // and electron's index.js *downloads* the platform binary on demand when it
  // is missing. That turned this unit test into a network fetch on a fresh
  // checkout — and a hard failure with no network. The override short-circuits
  // that resolution to a fixed path; the assertions below only check the spawn
  // arguments, env, and stdio, never the binary's location.
  process.env.ELECTRON_OVERRIDE_DIST_PATH = '/test/electron-dist';
  process.env.npm_execpath = '/test/pnpm.cjs';
  process.argv = [
    process.execPath,
    'scripts/dev.mjs',
    '--texra-workspace-path',
    '/tmp/paper',
  ];

  await import(
    `${moduleFileUrl(repoPath('packages/desktop/scripts/dev.mjs'))}?test=${Date.now()}`
  );
  await vi.waitFor(() => expect(calls).toHaveLength(5));

  return { calls, children, events, fetch, port };
}

describe('desktop development launcher', () => {
  it('allocates a port, starts Vite, waits for readiness, then launches Electron', async () => {
    const { calls, children, events, fetch, port } = await launchDesktopDev();

    expect(calls[0]?.args).toEqual(['/test/pnpm.cjs', 'run', 'build:main']);
    expect(calls[1]?.args).toEqual(['/test/pnpm.cjs', 'run', 'build:preload']);
    expect(calls[2]?.args).toEqual(['/test/pnpm.cjs', 'run', 'watch:main']);

    const viteCall = calls[3];
    expect(viteCall?.args).toEqual([
      '/test/pnpm.cjs',
      'exec',
      'vite',
      '--config',
      'vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ]);

    const electronCall = calls[4];
    expect(electronCall?.args.slice(1)).toEqual([
      '--texra-workspace-path',
      '/tmp/paper',
    ]);
    expect(electronCall?.options.env).toMatchObject({
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}`,
      NODE_ENV: 'development',
      TEXRA_DESKTOP_DEV_SUPERVISED: '1',
    });
    expect(electronCall?.options.stdio).toEqual([
      'inherit',
      'inherit',
      'inherit',
      'ipc',
    ]);
    expect(events).toEqual(['main-watch', 'port', 'vite', 'ready', 'electron']);
    expect(fetch).toHaveBeenCalledOnce();
    expect(children.every((child) => !child.killed)).toBe(true);
  });

  it('hands the exact workspace relaunch arguments to the supervised development process', () => {
    const args = withWorkspacePathArg(['/desktop'], '/tmp/new-paper');
    const send = vi.fn();
    const relaunch = vi.fn();

    handoffDesktopWorkspaceRelaunch(args, {
      supervised: true,
      send,
      relaunch,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(args);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it('relaunches packaged desktop with the exact workspace arguments', () => {
    const args = withWorkspacePathArg(['/desktop'], '/tmp/new-paper');
    const send = vi.fn();
    const relaunch = vi.fn();

    handoffDesktopWorkspaceRelaunch(args, {
      supervised: false,
      send,
      relaunch,
    });

    expect(relaunch).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledWith(args);
    expect(send).not.toHaveBeenCalled();
  });

  it('launches Electron with the exact valid IPC relaunch arguments', async () => {
    const { calls, children, port } = await launchDesktopDev();
    const replacementArgs = [
      '/desktop',
      '--texra-workspace-path=/tmp/new-paper',
    ];

    children[4]?.emit('message', replacementArgs);
    children[4]?.emit('exit', 0, null);
    await vi.waitFor(() => expect(calls).toHaveLength(6));

    expect(calls[5]?.args.slice(1)).toEqual(replacementArgs);
    expect(calls[5]?.options.env).toMatchObject({
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}`,
      TEXRA_DESKTOP_DEV_SUPERVISED: '1',
    });
  });

  it('does not relaunch Electron after a child exits without an IPC handoff', async () => {
    const { calls, children } = await launchDesktopDev();

    children[4]?.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(5);
  });

  it('does not relaunch Electron after a child exits with an invalid IPC payload', async () => {
    const { calls, children } = await launchDesktopDev();

    children[4]?.emit('message', ['--workspace', 1]);
    children[4]?.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(5);
  });

  it('does not relaunch Electron after a child exits with an empty IPC payload', async () => {
    const { calls, children } = await launchDesktopDev();

    children[4]?.emit('message', []);
    children[4]?.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(5);
  });
});
