import type { StreamTabId } from '@shared/schemas';

interface DesktopResumeHandler {
  tryResumeStream(streamId: StreamTabId): Promise<boolean>;
  isResumeInFlight(streamId: StreamTabId): boolean;
}

const registeredHandlers = new Set<DesktopResumeHandler>();

export function setDesktopAgentResumeHandler(
  handler: DesktopResumeHandler,
): () => void {
  registeredHandlers.add(handler);
  return () => {
    registeredHandlers.delete(handler);
  };
}

export async function tryResumeDesktopStream(
  streamId: StreamTabId,
): Promise<boolean> {
  for (const handler of [...registeredHandlers].toReversed()) {
    if (await handler.tryResumeStream(streamId)) return true;
  }
  return false;
}

export function isDesktopResumeInFlight(streamId: StreamTabId): boolean {
  return [...registeredHandlers].some((handler) =>
    handler.isResumeInFlight(streamId),
  );
}
