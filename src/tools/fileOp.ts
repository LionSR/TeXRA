// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import {
  buildApprovalRejectedResult,
  formatUnifiedApprovalUserDiff,
  getApprovedContent,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { ToolResult, ToolError, toolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';

const FileOpInputSchema = z.object({
  command: z.enum(['read', 'write', 'append']),
  path: z.string(),
  content: z.string().optional(),
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
        return toolResult({
          summary: `Read ${path}`,
          output: data,
        });
      }
      case 'write': {
        if (content === undefined) {
          return toolResult({
            error: 'content parameter is required for write',
            isError: true,
          });
        }
        const originalContent = (await WorkspaceFS.exists(path))
          ? await WorkspaceFS.read(path)
          : '';

        const approval = await requestToolEditApproval({
          path,
          originalContent,
          proposedContent: content,
          sourceTool: 'file_op:write',
        });

        if (!approval.accepted) {
          return buildApprovalRejectedResult(
            path,
            'file_op:write',
            approval.userMessage,
          );
        }

        const finalContent = getApprovedContent(approval, content);
        const { appliedContent } = await writeApprovedContent(
          path,
          originalContent,
          finalContent,
        );
        const userDiffNote = formatUnifiedApprovalUserDiff(
          path,
          finalContent,
          appliedContent,
        );

        return toolResult({
          summary: `Wrote ${path}`,
          output: userDiffNote ? `written\n\n${userDiffNote}` : 'written',
        });
      }
      case 'append': {
        if (content === undefined) {
          return toolResult({
            error: 'content parameter is required for append',
            isError: true,
          });
        }
        const originalContent = (await WorkspaceFS.exists(path))
          ? await WorkspaceFS.read(path)
          : '';
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
        // Report the actual applied content after append
        const appliedContent = await WorkspaceFS.read(path);
        const userDiffNote = formatUnifiedApprovalUserDiff(
          path,
          finalContent,
          appliedContent,
        );

        return toolResult({
          summary: `Appended to ${path}`,
          output: userDiffNote ? `appended\n\n${userDiffNote}` : 'appended',
        });
      }
      default:
        throw new ToolError(
          `File operation error: Unknown command '${command}'. Expected 'read', 'write', or 'append'.`,
        );
    }
  }
}
