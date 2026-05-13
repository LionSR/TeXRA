// Local imports - agent runtime
import {
  getAgentRuntimeHost,
  type AgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';

// Local imports - utilities
import type { FileLocation } from '@utils/files';

export function emitAcceptedWorkspaceFile(
  location: FileLocation,
  runtimeHost: AgentRuntimeHost = getAgentRuntimeHost(),
): void {
  if (location.kind === 'workspace') {
    runtimeHost.emit('workspaceFilesWritten', {
      absolutePaths: [location.absolutePath],
    });
  }
}
