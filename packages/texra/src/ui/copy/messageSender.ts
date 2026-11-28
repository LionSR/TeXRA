/**
 * Who a received message is from, in the words every host shows above it:
 * a message a run took from another run, from a host's notice or from its
 * own earlier note is drawn as received, never as the person's own.
 */
import { joinFacts } from '@texra-ai/worldline/schemas';
import type { MessageSender } from '@texra-ai/worldline/transcript';

/** The line a received message is headed by. */
export function messageSenderLabel(sender: MessageSender): string {
  switch (sender.kind) {
    case 'run':
      // An unnamed sender may be an agent, a command or a script, and what
      // it sent a report, a message or an instruction: its text says which.
      return sender.label ?? 'Message';
    case 'notification':
      return joinFacts(['Notice', sender.source]);
    case 'self':
      return 'Note to self';
  }
}

/** The line over a received message that reads `text`: its sender, or none
 *  when the message opens with that name already ("✓ drafter completed"). */
export function messageSenderHeading(
  sender: MessageSender,
  text: string,
): string | undefined {
  const label = messageSenderLabel(sender);
  const [head = ''] = text.trim().split('\n', 1);
  return head.includes(label) ? undefined : label;
}
