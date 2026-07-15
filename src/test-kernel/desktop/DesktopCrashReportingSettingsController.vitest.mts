// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop crash reporting
import { DefaultDesktopCrashReportingSettingsController } from '@desktop/main/desktopCrashReportingSettingsController';
import { DESKTOP_CRASH_REPORTING_DSN_SECRET } from '@desktop/main/desktopCrashReporting';

// Local imports - shared settings
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertSupported } from '@shared/utils/dispatcher';

// Local imports - supporting types
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';

class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

class MemorySecrets implements PlatformSecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async getStored(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async listStoredKeys(): Promise<readonly string[]> {
    return [...this.values.keys()];
  }

  getEnv(): string | undefined {
    return undefined;
  }
}

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopCrashReportingSettingsController
>[0];

function createFixture(overrides: Partial<ControllerOptions> = {}) {
  const posted: unknown[] = [];
  const state = overrides.state ?? new MemoryStateStore();
  const memorySecrets = new MemorySecrets();
  const secrets = overrides.secrets ?? memorySecrets;
  const promptInput = vi.fn<ControllerOptions['prompt']['input']>(
    async () => undefined,
  );
  const initialize = vi.fn(async () => undefined);
  const controller = new DefaultDesktopCrashReportingSettingsController({
    state,
    secrets,
    renderer: { postToRenderer: (message) => posted.push(message) },
    prompt: { input: promptInput },
    initialization: { initialize },
    ...overrides,
  });

  return { controller, initialize, memorySecrets, posted };
}

describe('DefaultDesktopCrashReportingSettingsController', () => {
  it('posts the current status during startup', async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecrets();
    state.values.set(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED, true);
    secrets.values.set(
      DESKTOP_CRASH_REPORTING_DSN_SECRET,
      'https://example.invalid/1',
    );
    const { controller, posted } = createFixture({ state, secrets });

    await controller.postStartupData();

    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: true,
        configured: true,
      },
    ]);
  });

  it('leaves settings unchanged when DSN prompting is cancelled', async () => {
    const promptInput = vi.fn(async () => undefined);
    const { controller, initialize, memorySecrets, posted } = createFixture({
      prompt: { input: promptInput },
    });

    await assertSupported(controller.actions.setDsn)();

    expect(promptInput).toHaveBeenCalledWith({
      title: 'Set Sentry DSN',
      prompt: 'Enter the Sentry DSN for opt-in desktop crash reports',
    });
    expect(memorySecrets.values).toEqual(new Map());
    expect(initialize).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('deletes a stored DSN when the prompt returns a blank value', async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecrets();
    state.values.set(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED, true);
    secrets.values.set(
      DESKTOP_CRASH_REPORTING_DSN_SECRET,
      'https://example.invalid/old',
    );
    const { controller, initialize, posted } = createFixture({
      state,
      secrets,
      prompt: { input: async () => '   ' },
    });

    await assertSupported(controller.actions.setDsn)();

    expect(secrets.values.has(DESKTOP_CRASH_REPORTING_DSN_SECRET)).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: true,
        configured: false,
      },
    ]);
  });

  it('stores a trimmed nonblank DSN and initializes when enabled', async () => {
    const state = new MemoryStateStore();
    state.values.set(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED, true);
    const { controller, initialize, memorySecrets, posted } = createFixture({
      state,
      prompt: { input: async () => ' https://example.invalid/new ' },
    });

    await assertSupported(controller.actions.setDsn)();

    expect(memorySecrets.values.get(DESKTOP_CRASH_REPORTING_DSN_SECRET)).toBe(
      'https://example.invalid/new',
    );
    expect(initialize).toHaveBeenCalledOnce();
    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: true,
        configured: true,
      },
    ]);
  });

  it('initializes only when an enablement change leaves reporting ready', async () => {
    const state = new MemoryStateStore();
    const secrets = new MemorySecrets();
    const { controller, initialize, posted } = createFixture({
      state,
      secrets,
    });

    await assertSupported(controller.actions.setEnabled)(true);

    expect(
      state.values.get(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED),
    ).toBe(true);
    expect(initialize).not.toHaveBeenCalled();

    secrets.values.set(
      DESKTOP_CRASH_REPORTING_DSN_SECRET,
      'https://example.invalid/ready',
    );
    await assertSupported(controller.actions.setEnabled)(false);
    await assertSupported(controller.actions.setEnabled)(true);

    expect(initialize).toHaveBeenCalledOnce();
    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: true,
        configured: false,
      },
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: false,
        configured: true,
      },
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
        enabled: true,
        configured: true,
      },
    ]);
  });
});
