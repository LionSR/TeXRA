import {
  selectAutoOpenFinalOutput,
  type RunAgentOptions,
  type RunAgentRequest,
  type SessionHandle,
} from '@agent/runtime';
import type { RequestOpenFilePayload } from '@shared/schemas';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import type { RegisteredToolName } from '@tools/registry';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';

export const DESKTOP_UNAVAILABLE_TOOLS: readonly RegisteredToolName[] = [
  ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
  'inline_comment',
  DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
];

export interface DesktopAgentLaunchContext {
  readonly session: SessionHandle;
  /** Resume-only canonical admission checked under the execution lease lock. */
  readonly canAcquireResumeLease?: () => boolean | Promise<boolean>;
}

export type DesktopAgentLaunchOptions = Pick<
  RunAgentOptions,
  | 'modelHandlerCompatibilityKey'
  | 'preferHelperModel'
  | 'onRun'
  | 'suppressErrorNotification'
>;

/** Start a desktop run with process-owned dependencies only. */
export async function launchDesktopAgent(
  request: RunAgentRequest,
  context: DesktopAgentLaunchContext,
  options: DesktopAgentLaunchOptions = {},
): Promise<void> {
  const { runAgent } = await import('@agent/runtime');
  await runAgent(request, {
    session: context.session,
    runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
    modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
    ...(options.preferHelperModel && { preferHelperModel: true }),
    onRun: options.onRun,
    suppressErrorNotification: options.suppressErrorNotification,
    ...(context.canAcquireResumeLease && {
      canAcquireResumeLease: context.canAcquireResumeLease,
    }),
    openWorkflowOutput: async (result) => {
      const output = selectAutoOpenFinalOutput(result);
      if (!output) return;
      let location: RequestOpenFilePayload['location'];
      if (output.location === 'workspace') {
        location = createWorkspaceLocation(
          output.absolutePath,
          output.relativePath,
        );
      } else if (output.location === 'runStorage') {
        location = createRunStorageLocation(
          output.absolutePath,
          output.relativePath,
          result.executionId,
        );
      } else {
        location = createExternalLocation(output.absolutePath);
      }
      context.session.interactions.emit(
        'requestOpenFile',
        { location, preserveFocus: false },
        { replayWhenAttached: true },
      );
    },
  });
}
