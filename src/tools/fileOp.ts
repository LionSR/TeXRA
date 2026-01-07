// Local imports - core
import { z } from 'zod';

// Internal imports
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult, ToolError } from '@tools/result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import {
  buildApprovalRejectedResult,
  formatUnifiedApprovalUserDiff,
  getApprovedContent,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';

// Local imports - tools

const FileOpInputSchema = z.strictObject({
  command: z.enum(['read', 'write', 'append']),
  path: z.string(),
  content: z.string().nullish(),
});

export type FileOpInput = z.infer<typeof FileOpInputSchema>;

export class FileOpTool extends defineTool({
  name: 'file_op',
  description: 'Perform basic file operations',
  schema: FileOpInputSchema,
}) {
  protected async execute(input: FileOpInput): Promise<ToolResult> {
    const { command, path, content } = input;
    switch (command) {
      case 'read': {
        const data = await WorkspaceFS.read(path);
        recordToolFileRead(path);
        return {
          summary: `Read ${path}`,
          output: data,
        };
      }
      case 'write': {
        if (content == null) {
          return {
            error: 'content parameter is required for write',
            isError: true,
          };
        }
        const exists = await WorkspaceFS.exists(path);
        const readGate = requireFileReadForEdit(path, exists);
        if (readGate) {
          return readGate;
        }
        const originalContent = exists ? await WorkspaceFS.read(path) : '';

        const proposed = isTexFile(path)
          ? replacementEngine.applyAll(content)
          : content;

        const approval = await requestToolEditApproval({
          path,
          originalContent,
          proposedContent: proposed,
          sourceTool: 'file_op:write',
        });

        if (!approval.accepted) {
          return buildApprovalRejectedResult(
            path,
            'file_op:write',
            approval.userMessage,
          );
        }

        const finalContent = getApprovedContent(approval, proposed);
        const { appliedContent } = await writeApprovedContent(
          path,
          originalContent,
          finalContent,
        );

        // Record file as "read" after writing so subsequent edits don't require
        // an explicit read - especially important for newly created files.
        recordToolFileRead(path);

        const userDiffNote = formatUnifiedApprovalUserDiff(
          path,
          finalContent,
          appliedContent,
        );

        return {
          summary: `Wrote ${path}`,
          output: userDiffNote ? `written\n\n${userDiffNote}` : 'written',
          // userPatch omitted - userDiffNote in output already shows user adjustments
          edits: [{ path, lineChanges: approval.lineChanges }],
        };
      }
      case 'append': {
        if (content == null) {
          return {
            error: 'content parameter is required for append',
            isError: true,
          };
        }
        const exists = await WorkspaceFS.exists(path);
        const readGate = requireFileReadForEdit(path, exists);
        if (readGate) {
          return readGate;
        }
        const originalContent = exists ? await WorkspaceFS.read(path) : '';
        const proposedContent = `${originalContent}${content}`;

        const approval = await requestToolEditApproval({
          path,
          originalContent,
          proposedContent,
          sourceTool: 'file_op:append',
        });

        if (!approval.accepted) {
          return buildApprovalRejectedResult(
            path,
            'file_op:append',
            approval.userMessage,
          );
        }

        const finalContent = getApprovedContent(approval, proposedContent);
        if (!finalContent.startsWith(originalContent)) {
          throw new ToolError(
            `Append aborted: approved changes for ${path} modified existing content.`,
          );
        }

        const currentContent = (await WorkspaceFS.exists(path))
          ? await WorkspaceFS.read(path)
          : '';

        if (currentContent !== originalContent) {
          throw new ToolError(
            `Append aborted: ${path} changed while the edit was pending approval.`,
          );
        }

        const appendedSegment = finalContent.slice(originalContent.length);
        if (appendedSegment.length > 0) {
          await WorkspaceFS.appendFile(path, appendedSegment);
        }

        // Record file as "read" after appending so subsequent edits don't require
        // an explicit read - especially important for newly created files.
        recordToolFileRead(path);

        // Report the actual applied content after append
        const appliedContent = await WorkspaceFS.read(path);
        const userDiffNote = formatUnifiedApprovalUserDiff(
          path,
          finalContent,
          appliedContent,
        );

        return {
          summary: `Appended to ${path}`,
          output: userDiffNote ? `appended\n\n${userDiffNote}` : 'appended',
          // userPatch omitted - userDiffNote in output already shows user adjustments
          edits: [{ path, lineChanges: approval.lineChanges }],
        };
      }
      default:
        throw new ToolError(
          `File operation error: Unknown command '${command}'. Expected 'read', 'write', or 'append'.`,
        );
    }
  }
}
