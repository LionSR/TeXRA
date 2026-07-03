/**
 * Tool-edit approval handler, wired at `initPlatform` once per process and
 * consumed by the shared `requestToolEditApproval` entry point.
 *
 * The handler receives the proposed edit (already carrying a `streamId` for
 * session routing, and enough content context to let the host surface the
 * change before returning a decision).  It replaces the prior
 * `setToolEditApprovalHandler` module-global singleton.
 *
 * Request / result shapes are defined here as the single Platform contract;
 * `@tools/approval/toolEditApproval` re-exports these types for existing
 * approval call sites.
 */

/** Platform-level contract for a tool-edit approval request. */
export interface ToolEditApprovalRequest {
  readonly path: string;
  readonly originalContent: string;
  readonly proposedContent: string;
  readonly sourceTool: string;
  readonly streamId?: string | null;
}

/** Platform-level contract for a tool-edit approval result. */
export interface ToolEditApprovalResult {
  readonly accepted: boolean;
  readonly userMessage?: string;
  readonly appliedContent?: string;
  readonly userPatch?: string;
  readonly lineChanges?: { readonly added: number; readonly removed: number };
  readonly startLine?: number;
}

export type ToolEditApprovalPort = (
  request: ToolEditApprovalRequest,
) => Promise<ToolEditApprovalResult>;
