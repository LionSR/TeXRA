// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { DesktopAgentRunHost } from '@desktop/main/desktopAgentRunHost';
import type { DesktopProject } from '@desktop/main/desktopProjects';
import { testSessionOf } from '@test/support/testProcessRuntime';
import { projectDisplayOf } from '@texra/shared/session/hostSnapshot';

/** The no-workspace project over a session opened here. */
export function localTestProject(handle: SessionHandle): DesktopProject {
  return {
    key: handle.roots.storage,
    root: undefined,
    display: projectDisplayOf(handle.roots.storage, undefined),
    roots: handle.roots,
    session: testSessionOf(handle),
    present: testSessionOf(handle),
    dispose: () => Effect.void,
  };
}

export function createStubDesktopAgentRunHost(
  overrides: Partial<DesktopAgentRunHost> = {},
): DesktopAgentRunHost {
  return {
    openPath: () => Effect.void,
    openBuildDisplay: () => Effect.void,
    openDiff: () => Effect.void,
    confirmAcceptFile: () => Effect.succeed(true),
    showErrorMessage: () => Effect.void,
    showWarningMessage: () => Effect.void,
    showInfoMessage: () => Effect.void,
    showInstructionDialog: () => Effect.void,
    showErrorDialog: () => Effect.void,
    pickTranscriptExportFormat: () => Effect.succeed(undefined),
    ...overrides,
  };
}
