// Local imports
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

// Local file imports
import {
  getDesktopCrashReportingStatus,
  setDesktopCrashReportingDsn,
  setDesktopCrashReportingEnabled,
} from './desktopCrashReporting.js';

interface DesktopCrashReportingSettingsControllerOptions {
  readonly state: StateStore;
  readonly secrets: PlatformSecrets;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly prompt: {
    input(input: {
      title: string;
      prompt: string;
    }): Promise<string | undefined>;
  };
  readonly initialization: {
    initialize(): Promise<void>;
  };
}

export interface DesktopCrashReportingSettingsController {
  readonly actions: SettingsViewCommandActions['desktopCrashReporting'];
  postStartupData(): Promise<void>;
}

/** Owns desktop crash-reporting settings state and renderer updates. */
export class DefaultDesktopCrashReportingSettingsController implements DesktopCrashReportingSettingsController {
  readonly actions: SettingsViewCommandActions['desktopCrashReporting'];

  constructor(
    private readonly options: DesktopCrashReportingSettingsControllerOptions,
  ) {
    this.actions = {
      get: () => this.postStatus(),
      setEnabled: (enabled) => this.setEnabled(enabled),
      setDsn: () => this.promptForDsn(),
    };
  }

  async postStartupData(): Promise<void> {
    await this.postStatus();
  }

  private async postStatus(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(
      this.options.state,
      this.options.secrets,
    );
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      ...status,
    });
  }

  private async finishSettingsChange(): Promise<void> {
    const status = await getDesktopCrashReportingStatus(
      this.options.state,
      this.options.secrets,
    );
    if (status.enabled && status.configured) {
      await this.options.initialization.initialize();
    }
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_DESKTOP_CRASH_REPORTING,
      ...status,
    });
  }

  private async setEnabled(enabled: boolean): Promise<void> {
    await setDesktopCrashReportingEnabled(this.options.state, enabled);
    await this.finishSettingsChange();
  }

  private async promptForDsn(): Promise<void> {
    const dsn = await this.options.prompt.input({
      title: 'Set Sentry DSN',
      prompt: 'Enter the Sentry DSN for opt-in desktop crash reports',
    });
    if (dsn == null) return;
    await setDesktopCrashReportingDsn(this.options.secrets, dsn);
    await this.finishSettingsChange();
  }
}
