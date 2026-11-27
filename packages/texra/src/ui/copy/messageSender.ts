/**
 * Who a received message is from, in the words every host shows above it:
 * a message a run took from another run, from a host's notice or from its
 * own earlier note is drawn as received, never as the person's own.
 */
import type { MessageSender } from '@texra-ai/worldline/transcript';

/** The line a received message is headed by. */
export function messageSenderLabel(sender: MessageSender): string {
  switch (sender.kind) {
    case 'run':
      // An unnamed sender may be an agent, a command or a script.
      return sender.label ?? 'Report';
    case 'notification':
      return sender.source ? `Notice · ${sender.source}` : 'Notice';
    case 'self':
      return 'Note to self';
  }
}
