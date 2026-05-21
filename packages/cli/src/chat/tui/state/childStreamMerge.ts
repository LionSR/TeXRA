// Local imports - shared schemas
import type { ActiveChildInfo } from '@shared/schemas';

export function mergeChildStreams(
  current: readonly ActiveChildInfo[],
  next: readonly ActiveChildInfo[],
): readonly ActiveChildInfo[] {
  const byStream = new Map<string, ActiveChildInfo>();
  for (const child of [...current, ...next]) {
    const key = child.childStreamId ?? child.executionId;
    byStream.set(key, child);
  }
  return [...byStream.values()];
}
