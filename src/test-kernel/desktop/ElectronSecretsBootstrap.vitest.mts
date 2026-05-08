// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - test support
import { repoPath } from './desktopTestPaths.mjs';

interface ElectronSecretsModule {
  ElectronSecrets: new (
    store: { get<T>(key: string): T | undefined },
    options?: {
      showWarningMessage?: (message: string) => Promise<void> | void;
    },
  ) => {
    get(key: string): Promise<string | undefined>;
  };
  prewarmElectronKeychain: () => Promise<boolean>;
  __resetKeychainPrewarmedForTests: () => void;
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
    mod.__resetKeychainPrewarmedForTests();
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

  it('prewarmElectronKeychain returns true when safeStorage encrypts cleanly', async () => {
    const { prewarmElectronKeychain, __resetKeychainPrewarmedForTests } =
      await loadElectronSecrets();
    __resetKeychainPrewarmedForTests();

    expect(await prewarmElectronKeychain()).toBe(true);
    // Idempotent — second call short-circuits.
    expect(await prewarmElectronKeychain()).toBe(true);
  });

  it('prewarmElectronKeychain returns false when safeStorage is unavailable', async () => {
    const electron = (await import('electron')) as unknown as {
      safeStorage: { isEncryptionAvailable: () => boolean };
    };
    vi.spyOn(electron.safeStorage, 'isEncryptionAvailable').mockReturnValue(
      false,
    );
    const { prewarmElectronKeychain, __resetKeychainPrewarmedForTests } =
      await loadElectronSecrets();
    __resetKeychainPrewarmedForTests();

    expect(await prewarmElectronKeychain()).toBe(false);
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
    // requestWorkspaceTree() and the onboarding REQUEST_STATE post must be
    // gated behind !bootstrapFailed so they cannot throw on top of the
    // already-rendered fallback UI.
    expect(source).toContain('if (!bootstrapFailed) {');
    expect(source).toContain('requestWorkspaceTree();');
  });
});

describe('desktop main process keychain prewarm', () => {
  it('calls prewarmElectronKeychain immediately after app.whenReady()', () => {
    const source = readFileSync(
      repoPath('packages/desktop/src/main/index.ts'),
      'utf8',
    );
    expect(source).toContain('prewarmElectronKeychain');
    // The prewarm must run BEFORE initializeElectronPlatform — that is the
    // function that constructs ElectronSecrets and starts the chain that
    // eventually triggers crash-reporting / auth secret reads.
    const prewarmIndex = source.indexOf('await prewarmElectronKeychain()');
    const initIndex = source.indexOf('await initializeElectronPlatform(');
    expect(prewarmIndex).toBeGreaterThan(0);
    expect(initIndex).toBeGreaterThan(prewarmIndex);
  });
});
