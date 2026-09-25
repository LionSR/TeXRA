// Third-party imports
import { Effect } from 'effect';

// Local imports
import { ToolCall } from '@agent/runtime/ToolCall';
import { type ToolResult } from '@shared/schemas';
import { errorResult } from '@tools/core/result';

export const recordToolFileRead = Effect.fn('fileInteractions.recordRead')(
  function* (path: string): Effect.fn.Return<void, never, ToolCall> {
    const call = yield* ToolCall;
    call.tracker?.recordRead(path);
  },
);

export const requireFileReadForEdit = Effect.fn(
  'fileInteractions.requireReadForEdit',
)(function* (
  path: string,
  exists: boolean,
  errorMessage?: string,
  /** How the card names the file; the tracker keys on `path`. */
  displayPath: string = path,
): Effect.fn.Return<ToolResult | null, never, ToolCall> {
  const call = yield* ToolCall;
  if (!exists || call.tracker?.hasRead(path)) {
    return null;
  }
  return errorResult(
    errorMessage ??
      'Edits to existing files require a prior read in this session. Please call read_file first.',
    {
      // Not "Read …": the card would read as a read_file call.
      summary: `Not edited: ${displayPath} was not read first`,
      diagnostics: { reason: 'unread-file', path },
    },
  );
});
