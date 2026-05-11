// Local imports - agent
import { getCurrentToolCallContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - tools
import { type ToolResult } from '@tools/result';

export function recordToolFileRead(path: string): void {
  const context = getCurrentToolCallContext();
  if (!context) return;
  context.tracker.recordRead(path);
}

export function requireFileReadForEdit(
  path: string,
  exists: boolean,
  errorMessage?: string,
): ToolResult | null {
  const context = getCurrentToolCallContext();
  if (!context || !exists || context.tracker.hasRead(path)) {
    return null;
  }
  return {
    summary: `Read ${path} before editing`,
    output:
      errorMessage ??
      'Edits to existing files require a prior read in this session. Please call read_file first.',
    isError: true,
    diagnostics: { reason: 'unread-file', path },
  };
}
