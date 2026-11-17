// Third-party imports
import { Text } from 'ink';

// Local imports - shared formatting
import { TONE_PAINT } from '@cli/tui/ui/tonePaint';
import type { RunTone } from '@ui/copy/runStatus';

/** A one-line notice in its tone's marker and colour (`✗ Token rejected`),
 *  so a form's error or warning line reads like every other status row. */
export function ToneLine(props: {
  readonly tone: RunTone;
  readonly text: string;
}): React.JSX.Element {
  const paint = TONE_PAINT[props.tone];
  return <Text color={paint.color}>{`${paint.marker} ${props.text}`}</Text>;
}
