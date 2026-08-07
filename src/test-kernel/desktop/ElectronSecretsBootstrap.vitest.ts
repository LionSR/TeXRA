// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import type { ElectronSecrets as ElectronSecretsInstance } from '@desktop/main/platform/electronSecrets';
import type { JsonStore } from '@platform/defaults/jsonStore';

// Local imports - test support
import { repoPath } from './desktopTestPaths.ts';
import { loadSourceModule } from './loadSourceModule.ts';

interface SafeStorageMethods {
  decryptString: (value: Buffer) => string;
  encryptString: (value: string) => Buffer;
  isEncryptionAvailable: () => boolean;
}

function loadElectronSecrets(): Promise<
  typeof import('@desktop/main/platform/electronSecrets')
> {
  return loadSourceModule('@desktop/main/platform/electronSecrets');
}

async function safeStorageStub(): Promise<SafeStorageMethods> {
  const electron = (await import('electron')) as unknown as {
    safeStorage: SafeStorageMethods;
  };
  return electron.safeStorage;
}

async function resetKeychainState(): Promise<void> {
  const mod = await loadElectronSecrets();
  mod.__resetKeychainStateForTests();
  vi.restoreAllMocks();
}

/** A store whose reads are driven by the test, standing in for a JsonStore. */
function stubStore(store: {
  get<T>(key: string): T | undefined;
  set?(key: string, value: unknown): Promise<void>;
}): JsonStore {
  return store as unknown as JsonStore;
}

// A persisted store record for one encrypted secret, as ElectronSecrets.set() writes it.
function encryptedRecordStore(): JsonStore {
  return stubStore({
    get<T>(_key: string): T | undefined {
      return {
        encrypted: true,
        value: Buffer.from('encrypted:value').toString('base64'),
      } as unknown as T;
    },
  });
}

/** A store with no persisted records. */
function emptyRecordStore(): JsonStore {
  return stubStore({
    get<T>(_key: string): T | undefined {
      return undefined;
    },
  });
}

/** An ElectronSecrets over one encrypted record, with its warnings captured. */
async function secretsWithWarningLog(): Promise<{
  secrets: ElectronSecretsInstance;
  warnings: string[];
}> {
  const { ElectronSecrets } = await loadElectronSecrets();
  const warnings: string[] = [];
  const secrets = new ElectronSecrets(encryptedRecordStore(), {
    showWarningMessage: (message: string) => {
      warnings.push(message);
    },
  });
  return { secrets, warnings };
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

  afterEach(resetKeychainState);

  it('returns undefined (instead of throwing) when safeStorage.decryptString throws', async () => {
    // The keychain denial path: decryptString rejects after the user clicks
    // "Don't Allow" or the encryption key is otherwise unavailable. The bug
    // we are guarding against is this throw bubbling up into the renderer
    // bootstrap and producing a blank window.
    const decryptSpy = vi
      .spyOn(await safeStorageStub(), 'decryptString')
      .mockImplementation(() => {
        throw new Error('User denied keychain access');
      });

    const { secrets, warnings } = await secretsWithWarningLog();

    const value = await secrets.get('texra.api.openai');

    expect(value).toBeUndefined();
    expect(decryptSpy).toHaveBeenCalledOnce();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('keychain');
  });

  it('only surfaces the keychain-denied warning once per ElectronSecrets instance', async () => {
    const decryptSpy = vi
      .spyOn(await safeStorageStub(), 'decryptString')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const { secrets, warnings } = await secretsWithWarningLog();

    await secrets.get('a');
    await secrets.get('b');
    await secrets.get('c');

    expect(warnings).toHaveLength(1);
    expect(decryptSpy).toHaveBeenCalledOnce();
  });
});

describe('desktop renderer bootstrap fallback', () => {
  it('wraps the initial render in a try/catch with a fallback UI', () => {
    const source = loadRendererMain();
    expect(source).toContain('renderBootstrapFallback');
    // The initial render (rerender + shell) must sit inside the bootstrap
    // try/catch whose handler flags the failure and renders the fallback —
    // a bare `try {`/`catch (error)` containment check would match almost
    // any source, so pin the whole guard structurally.
    expect(source).toMatch(
      /try \{\s*logsController\.rerenderViewer\(\);\s*rerenderShell\(\);[\s\S]*?\} catch \(error\) \{\s*bootstrapFailed = true;[\s\S]*?renderBootstrapFallback\(error\);/,
    );
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
    // cannot throw on top of the already-rendered fallback UI.
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
    await resetKeychainState();
  });

  it('reports unavailable storage mode without touching safeStorage', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const isAvailableSpy = vi.spyOn(
      await safeStorageStub(),
      'isEncryptionAvailable',
    );

    const mod = await loadElectronSecrets();

    expect(mod.getSecretStorageMode()).toBe('unavailable');
    expect(isAvailableSpy).not.toHaveBeenCalled();
  });

  it('ElectronSecrets.get() returns undefined without calling safeStorage', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const decryptSpy = vi.spyOn(await safeStorageStub(), 'decryptString');

    const { ElectronSecrets } = await loadElectronSecrets();
    const secrets = new ElectronSecrets(encryptedRecordStore());

    expect(await secrets.get('any.key')).toBeUndefined();
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('ElectronSecrets.get() still honors process.env overrides above the env-disabled shim', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    process.env.SOME_TEST_KEY = 'from-env';

    const { ElectronSecrets } = await loadElectronSecrets();
    const secrets = new ElectronSecrets(emptyRecordStore());

    expect(await secrets.get('SOME_TEST_KEY')).toBe('from-env');
    delete process.env.SOME_TEST_KEY;
  });

  it('ElectronSecrets.set() silently no-ops instead of throwing', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = '1';
    const encryptSpy = vi.spyOn(await safeStorageStub(), 'encryptString');

    const { ElectronSecrets } = await loadElectronSecrets();
    const writes: Array<[string, unknown]> = [];
    const secrets = new ElectronSecrets(
      stubStore({
        get<T>(_key: string): T | undefined {
          return undefined;
        },
        async set(key: string, value: unknown): Promise<void> {
          writes.push([key, value]);
        },
      }),
    );

    await expect(secrets.set('a', 'b')).resolves.toBeUndefined();
    expect(writes).toEqual([]);
    expect(encryptSpy).not.toHaveBeenCalled();
  });

  it('accepts the literal string "true" in addition to "1"', async () => {
    process.env.TEXRA_DISABLE_KEYCHAIN = 'true';
    const mod = await loadElectronSecrets();
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
    expect(source).toContain("webContents.once('did-finish-load'");
  });
});
