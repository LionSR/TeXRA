// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ToolCall } from '@agent/runtime/ToolCall';
import { type ToolResult } from '@shared/schemas';
import { errorResult } from '@tools/core/result';

export const recordToolFileRead = Effect.fn('fileInteractions.recordRead')(
  function* (path: string): Effect.fn.Return<void, never, ToolCall> {
    const call = yield* ToolCall;
    call.tracker.recordRead(path);
  },
);

export const requireFileReadForEdit = Effect.fn(
  'fileInteractions.requireReadForEdit',
)(function* (
  path: string,
  exists: boolean,
  errorMessage?: string,
): Effect.fn.Return<ToolResult | null, never, ToolCall> {
  const call = yield* ToolCall;
  if (!exists || call.tracker.hasRead(path)) {
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
});
