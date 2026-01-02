// Local imports - agent
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';
// Local imports - tools
import { type ToolResult } from '@tools/result';

export function recordToolFileRead(path: string): void {
  const context = getCurrentToolFileInteractionContext();
  if (!context) return;
  context.tracker.recordRead(path);
}

export function requireFileReadForEdit(
  path: string,
  exists: boolean,
): ToolResult | null {
  const context = getCurrentToolFileInteractionContext();
  if (!context || !exists) {
    return null;
  }

  if (context.tracker.hasRead(path)) {
    return null;
  }

  return {
    summary: `Read ${path} before editing`,
    output:
      'Edits to existing files require a prior read in this session. Please call read_file first.',
    isError: true,
    diagnostics: { reason: 'unread-file', path },
  };
}
