import type { StreamTabId } from '@shared/schemas';

interface DesktopResumeHandler {
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
  isResumeInFlight(streamId: StreamTabId): boolean;
}

let activeHandler: DesktopResumeHandler | undefined;

export function setDesktopAgentResumeHandler(
  handler: DesktopResumeHandler,
): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) {
      activeHandler = undefined;
    }
  };
}

export async function tryResumeDesktopStream(
  streamId: StreamTabId,
): Promise<boolean> {
  return activeHandler?.tryResumeStream(streamId) ?? false;
}

export function isDesktopResumeInFlight(streamId: StreamTabId): boolean {
  return activeHandler?.isResumeInFlight(streamId) ?? false;
}
