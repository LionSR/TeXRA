import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildUpdateCommand,
  checkCliUpdateAvailable,
  detectInstallMethod,
  fetchLatestCliVersion,
  fetchLatestHomebrewFormulaVersion,
  formatUpdateCommand,
  isPackageManagerInstall,
  notifyCliUpdate,
  resetCliUpdateNotifyLatchForTests,
} from '@cli/runtime/updateChecker';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeStateStore } from '@test/support/FakePlatform';

const mocks = vi.hoisted(() => ({ readCliAmbientState: vi.fn() }));

vi.mock('@cli/runtime/cliContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliContext')>()),
  readCliAmbientState: mocks.readCliAmbientState,
}));

describe('detectInstallMethod', () => {
  it('recognizes pnpm, yarn, and bun global layouts', () => {
    expect(
      detectInstallMethod('/Users/me/Library/pnpm/global/5/node_modules/x'),
    ).toBe('pnpm');
    expect(detectInstallMethod('/usr/local/.pnpm/x/node_modules/x')).toBe(
      'pnpm',
    );
    expect(detectInstallMethod('/Users/me/.config/yarn/global/x')).toBe('yarn');
    // Yarn Classic's global bin: dotted `.yarn` segment.
    expect(detectInstallMethod('/Users/me/.yarn/bin/x')).toBe('yarn');
    expect(detectInstallMethod('/Users/me/.bun/install/global/x')).toBe('bun');
  });

  it('recognizes Homebrew Cellar layouts across platforms', () => {
    // Apple Silicon.
    expect(
      detectInstallMethod(
        '/opt/homebrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
    // Intel macOS.
    expect(
      detectInstallMethod(
        '/usr/local/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
    // Linuxbrew.
    expect(
      detectInstallMethod(
        '/home/linuxbrew/.linuxbrew/Cellar/texra/0.38.7/libexec/dist/bin/texra.js',
      ),
    ).toBe('brew');
  });

  it('falls back to npm for the unmarked global layout', () => {
    expect(
      detectInstallMethod('/usr/local/lib/node_modules/@texra-ai/cli/dist'),
    ).toBe('npm');
  });

  it('does not treat Homebrew-managed Node npm globals as brew installs', () => {
    expect(
      detectInstallMethod(
        '/opt/homebrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe('npm');
    expect(
      detectInstallMethod(
        '/home/linuxbrew/.linuxbrew/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe('npm');
  });
});

describe('isPackageManagerInstall', () => {
  it('treats node_modules-resident installs as managed', () => {
    // npm/pnpm/yarn/bun globals all live under node_modules.
    expect(
      isPackageManagerInstall(
        '/usr/local/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
    expect(
      isPackageManagerInstall(
        '/Users/me/Library/pnpm/global/5/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
  });

  it('treats a Homebrew Cellar install as managed even without node_modules', () => {
    // The tap formula installs the bundled binary under Cellar/<v>/, which need
    // not contain a node_modules segment — the `cellar` segment marks it (same
    // path shape detectInstallMethod recognizes as brew).
    const brewPath =
      '/opt/homebrew/Cellar/texra/0.38.10/libexec/dist/bin/texra.js';
    expect(brewPath.toLowerCase().includes('node_modules')).toBe(false);
    expect(isPackageManagerInstall(brewPath)).toBe(true);
    expect(detectInstallMethod(brewPath)).toBe('brew');
  });

  it('is case-insensitive for Windows paths', () => {
    expect(
      isPackageManagerInstall(
        'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@texra-ai\\cli\\dist\\bin\\texra.js',
      ),
    ).toBe(true);
  });

  it('treats a source/dev or linked checkout as unmanaged', () => {
    // A dev build runs straight from packages/cli/dist — no node_modules
    // segment — which is exactly why this gate is needed: detectInstallMethod
    // would otherwise fall back to 'npm' and prompt `npm install -g`.
    const devPath = '/Users/me/projects/texra/packages/cli/dist/bin/texra.js';
    expect(isPackageManagerInstall(devPath)).toBe(false);
    expect(detectInstallMethod(devPath)).toBe('npm');
    expect(
      isPackageManagerInstall('/Users/me/.local/share/texra/dist/bin/texra.js'),
    ).toBe(false);
  });
});

describe('buildUpdateCommand / formatUpdateCommand', () => {
  it('produces the matching install invocation per manager', () => {
    expect(formatUpdateCommand('npm')).toBe(
      'npm install -g @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('pnpm')).toBe(
      'pnpm add -g @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('yarn')).toBe(
      'yarn global add @texra-ai/cli@latest',
    );
    expect(formatUpdateCommand('bun')).toBe('bun add -g @texra-ai/cli@latest');
    // Homebrew upgrades through brew, not the npm registry; refresh the tap
    // first so the just-detected version is actually available locally.
    expect(formatUpdateCommand('brew')).toBe(
      'brew update && brew upgrade texra',
    );
    expect(buildUpdateCommand('npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@texra-ai/cli@latest'],
    });
    expect(buildUpdateCommand('brew')).toEqual({
      command: 'brew',
      args: ['update', '&&', 'brew', 'upgrade', 'texra'],
    });
  });
});

describe('fetchLatestCliVersion', () => {
  function jsonResponse(body: unknown, ok = true): Response {
    return {
      ok,
      json: async () => body,
    } as unknown as Response;
  }

  it.each([
    {
      name: 'returns the version field from the latest dist-tag',
      fetchImpl: async () => jsonResponse({ version: '9.9.9' }),
      expected: '9.9.9',
    },
    {
      name: 'returns undefined on non-ok responses',
      fetchImpl: async () => jsonResponse({ version: '9.9.9' }, false),
      expected: undefined,
    },
    {
      name: 'returns undefined when the fetch throws (offline)',
      fetchImpl: async () => {
        throw new Error('offline');
      },
      expected: undefined,
    },
    {
      name: 'returns undefined when the body lacks a version',
      fetchImpl: async () => jsonResponse({}),
      expected: undefined,
    },
  ])('$name', async ({ fetchImpl, expected }) => {
    await expect(
      fetchLatestCliVersion({ fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toBe(expected);
  });
});

describe('fetchLatestHomebrewFormulaVersion', () => {
  it('returns the stable formula version from brew info JSON', async () => {
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () =>
          JSON.stringify({
            formulae: [
              {
                name: 'texra',
                versions: { stable: '0.39.0' },
              },
            ],
          }),
      }),
    ).resolves.toEqual({ version: '0.39.0', refreshed: true });
  });

  it('returns no version when brew info is unavailable or missing the formula', async () => {
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => undefined,
      }),
    ).resolves.toEqual({ version: undefined, refreshed: false });
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async () => JSON.stringify({ formulae: [] }),
      }),
    ).resolves.toEqual({ version: undefined, refreshed: true });
  });

  it('still reads formula info when the Homebrew tap refresh fails, marked stale', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await expect(
      fetchLatestHomebrewFormulaVersion({
        runCommand: async (command, args) => {
          calls.push({ command, args });
          if (args[0] === 'update') return undefined;
          return JSON.stringify({
            formulae: [{ name: 'texra', versions: { stable: '0.39.0' } }],
          });
        },
      }),
    ).resolves.toEqual({ version: '0.39.0', refreshed: false });

    expect(calls).toEqual([
      { command: 'brew', args: ['update', '--quiet'] },
      { command: 'brew', args: ['info', '--json=v2', 'texra'] },
    ]);
  });

  it('passes the formula and timeout through to the command runner', async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      timeoutMs: number;
      cwd?: string;
    }> = [];
    await fetchLatestHomebrewFormulaVersion({
      formula: 'custom',
      timeoutMs: 123,
      cwd: '/workspace',
      runCommand: async (command, args, timeoutMs, cwd) => {
        calls.push({ command, args, timeoutMs, cwd });
        return JSON.stringify({
          formulae: [{ name: 'custom', versions: { stable: '1.2.3' } }],
        });
      },
    });

    expect(calls).toEqual([
      {
        command: 'brew',
        args: ['update', '--quiet'],
        timeoutMs: 123,
        cwd: '/workspace',
      },
      {
        command: 'brew',
        args: ['info', '--json=v2', 'custom'],
        timeoutMs: 123,
        cwd: '/workspace',
      },
    ]);
  });
});

describe('notifyCliUpdate', () => {
  // A CI run returns right after the ambient read, so the number of ambient
  // reads is exactly the number of times the latch let the check start.
  const context = createTestCliContext({ version: '0.39.3' });

  beforeEach(() => {
    resetCliUpdateNotifyLatchForTests();
    mocks.readCliAmbientState.mockReset().mockReturnValue({
      isCi: true,
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      termIsDumb: false,
      stdoutColorEnabled: false,
      stderrColorEnabled: false,
    });
  });

  it('runs the check at most once per process', async () => {
    await notifyCliUpdate(context);
    await notifyCliUpdate(context);

    expect(mocks.readCliAmbientState).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh check once the latch is cleared', async () => {
    await notifyCliUpdate(context);
    resetCliUpdateNotifyLatchForTests();
    await notifyCliUpdate(context);

    expect(mocks.readCliAmbientState).toHaveBeenCalledTimes(2);
  });
});

describe('checkCliUpdateAvailable', () => {
  const currentVersion = '0.39.3';
  const latestVersion = '0.40.0';
  const noopNotify = async () => {};

  function lastCheckedAt(globalState: FakeStateStore): unknown {
    return globalState.get(GlobalStateKey.CLI_UPDATE_CHECK_LAST_CHECKED_AT);
  }

  function recordingNotify(notified: string[]) {
    return async (version: string) => {
      notified.push(version);
    };
  }

  function checkAvailable(options: {
    globalState: FakeStateStore;
    currentVersion?: string;
    now?: () => number;
    fetchLatest?: () => Promise<{
      version: string | undefined;
      refreshed: boolean;
    }>;
    notify?: (version: string) => Promise<void>;
  }): Promise<string | undefined> {
    return checkCliUpdateAvailable({
      currentVersion: options.currentVersion ?? currentVersion,
      globalState: options.globalState,
      now: options.now,
      fetchLatest:
        options.fetchLatest ??
        (async () => ({ version: latestVersion, refreshed: true })),
      notify: options.notify ?? noopNotify,
    });
  }

  it('checks on a first launch (no prior lastCheckedAt) and reports a newer version', async () => {
    const globalState = new FakeStateStore();
    let fetchCalls = 0;
    const notified: string[] = [];

    const latest = await checkAvailable({
      globalState,
      fetchLatest: async () => {
        fetchCalls += 1;
        return { version: latestVersion, refreshed: true };
      },
      notify: recordingNotify(notified),
    });

    expect(fetchCalls).toBe(1);
    expect(latest).toBe(latestVersion);
    expect(notified).toEqual([latestVersion]);
  });

  it('returns undefined and does not notify when the fetched version is not newer', async () => {
    const globalState = new FakeStateStore();
    const notified: string[] = [];

    const latest = await checkAvailable({
      globalState,
      currentVersion: latestVersion,
      notify: recordingNotify(notified),
    });

    expect(latest).toBeUndefined();
    expect(notified).toEqual([]);
    // The check itself completed, so the day's stamp is still persisted.
    expect(lastCheckedAt(globalState)).toBeDefined();
  });

  it('throttles repeated checks within the same day', async () => {
    const globalState = new FakeStateStore();
    let fetchCalls = 0;
    // A realistic epoch timestamp: on the very first check ever,
    // `lastCheckedAt` defaults to 0, and this must be far enough past that
    // default to *not* be throttled (matching a real first launch).
    let nowMs = Date.UTC(2026, 0, 1);

    const run = () =>
      checkAvailable({
        globalState,
        now: () => nowMs,
        fetchLatest: async () => {
          fetchCalls += 1;
          return { version: latestVersion, refreshed: true };
        },
      });

    await run();
    expect(fetchCalls).toBe(1);

    // Same process/day, ten minutes later: still throttled — no network hit.
    nowMs += 10 * 60 * 1000;
    await run();
    expect(fetchCalls).toBe(1);

    // A full day later: throttle window has elapsed.
    nowMs += 24 * 60 * 60 * 1000;
    await run();
    expect(fetchCalls).toBe(2);
  });

  it('does not persist the throttle stamp on a failed fetch, so the next launch retries', async () => {
    const globalState = new FakeStateStore();
    let fetchCalls = 0;
    const nowMs = Date.UTC(2026, 0, 1);

    await checkAvailable({
      globalState,
      now: () => nowMs,
      fetchLatest: async () => {
        fetchCalls += 1;
        // simulates a network/registry failure
        return { version: undefined, refreshed: false };
      },
    });

    expect(fetchCalls).toBe(1);
    expect(lastCheckedAt(globalState)).toBeUndefined();

    // Immediately "relaunching" (same day) must retry rather than being
    // throttled for a full 24h off the back of the earlier failure.
    await checkAvailable({
      globalState,
      now: () => nowMs + 1000,
      fetchLatest: async () => {
        fetchCalls += 1;
        return { version: latestVersion, refreshed: true };
      },
    });

    expect(fetchCalls).toBe(2);
    expect(lastCheckedAt(globalState)).toBe(nowMs + 1000);
  });

  it('does not persist the throttle stamp on a stale (unrefreshed) version, but still offers it', async () => {
    // #8223: a failed `brew update` that still yields the locally cached
    // formula version must not count as a completed check — the next launch
    // retries the tap refresh instead of going silent for 24h.
    const globalState = new FakeStateStore();
    const nowMs = Date.UTC(2026, 0, 1);
    const notified: string[] = [];

    const latest = await checkAvailable({
      globalState,
      now: () => nowMs,
      fetchLatest: async () => ({ version: latestVersion, refreshed: false }),
      notify: recordingNotify(notified),
    });

    expect(latest).toBe(latestVersion);
    expect(notified).toEqual([latestVersion]);
    expect(lastCheckedAt(globalState)).toBeUndefined();
  });

  it('does not persist the throttle stamp when the notify prompt throws', async () => {
    // #8224: the stamp must be written only after the user actually saw the
    // notice — a prompt killed mid-way (closed stdin) leaves the attempt
    // un-stamped so the next launch re-checks.
    const globalState = new FakeStateStore();
    const nowMs = Date.UTC(2026, 0, 1);

    await expect(
      checkAvailable({
        globalState,
        now: () => nowMs,
        notify: async () => {
          throw new Error('stdin closed');
        },
      }),
    ).rejects.toThrow('stdin closed');

    expect(lastCheckedAt(globalState)).toBeUndefined();
  });

  it('still reports the update when the throttle stamp write fails', async () => {
    // A readable-but-unwritable global state file lets `JsonStore.open`
    // succeed while `update` rejects. The stamp is best-effort: its failure
    // must not reject the completed attempt (which would cancel an update the
    // user already accepted via the notify prompt) — the next launch just
    // re-checks a day early.
    const globalState = new FakeStateStore();
    vi.spyOn(globalState, 'update').mockRejectedValue(
      new Error('EACCES: permission denied'),
    );
    const notified: string[] = [];

    const latest = await checkAvailable({
      globalState,
      notify: recordingNotify(notified),
    });

    expect(latest).toBe(latestVersion);
    expect(notified).toEqual([latestVersion]);
  });

  it('persists the throttle stamp only after notify completes', async () => {
    const globalState = new FakeStateStore();
    const nowMs = Date.UTC(2026, 0, 1);
    let stampAtNotifyTime: unknown = 'unread';

    await checkAvailable({
      globalState,
      now: () => nowMs,
      notify: async () => {
        stampAtNotifyTime = lastCheckedAt(globalState);
      },
    });

    expect(stampAtNotifyTime).toBeUndefined();
    expect(lastCheckedAt(globalState)).toBe(nowMs);
  });
});
