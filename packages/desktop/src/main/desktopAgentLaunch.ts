import {
  selectAutoOpenFinalOutput,
  type RunAgentOptions,
  type RunAgentRequest,
  type SessionHandle,
} from '@agent/runtime';
import { effectRuntime } from '@platform/processRuntime';
import type { RequestOpenFilePayload } from '@shared/schemas';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';

interface DesktopAgentLaunchContext {
  readonly session: SessionHandle;
}

export type DesktopAgentLaunchOptions = Pick<
  RunAgentOptions,
  | 'copilotRouteOverride'
  | 'modelCompatibilityKey'
  | 'preferHelperModel'
  | 'onRun'
  | 'onRunResolved'
>;

/** Start a desktop run; its awaiting host owns failure presentation. */
export async function launchDesktopAgent(
  request: RunAgentRequest,
  context: DesktopAgentLaunchContext,
  options: DesktopAgentLaunchOptions = {},
): Promise<void> {
  const [{ runAgent }, { getDefaultUnavailableToolNames }] = await Promise.all([
    import('@agent/runtime'),
    import('@tools/registry'),
  ]);
  await effectRuntime().runPromise(
    runAgent(request, {
      session: context.session,
      runtimeUnavailableTools: getDefaultUnavailableToolNames('desktop'),
      modelCompatibilityKey: options.modelCompatibilityKey,
      copilotRouteOverride: options.copilotRouteOverride,
      ...(options.preferHelperModel && { preferHelperModel: true }),
      onRun: options.onRun,
      onRunResolved: options.onRunResolved,
      suppressErrorNotification: true,
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
            result.runId,
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
    }),
  );
}
