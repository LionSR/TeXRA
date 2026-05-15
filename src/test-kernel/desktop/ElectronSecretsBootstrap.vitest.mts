// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { repoPath } from './desktopTestPaths.mjs';

interface ElectronSecretsModule {
  ElectronSecrets: new (
    store: {
      get<T>(key: string): T | undefined;
      set?(key: string, value: unknown): Promise<void>;
    },
    options?: {
      showWarningMessage?: (message: string) => Promise<void> | void;
    },
  ) => {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
  __resetKeychainStateForTests: () => void;
  KEYCHAIN_DENIED_WARNING_MESSAGE: string;
}

async function loadElectronSecrets(): Promise<ElectronSecretsModule> {
  return (await import(
    repoPath('packages/desktop/src/main/platform/electronSecrets.ts')
  )) as ElectronSecretsModule;
}

function loadRendererMain(): string {
  return readFileSync(
    repoPath('packages/desktop/src/renderer/main.ts'),
    'utf8',
  );
}

describe('ElectronSecrets keychain-denial bootstrap recovery', () => {
  beforeEach(() => {
    delete process.env.SOME_TEST_KEY;
  });

  afterEach(async () => {
    const mod = await loadElectronSecrets();
    mod.__resetKeychainStateForTests();
    vi.restoreAllMocks();
  });

  it('returns undefined (instead of throwing) when safeStorage.decryptString throws', async () => {
    const electron = (await import('electron')) as unknown as {
      safeStorage: {
        decryptString: (value: Buffer) => string;
        encryptString: (value: string) => Buffer;
        isEncryptionAvailable: () => boolean;
      };
    };
    // The keychain denial path: decryptString rejects after the user clicks
    // "Don't Allow" or the encryption key is otherwise unavailable. The bug
    // we are guarding against is this throw bubbling up into the renderer
    // bootstrap and producing a blank window.
    const decryptSpy = vi
      .spyOn(electron.safeStorage, 'decryptString')
      .mockImplementation(() => {
        throw new Error('User denied keychain access');
      });

    const { ElectronSecrets } = await loadElectronSecrets();
    const warnings: string[] = [];
    const fakeStore = {
      get: <T,>(_key: string): T | undefined =>
        ({
          encrypted: true,
          value: Buffer.from('encrypted:value').toString('base64'),
        }) as unknown as T,
    };
    const secrets = new ElectronSecrets(fakeStore, {
      showWarningMessage: (message: string) => {
        warnings.push(message);
      },
    });

    const value = await secrets.get('texra.api.openai');

    expect(value).toBeUndefined();
    expect(decryptSpy).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('keychain');
  });

  it('only surfaces the keychain-denied warning once per ElectronSecrets instance', async () => {
    const electron = (await import('electron')) as unknown as {
      safeStorage: { decryptString: (value: Buffer) => string };
    };
    vi.spyOn(electron.safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('denied');
    });
    const { ElectronSecrets } = await loadElectronSecrets();
    const warnings: string[] = [];
    const fakeStore = {
      get: <T,>(_key: string): T | undefined =>
        ({
          encrypted: true,
          value: Buffer.from('encrypted:value').toString('base64'),
        }) as unknown as T,
    };
    const secrets = new ElectronSecrets(fakeStore, {
      showWarningMessage: (message: string) => {
        warnings.push(message);
      },
    });

    await secrets.get('a');
    await secrets.get('b');
    await secrets.get('c');

    expect(warnings).toHaveLength(1);
  });
});

describe('desktop renderer bootstrap fallback', () => {
  it('wraps the initial render in a try/catch with a fallback UI', () => {
    const source = loadRendererMain();
    expect(source).toContain('renderBootstrapFallback');
    expect(source).toContain('try {');
    expect(source).toContain('renderLogViewer();');
    expect(source).toContain('rerenderShell();');
    expect(source).toContain('catch (error)');
    expect(source).toContain('bootstrapFailed');
  });

  it('renders a Reload control and a "continue without saved secrets" affordance', () => {
    const source = loadRendererMain();
    expect(source).toContain('Reload');
    expect(source).toContain('Continue without saved secrets');
    // Use Lit html for the fallback so we do not pull in another component.
    expect(source).toContain('html`');
    expect(source).toContain('window.location.reload');
  });

  it('skips IPC requests and DOM-dependent setup when bootstrap fails', () => {
    const source = loadRendererMain();
    // The DOM-dependent setup (event wiring + onboarding REQUEST_STATE +
    // WEBVIEW_READY emission) must be gated behind !bootstrapFailed so it
    // cannot throw on top of the already-rendered fallback UI. (The
    // workspace-explorer sidebar — and its REQUEST_TREE call — was removed
    // in PRD PR 3; only the onboarding state + ready emission remain.)
    expect(source).toContain('if (!bootstrapFailed) {');
    expect(source).toContain('DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE');
    expect(source).toContain('postWebviewReady');
  });
});

