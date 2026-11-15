import { pluralize } from '@texra-ai/harness/schemas';

/** The heading over the messages waiting for the run to take them, in every
 *  host: `Queued messages (2)`. */
export function queuedMessagesTitle(count: number): string {
  return `${pluralize(count, 'Queued message', 'Queued messages')} (${count})`;
}
