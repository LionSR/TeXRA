export interface ServiceAnnouncement {
  version: string;
  socket: string;
  pid: number;
}

export function serviceLogPath(dataRoot: string): string;
export function serviceAnnouncements(log: string): ServiceAnnouncement[];
export function serviceRunning(pid: number): boolean;
export function servicePids(dataRoot: string): number[];
export function stopServices(
  dataRoot: string,
  options?: { timeoutMs?: number },
): void;