describe('TEXRA_DISABLE_KEYCHAIN env var (Playwright e2e shim)', () => {
  beforeEach(() => {
    delete process.env.TEXRA_DISABLE_KEYCHAIN;
  });

  afterEach(async () => {
    delete process.env.TEXRA_DISABLE_KEYCHAIN;
    const mod = await loadElectronSecrets();
    mod.__resetKeychainStateForTests();
    vi.restoreAllMocks();
  });

  it('reports unavailable storage mode without touching safeStorage', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const electron = (await import('electron')) as unknown as {
      safeStorage: { isEncryptionAvailable: () => boolean };
    };
    const isAvailableSpy = vi.spyOn(
      electron.safeStorage,
      'isEncryptionAvailable',
    );

    const mod = (await import(
      repoPath('packages/desktop/src/main/platform/electronSecrets.ts')
    )) as ElectronSecretsModule & {
      getSecretStorageMode: () => 'encrypted' | 'basic_text' | 'unavailable';
    };

    expect(mod.getSecretStorageMode()).toBe('unavailable');
    expect(isAvailableSpy).not.toHaveBeenCalled();
  });

  it('ElectronSecrets.get() returns undefined without calling safeStorage', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const electron = (await import('electron')) as unknown as {
      safeStorage: { decryptString: (value: Buffer) => string };
    };
    const decryptSpy = vi.spyOn(electron.safeStorage, 'decryptString');

    const { ElectronSecrets } = await loadElectronSecrets();
    const fakeStore = {
      get<T>(_key: string): T | undefined {
        return {
          encrypted: true,
          value: Buffer.from('encrypted:value').toString('base64'),
        } as unknown as T;
      },
    };
    const secrets = new ElectronSecrets(fakeStore);

    expect(await secrets.get('any.key')).toBeUndefined();
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('ElectronSecrets.get() still honors process.env overrides above the env-disabled shim', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    process.env.SOME_TEST_KEY = 'from-env';

    const { ElectronSecrets } = await loadElectronSecrets();
    const fakeStore = {
      get<T>(_key: string): T | undefined {
        return undefined;
      },
    };
    const secrets = new ElectronSecrets(fakeStore);

    expect(await secrets.get('SOME_TEST_KEY')).toBe('from-env');
    delete process.env.SOME_TEST_KEY;
  });

  it('ElectronSecrets.set() silently no-ops instead of throwing', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const electron = (await import('electron')) as unknown as {
      safeStorage: { encryptString: (value: string) => Buffer };
    };
    const encryptSpy = vi.spyOn(electron.safeStorage, 'encryptString');

    const { ElectronSecrets } = await loadElectronSecrets();
    const writes: Array<[string, unknown]> = [];
    const fakeStore = {
      get<T>(_key: string): T | undefined {
        return undefined;
      },
      async set(key: string, value: unknown): Promise<void> {
        writes.push([key, value]);
      },
    };
    const secrets = new ElectronSecrets(fakeStore);

    await expect(secrets.set('a', 'b')).resolves.toBeUndefined();
    expect(writes).toEqual([]);
    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('accepts the literal string "true" in addition to "1"', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = 'true';
    const mod = (await import(
      repoPath('packages/desktop/src/main/platform/electronSecrets.ts')
    )) as ElectronSecretsModule & {
      getSecretStorageMode: () => 'encrypted' | 'basic_text' | 'unavailable';
    };
    expect(mod.getSecretStorageMode()).toBe('unavailable');
  });
});

describe('desktop main process keychain access', () => {
  it('does not force a keychain prewarm during startup', () => {
    const source = readFileSync(
      repoPath('packages/desktop/src/main/index.ts'),
      'utf8',
    );
    expect(source).not.toContain('prewarmElectronKeychain');
    expect(source).not.toContain('safeStorage.encryptString');
  });
});
