import type { ConfigProvider } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { UpdateTelemetrySettingsMessage } from '@shared/schemas';
import { CoreSettingsShape } from '@shared/schemas/coreSettings';

export function buildTelemetrySettingsMessage(
  config: ConfigProvider,
): UpdateTelemetrySettingsMessage {
  // This is a non-authoritative view snapshot. Runtime telemetry handling
  // independently fails closed, so malformed hand-edited config should show
  // the safe value without preventing the rest of the settings view loading.
  const schema = CoreSettingsShape.telemetry
    .unwrap()
    .shape.enabled.catch(false);
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_TELEMETRY_SETTINGS,
    enabled: schema.parse(
      config.inspect<unknown>('texra.telemetry.enabled')?.globalValue,
    ),
  };
}
