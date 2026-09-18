// Third-party imports
import { Effect } from 'effect';
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
    openPath: () => Effect.void,
    openBuildDisplay: () => Effect.void,
    openDiff: async () => undefined,
    confirmAcceptFile: async () => true,
    chooseTeamAvailability: () => Effect.succeed('cancel' as const),
    signInForRemoteAgentCatalog: () => Effect.succeed(false),
    showErrorMessage: () => Effect.void,
    showWarningMessage: () => Effect.void,
    showInfoMessage: () => Effect.void,
    showInstructionDialog: async () => undefined,
    showErrorDialog: async () => undefined,
    pickTranscriptExportFormat: () => Effect.succeed(undefined),
    ...overrides,
  };
}
