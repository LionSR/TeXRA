// Local imports - utils
import { safeExecuteCommand } from '@frontend/system';
import { SETTINGS_QUERY } from '@utils/config';

const CHANNEL = 'SettingsManager';

export class SettingsManager {
  async openSettings(query: string = SETTINGS_QUERY.EXTENSION): Promise<void> {
    await safeExecuteCommand('workbench.action.openSettings', [query], CHANNEL);
  }
}
