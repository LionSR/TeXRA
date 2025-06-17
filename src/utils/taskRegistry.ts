const statuses = new Map<string, 'running' | 'stopped' | 'error'>();

export function getStreamStatus(
  stream: string,
): 'running' | 'stopped' | 'error' | undefined {
  return statuses.get(stream);
}

export function setStreamStatus(
  stream: string,
  status: 'running' | 'stopped' | 'error',
): void {
  statuses.set(stream, status);
}

export function clearStreamStatus(stream: string): void {
  statuses.delete(stream);
}
