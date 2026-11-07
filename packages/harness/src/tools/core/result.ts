// Shared ToolResult builders for the two dominant shapes, so call sites read
// as intent ("executed with this output") rather than object-literal
// boilerplate. Use these instead of hand-building a literal whenever the
// result carries only `output` and an optional `summary`; a result that also
// carries `diagnostics`, `files`, `edits`, `endTurn`, … stays an explicit
// literal, since those fields are the point of the call site.
//
// Host-agnostic, VS Code-free.

import type { ToolResult } from '@shared/schemas';

/** Build a `status: 'executed'` result. `summary` is omitted when not given,
 * matching the many call sites that only ever set `output`. */
export function executed(
  output: string,
  summary?: string,
): Extract<ToolResult, { status: 'executed' }> {
  return {
    status: 'executed',
    output,
    ...(summary !== undefined && { summary }),
  };
}

/**
 * Build a `status: 'error'` result literal. Reserved for call sites that
 * cannot fail the tool's Effect with a `ToolError` (the usual way, which
 * `defineTool` turns into the call's error): typically a caller that must keep
 * running after reporting a partial per-item error. Prefer failing with
 * `ToolError` whenever the call site can.
 */
export function errorResult(
  error: string,
  extra?: Omit<Extract<ToolResult, { status: 'error' }>, 'status' | 'error'>,
): Extract<ToolResult, { status: 'error' }> {
  return { status: 'error', error, ...extra };
}
