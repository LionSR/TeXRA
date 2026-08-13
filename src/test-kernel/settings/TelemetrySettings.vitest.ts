import { describe, expect, it } from 'vitest';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { buildTelemetrySettingsMessage } from '@shared/settingsView/handlers/telemetrySettingsHandlers';
import { FakeConfigProvider } from '@test/support/FakePlatform';

describe('telemetry settings message', () => {
  it('uses the schema default when no value is stored', () => {
    expect(buildTelemetrySettingsMessage(new FakeConfigProvider())).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS,
      enabled: true,
    });
  });

  it('fails closed when stored telemetry configuration is malformed', async () => {
    const config = new FakeConfigProvider();
    await config.update('texra.telemetry.enabled', 'false', 'global');

    expect(buildTelemetrySettingsMessage(config)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS,
      enabled: false,
    });
  });
});
