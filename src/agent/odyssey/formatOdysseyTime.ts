/**
 * Hour-aware formatting for Odyssey's `timeUsedMs` field. Shared between
 * the OdysseyTool's view-command output and the continuation prompt so
 * the same odyssey never shows two different durations.
 *
 * `@utils/core/stringCore.formatDuration` is the general repo helper but
 * doesn't roll minutes up to hours, which matters for multi-hour runs.
 */
export function formatOdysseyTime(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  if (hours > 0) return `${hours}h ${min}m`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}
