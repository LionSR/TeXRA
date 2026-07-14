// Desktop imports
import type { DesktopAgentSettingsController } from '@desktop/main/desktopAgentSettingsController';

// Shared imports
import { unsupported } from '@shared/utils/dispatcher';

const noOp = async (): Promise<void> => undefined;

export function createStubDesktopAgentSettingsController(): DesktopAgentSettingsController {
  return {
    actions: {
      setEnabled: noOp,
      setAllEnabled: noOp,
      openYaml: noOp,
      openFolder: noOp,
      create: unsupported(
        'Creating custom agents is not available in the desktop app yet.',
      ),
      customize: unsupported(
        'Customizing agents is not available in the desktop app yet.',
      ),
      deleteCustom: unsupported(
        'Deleting custom agents is not available in the desktop app yet.',
      ),
      revealFile: noOp,
      viewRemotePrompt: unsupported(
        'Viewing a remote agent prompt is not available in the desktop app yet.',
      ),
      setCustomDir: noOp,
      resetCustomDir: noOp,
      applyModePreset: noOp,
      saveModePreset: noOp,
      deleteModePreset: noOp,
    },
    postStartupData: noOp,
    refreshCatalogData: noOp,
  };
}
