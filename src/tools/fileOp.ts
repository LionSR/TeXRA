// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import {
  buildApprovalRejectedResult,
  requestToolEditApproval,
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

        await WorkspaceFS.write(path, content);
        return toolResult({
          summary: `Wrote ${path}`,
          output: 'written',
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

        await WorkspaceFS.appendFile(path, content);
        return toolResult({
          summary: `Appended to ${path}`,
          output: 'appended',
        });
      }
      default:
        throw new ToolError(
          `File operation error: Unknown command '${command}'. Expected 'read', 'write', or 'append'.`,
        );
    }
  }
}
