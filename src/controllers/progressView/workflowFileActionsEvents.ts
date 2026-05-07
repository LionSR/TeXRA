// Local imports - event bus
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - utilities
import type { FileLocation } from '@utils/files';

export function emitAcceptedWorkspaceFile(location: FileLocation): void {
  if (location.kind === 'workspace') {
    bus.emit('workspaceFilesWritten', {
      absolutePaths: [location.absolutePath],
    });
  }
}
