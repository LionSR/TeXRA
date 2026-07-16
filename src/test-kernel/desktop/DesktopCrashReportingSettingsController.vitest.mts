// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop crash reporting
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import { DefaultDesktopCrashReportingSettingsController } from '@desktop/main/desktopCrashReportingSettingsController';
import { DESKTOP_CRASH_REPORTING_DSN_SECRET } from '@desktop/main/desktopCrashReporting';

// Local imports - shared settings
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { assertSupported } from '@shared/utils/dispatcher';

type ControllerOptions = ConstructorParameters<
  typeof DefaultDesktopCrashReportingSettingsController
>[0];

function createFixture(overrides: Partial<ControllerOptions> = {}) {
  const posted: unknown[] = [];
  const state = overrides.state ?? new FakeStateStore();
  const memorySecrets = new FakeSecrets();
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
    const state = new FakeStateStore({
      [GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED]: true,
    });
    const secrets = new FakeSecrets({
      [DESKTOP_CRASH_REPORTING_DSN_SECRET]: 'https://example.invalid/1',
    });
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
    expect(await memorySecrets.listStoredKeys()).toEqual([]);
    expect(initialize).not.toHaveBeenCalled();
    expect(posted).toEqual([]);
  });

  it('deletes a stored DSN when the prompt returns a blank value', async () => {
    const state = new FakeStateStore({
      [GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED]: true,
    });
    const secrets = new FakeSecrets({
      [DESKTOP_CRASH_REPORTING_DSN_SECRET]: 'https://example.invalid/old',
    });
    const { controller, initialize, posted } = createFixture({
      state,
      secrets,
      prompt: { input: async () => '   ' },
    });

    await assertSupported(controller.actions.setDsn)();

    expect(
      await secrets.get(DESKTOP_CRASH_REPORTING_DSN_SECRET),
    ).toBeUndefined();
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
    const state = new FakeStateStore({
      [GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED]: true,
    });
    const { controller, initialize, memorySecrets, posted } = createFixture({
      state,
      prompt: { input: async () => ' https://example.invalid/new ' },
    });

    await assertSupported(controller.actions.setDsn)();

    expect(await memorySecrets.get(DESKTOP_CRASH_REPORTING_DSN_SECRET)).toBe(
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
    const state = new FakeStateStore();
    const secrets = new FakeSecrets();
    const { controller, initialize, posted } = createFixture({
      state,
      secrets,
    });

    await assertSupported(controller.actions.setEnabled)(true);

    expect(state.get(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED)).toBe(
      true,
    );
    expect(initialize).not.toHaveBeenCalled();

    await secrets.set(
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
