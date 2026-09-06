// Third-party imports
import { onTestFinished } from 'vitest';

// Local imports
import type { DesktopAgentExecutionHost } from '@desktop/main/desktopAgentExecutionHost';

export function disposeAfterTest<T extends { dispose(): void }>(value: T): T {
  onTestFinished(() => value.dispose());
  return value;
}

export function createStubDesktopAgentExecutionHost(
  overrides: Partial<DesktopAgentExecutionHost> = {},
): DesktopAgentExecutionHost {
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
    pickTranscriptExportFormat: async () => undefined,
    ...overrides,
  };
}
