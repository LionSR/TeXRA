export function childStatusColor(status: string | undefined): string {
  if (!status) return 'green';
  if (status === 'waiting' || status === 'idle') return 'yellow';
  if (status === 'error' || status === 'stopped') return 'red';
  return 'green';
}

export function childStatusPulses(status: string | undefined): boolean {
  return !status || status === 'running' || status === 'in_progress';
}

export function childStatusMarker(
  status: string | undefined,
  pulseOn: boolean,
): string {
  if (!childStatusPulses(status)) return '● ';
  return pulseOn ? '● ' : '○ ';
}
