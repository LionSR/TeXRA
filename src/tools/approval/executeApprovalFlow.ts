/**
 * Consolidated tool edit approval flow.
 *
 * This module provides a single entry point for the 6-step approval sequence
 * used across WriteTool, EditTool, and TextEditorTool operations.
 */

// Local imports - tools
import { type ToolResult, type LineChanges } from '@tools/result';
import { recordToolFileRead, requireFileReadForEdit } from '@tools/fileInteractions';
import { WorkspaceFS } from '@utils/files';

// Local imports - approval helpers
import {
  requestToolEditApproval,
  buildApprovalRejectedResult,
  getApprovedContent,
  writeApprovedContent,
  formatUnifiedApprovalUserDiff,
} from './toolEditApproval';

/**
 * Options for executing a tool edit approval flow.
 */
export interface ExecuteApprovalFlowOptions {
  /** File path being edited */
  path: string;

  /** Original content before edit (empty string for new files) */
  originalContent: string;

  /** Proposed new content */
  proposedContent: string;

  /** Tool identifier (e.g., 'write_file', 'text_editor:str_replace') */
  sourceTool: string;

  /** Summary message for successful result (e.g., 'Wrote file.tex') */
  summaryMessage: string;

  /** Optional: Additional output text before user diff */
  successOutputPrefix?: string;

  /** Optional: Context lines for unified diff formatting (default: 3) */
  contextLines?: number;

  /** Optional: Skip file read requirement check (for new file creation) */
  skipFileReadCheck?: boolean;
}

/**
 * Result from a successful approval flow.
 * Contains the applied content and base content for optional post-processing.
 */
export interface ApprovalFlowWriteResult {
  appliedContent: string;
  baseContent: string;
}

/**
 * Execute the standard tool edit approval flow for file modifications.
 *
 * Handles the complete approval workflow:
 * 1. File read requirement check (unless skipped)
 * 2. User approval request
 * 3. Rejection handling
 * 4. Content writing with merge support
 * 5. File interaction recording
 * 6. Result formatting with user diff
 *
 * @param options Configuration for the approval flow
 * @returns Promise<ToolResult> - Success result with edits, or rejection result
 */
export async function executeToolEditApprovalFlow(
  options: ExecuteApprovalFlowOptions,
): Promise<ToolResult> {
  const {
    path,
    originalContent,
    proposedContent,
    sourceTool,
    summaryMessage,
    successOutputPrefix,
    contextLines,
    skipFileReadCheck = false,
  } = options;

  // Step 1: Check file read requirement (unless creating new file)
  if (!skipFileReadCheck) {
    const exists = await WorkspaceFS.exists(path);
    const readGate = requireFileReadForEdit(path, exists);
    if (readGate) return readGate;
  }

  // Step 2: Request user approval
  const approval = await requestToolEditApproval({
    path,
    originalContent,
    proposedContent,
    sourceTool,
  });

  // Step 3: Handle rejection
  if (!approval.accepted) {
    return buildApprovalRejectedResult(path, sourceTool, approval.userMessage);
  }

  // Step 4: Write approved content (with merge support for concurrent edits)
  const finalContent = getApprovedContent(approval, proposedContent);
  const { appliedContent } = await writeApprovedContent(
    path,
    originalContent,
    finalContent,
  );

  // Step 5: Record file interaction
  recordToolFileRead(path);

  // Step 6: Format output with user diff
  const userDiffNote = formatUnifiedApprovalUserDiff(
    path,
    proposedContent,
    appliedContent,
    contextLines ? { contextLines } : undefined,
  );

  const output = buildOutputMessage(successOutputPrefix, userDiffNote);

  // Step 7: Return success result
  return {
    summary: summaryMessage,
    output,
    userPatch: approval.userPatch,
    edits: [{ path, lineChanges: approval.lineChanges }],
  };
}

/**
 * Execute approval flow and return write result for post-processing.
 *
 * Use this when you need access to appliedContent/baseContent after approval,
 * for example to update edit history in TextEditorTool.
 *
 * @param options Configuration for the approval flow
 * @param buildResult Callback to build the final ToolResult from write result
 * @returns Promise<ToolResult> - Success result from callback, or rejection result
 */
export async function executeToolEditApprovalFlowWithResult(
  options: ExecuteApprovalFlowOptions,
  buildResult: (
    writeResult: ApprovalFlowWriteResult,
    approval: { userPatch?: string; lineChanges?: LineChanges },
  ) => ToolResult,
): Promise<ToolResult> {
  const {
    path,
    originalContent,
    proposedContent,
    sourceTool,
    skipFileReadCheck = false,
  } = options;

  // Step 1: Check file read requirement (unless creating new file)
  if (!skipFileReadCheck) {
    const exists = await WorkspaceFS.exists(path);
    const readGate = requireFileReadForEdit(path, exists);
    if (readGate) return readGate;
  }

  // Step 2: Request user approval
  const approval = await requestToolEditApproval({
    path,
    originalContent,
    proposedContent,
    sourceTool,
  });

  // Step 3: Handle rejection
  if (!approval.accepted) {
    return buildApprovalRejectedResult(path, sourceTool, approval.userMessage);
  }

  // Step 4: Write approved content
  const finalContent = getApprovedContent(approval, proposedContent);
  const writeResult = await writeApprovedContent(
    path,
    originalContent,
    finalContent,
  );

  // Step 5: Record file interaction
  recordToolFileRead(path);

  // Step 6: Delegate result building to caller
  return buildResult(writeResult, {
    userPatch: approval.userPatch,
    lineChanges: approval.lineChanges,
  });
}

/**
 * Build output message combining prefix and user diff.
 */
function buildOutputMessage(
  prefix: string | undefined,
  userDiff: string | undefined,
): string {
  if (prefix && userDiff) {
    return `${prefix}\n\n${userDiff}`;
  }
  return userDiff ?? prefix ?? 'Operation completed.';
}
