// Shared ToolResult builders for the two dominant shapes, so call sites read
// as intent ("executed with this output") rather than object-literal
// boilerplate. Use these instead of hand-building a literal whenever the
// result carries only `output` and an optional `summary`; a result that also
// carries `diagnostics`, `files`, `edits`, `endTurn`, … stays an explicit
// literal, since those fields are the point of the call site.
//
// Host-agnostic, VS Code-free.

import type { ToolResult } from '@shared/schemas';

type ExecutedToolResult = Extract<ToolResult, { status: 'executed' }>;
type ErrorToolResult = Extract<ToolResult, { status: 'error' }>;

/** Build a `status: 'executed'` result. `summary` is omitted when not given,
 * matching the many call sites that only ever set `output`. */
export function executed(output: string, summary?: string): ExecutedToolResult {
  return {
    status: 'executed',
    output,
    ...(summary !== undefined && { summary }),
  };
}

/**
 * Build a `status: 'error'` result literal. Reserved for call sites that
 * cannot use the dominant `throw new ToolError(...)` convention (caught
 * centrally by `BaseTool.call`) — typically because the caller must keep
 * running after emitting a partial per-item error, or because a nested try/catch
 * would otherwise reformat the thrown message. Prefer `throw new ToolError(...)`
 * over this helper whenever the call site can support it.
 */
export function errorResult(
  error: string,
  extra?: Omit<ErrorToolResult, 'status' | 'error'>,
): ErrorToolResult {
  return { status: 'error', error, ...extra };
}
