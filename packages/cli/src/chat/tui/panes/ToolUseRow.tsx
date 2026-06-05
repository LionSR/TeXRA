// CLI-native tool-call row.
//
// The renderer registry provides richer presentations for tools whose
// structure is worth preserving in a terminal. Everything else falls back to
// the compact universal row.

import { Box, Text } from 'ink';

import { type NormalizedToolUse } from '@shared/schemas';

import { fillRows } from '../render/terminalText';
import {
  pickToolRenderer,
  toolUseDisplayLines,
  UniversalToolRow,
} from './toolRenderers';

export function filledToolUseDisplayText(
  toolUse: NormalizedToolUse,
  width?: number,
): string {
  const cols = Math.max(1, Math.floor(width ?? 80));
  return fillRows(toolUseDisplayLines(toolUse).join('\n'), cols);
}

export function ToolUseRow({
  fillWidth,
  toolUse,
  width,
}: {
  readonly fillWidth?: boolean;
  readonly toolUse: NormalizedToolUse;
  readonly width?: number;
}): React.JSX.Element {
  if (fillWidth === true) {
    return (
      <Box flexDirection="column">
        <Text>{filledToolUseDisplayText(toolUse, width)}</Text>
      </Box>
    );
  }

  const renderer = pickToolRenderer(toolUse);
  return renderer ? (
    renderer.render(toolUse)
  ) : (
    <UniversalToolRow toolUse={toolUse} />
  );
}
