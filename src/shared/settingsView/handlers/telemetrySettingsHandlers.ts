import type { ConfigProvider } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { UpdateTelemetrySettingsMessage } from '@shared/schemas';
import { CoreSettingsShape } from '@shared/schemas/coreSettings';

export function buildTelemetrySettingsMessage(
  config: ConfigProvider,
): UpdateTelemetrySettingsMessage {
  const schema = CoreSettingsShape.telemetry.unwrap().shape.enabled;
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS,
    enabled: schema.parse(
      config.inspect<unknown>('texra.telemetry.enabled')?.globalValue,
    ),
  };
}
