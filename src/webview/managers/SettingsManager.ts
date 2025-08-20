// Local imports - webview
import { safeExecuteCommand } from '@utils/system';

const CHANNEL = 'SettingsManager';

export class SettingsManager {
  async openSettings(): Promise<void> {
    await safeExecuteCommand(
      'workbench.action.openSettings',
      ['@ext:texra-ai.texra'],
      CHANNEL,
    );
  }

  async openAgentSettings(): Promise<void> {
    await safeExecuteCommand(
      'workbench.action.openSettings',
      ['@ext:texra-ai.texra agents'],
      CHANNEL,
    );
  }

  async openModelSettings(): Promise<void> {
    await safeExecuteCommand(
      'workbench.action.openSettings',
      ['@ext:texra-ai.texra models'],
      CHANNEL,
    );
  }
}
