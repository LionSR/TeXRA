// CLI-native tool-call row.
//
// The renderer registry provides richer presentations for tools whose
// structure is worth preserving in a terminal. Everything else falls back to
// the compact universal row.

import { type NormalizedToolUse } from '@shared/schemas';

import {
  pickToolRenderer,
  toolUsePatchDisplayLines,
  UniversalToolRow,
} from './toolRenderers';

export { toolUsePatchDisplayLines };

export function ToolUseRow({
  toolUse,
}: {
  readonly toolUse: NormalizedToolUse;
}): React.JSX.Element {
  const renderer = pickToolRenderer(toolUse);
  return renderer ? (
    renderer.render(toolUse)
  ) : (
    <UniversalToolRow toolUse={toolUse} />
  );
}
