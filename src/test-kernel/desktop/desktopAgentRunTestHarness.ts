// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { DesktopAgentRunHost } from '@desktop/main/desktopAgentRunHost';

export function createStubDesktopAgentRunHost(
  overrides: Partial<DesktopAgentRunHost> = {},
): DesktopAgentRunHost {
  return {
    openPath: () => Effect.void,
    openBuildDisplay: () => Effect.void,
    openDiff: () => Effect.void,
    confirmAcceptFile: () => Effect.succeed(true),
    chooseTeamAvailability: () => Effect.succeed('cancel' as const),
    signInForRemoteAgentCatalog: () => Effect.succeed(false),
    showErrorMessage: () => Effect.void,
    showWarningMessage: () => Effect.void,
    showInfoMessage: () => Effect.void,
    showInstructionDialog: () => Effect.void,
    showErrorDialog: () => Effect.void,
    pickTranscriptExportFormat: () => Effect.succeed(undefined),
    ...overrides,
  };
}
