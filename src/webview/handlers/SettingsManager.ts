// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { safeExecuteCommand } from '@utils/system';

const CHANNEL = 'SettingsManager';

/**
 * Handles commands to open various settings pages.
 */
export class SettingsManager {
  async openExtensionSettings(): Promise<void> {
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
