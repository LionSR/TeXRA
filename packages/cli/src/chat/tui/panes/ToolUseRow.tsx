// CLI-native tool-call row.
//
// The renderer registry provides richer presentations for tools whose
// structure is worth preserving in a terminal. Everything else falls back to
// the compact universal row.

import { memo } from 'react';
import { Box, Text } from 'ink';

import { type NormalizedToolUse } from '@shared/schemas';

import { fillRows } from '../render/terminalText';
import {
  pickToolRenderer,
  toolUseDisplayLines,
  UniversalToolRow,
} from './toolRenderers';
import { transcriptColumns } from './transcriptEntryLayout';

export function filledToolUseDisplayText(
  toolUse: NormalizedToolUse,
  width?: number,
): string {
  const cols = transcriptColumns(width);
  return fillRows(toolUseDisplayLines(toolUse).join('\n'), cols);
}

// Memoized: tool-use objects stay reference-identical across stream-sync
// ticks unless their status/result changed, so streaming text deltas skip
// re-rendering every settled tool row in the live region.
export const ToolUseRow = memo(function ToolUseRow({
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
    renderer.render(toolUse, width)
  ) : (
    <UniversalToolRow toolUse={toolUse} width={width} />
  );
});
