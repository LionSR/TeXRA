// Local imports - shared formatting
import { STATUS_DOT, TOKENS_GENERATED } from '@cli/tui/ui/glyphs';
import { REQUEST_NOUN } from '@ui/copy/requestCards';

import {
  type RequestKind,
  formatCompactTokenCount,
  formatResultCount,
  joinFacts,
} from '@texra-ai/worldline/schemas';

/** A steady marker, so list updates never animate the whole live region. */
export const CHILD_STATUS_MARKER = `${STATUS_DOT} `;

/** Terminal width below which the right-aligned metadata column is dropped
 *  and rows keep their inline elapsed, so identity is not crowded out. */
export const CHILD_ROW_METADATA_MIN_COLUMNS = 60;

/** Right-aligned metadata column for a child row: elapsed time, the number of
 *  tool calls the child has made, and its generated tokens so far (e.g.
 *  `2m 30s · 5 tool calls · ↓40k`); a subagent with no tool calls yet just
 *  shows elapsed/tokens.
 *  Output tokens are the "work produced" figure — deliberately not the
 *  context-fill number the status bar reports for the focused stream. */
export function childRowMetadataText({
  elapsed,
  outputTokens,
  toolCallCount,
}: {
  readonly elapsed: string | null | undefined;
  readonly outputTokens: number | undefined;
  readonly toolCallCount: number;
}): string | undefined {
  const toolCalls =
    toolCallCount > 0
      ? formatResultCount(toolCallCount, 'tool call')
      : undefined;
  const tokens =
    outputTokens !== undefined && outputTokens > 0
      ? `${TOKENS_GENERATED}${formatCompactTokenCount(outputTokens)}`
      : undefined;
  return joinFacts([elapsed, toolCalls, tokens]) || undefined;
}

/** Compact "waiting on what" display for a row. The first kind and overflow
 * count are separate so narrow layouts can preserve the actionable kind while
 * allowing the informational count to yield. */
export function pendingApprovalRowDisplay(
  kinds: readonly RequestKind[] | undefined,
):
  | { readonly label: string; readonly overflow: string | undefined }
  | undefined {
  const first = kinds?.[0];
  if (kinds === undefined || first === undefined) return undefined;
  return {
    label: REQUEST_NOUN[first],
    overflow: kinds.length > 1 ? `+${kinds.length - 1}` : undefined,
  };
}
