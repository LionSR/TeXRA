// Local imports
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import { type ToolResult } from '@shared/schemas';
import { errorResult } from '@tools/core/result';

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
  return errorResult(
    errorMessage ??
      'Edits to existing files require a prior read in this session. Please call read_file first.',
    {
      summary: `Read ${path} before editing`,
      diagnostics: { reason: 'unread-file', path },
    },
  );
}
