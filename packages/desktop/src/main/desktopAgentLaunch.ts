// Agent imports
import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ModelHandlerCompatibilityKey } from '@agent/runtime/modelHandlerCompatibilityKey';
import { selectAutoOpenFinalOutput } from '@agent/runtime/selectAutoOpenFinalOutput';

// Shared and tool imports
import type { RequestOpenFilePayload } from '@shared/schemas';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import type { RegisteredToolName } from '@tools/registry';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

export const DESKTOP_UNAVAILABLE_TOOLS: readonly RegisteredToolName[] = [
  ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
  'inline_comment',
  DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
];

export interface DesktopAgentLaunchContext {
  readonly ready: Promise<void>;
  readonly session: SessionHandle;
  /** Resume-only canonical admission checked under the execution lease lock. */
  readonly canAcquireResumeLease?: () => boolean;
}

export interface DesktopAgentLaunchOptions {
  readonly modelHandlerCompatibilityKey?: ModelHandlerCompatibilityKey | null;
  /** Reports that the run lifecycle now owns terminal error presentation. */
  readonly onLifecycleStart?: () => void;
}

/** Start a desktop run with process-owned dependencies only. */
export async function launchDesktopAgent(
  request: ValidatedExecutionRequest,
  context: DesktopAgentLaunchContext,
  options: DesktopAgentLaunchOptions = {},
): Promise<void> {
  await context.ready;
  const { runAgent } = await import('@agent/runtime/runAgent');
  const runtimeHost = context.session.interactions;
  await runAgent(request, {
    runtimeHost,
    session: context.session,
    runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
    modelHandlerCompatibilityKey: options.modelHandlerCompatibilityKey,
    onRun: options.onLifecycleStart,
    ...(context.canAcquireResumeLease && {
      canAcquireResumeLease: context.canAcquireResumeLease,
    }),
    openWorkflowOutput: async (result) => {
      const output = selectAutoOpenFinalOutput(result);
      if (!output) return;
      let location: RequestOpenFilePayload['location'];
      if (output.location === 'workspace') {
        location = {
          kind: 'workspace',
          absolutePath: output.absolutePath,
          relativePath: output.relativePath,
        };
      } else if (output.location === 'runStorage') {
        location = {
          kind: 'runStorage',
          absolutePath: output.absolutePath,
          relativePath: output.relativePath,
          executionId: result.executionId,
        };
      } else {
        location = { kind: 'external', absolutePath: output.absolutePath };
      }
      runtimeHost.emit(
        'requestOpenFile',
        {
          location,
          preserveFocus: false,
        },
        { replayWhenAttached: true },
      );
    },
  });
}
