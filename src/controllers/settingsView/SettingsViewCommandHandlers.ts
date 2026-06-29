// Type imports
import type { SettingsViewInboundHandlerRegistry } from '@shared/schemas/settingsViewMessages';

type SettingsViewHandlerGroup = SettingsViewInboundHandlerRegistry | undefined;

export function createSettingsViewCommandHandlers(
  groups: Record<string, SettingsViewHandlerGroup>,
): SettingsViewInboundHandlerRegistry {
  const handlers: SettingsViewInboundHandlerRegistry = {};
  for (const group of Object.values(groups)) {
    Object.assign(handlers, group);
  }
  return handlers;
}
