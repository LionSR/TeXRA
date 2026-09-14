// Third-party imports
import { onTestFinished } from 'vitest';

// Local imports
import type { DesktopAgentRunHost } from '@desktop/main/desktopAgentRunHost';

export function disposeAfterTest<T extends { dispose(): void }>(value: T): T {
  onTestFinished(() => value.dispose());
  return value;
}

export function createStubDesktopAgentRunHost(
  overrides: Partial<DesktopAgentRunHost> = {},
): DesktopAgentRunHost {
  return {
    openPath: async () => undefined,
    openBuildDisplay: async () => undefined,
    openDiff: async () => undefined,
    confirmAcceptFile: async () => true,
    chooseTeamAvailability: async () => 'cancel',
    signInForRemoteAgentCatalog: async () => false,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInfoMessage: async () => undefined,
    showInstructionDialog: async () => undefined,
    showErrorDialog: async () => undefined,
    pickTranscriptExportFormat: async () => undefined,
    ...overrides,
  };
}
