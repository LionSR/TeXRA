/**
 * Every host's run list shows the project's agent first, marked: the GUI's
 * list over the session view's order, the CLI's history and `/resume` over
 * the run listing. Which run it is comes from the host (`HostSnapshot.agent`,
 * `projectAgent.ts`); this is the one ordering they share.
 */
import type { RunId } from '@texra-ai/worldline/schemas';

/** `items` with the project's agent moved to the front; the same array
 *  when it is already first or not listed. */
export function projectAgentFirst<T>(
  items: readonly T[],
  idOf: (item: T) => RunId,
  agent: RunId | null,
): readonly T[] {
  if (agent === null) return items;
  const at = items.findIndex((item) => idOf(item) === agent);
  if (at <= 0) return items;
  return [
    ...items.slice(at, at + 1),
    ...items.slice(0, at),
    ...items.slice(at + 1),
  ];
}
