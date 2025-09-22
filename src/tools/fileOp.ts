// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, ToolError } from '@tools/result';
import type { ToolResultLike } from '@tools/result';
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
  protected async execute(input: FileOpInput): Promise<ToolResultLike> {
    const { command, path, content } = input;
    switch (command) {
      case 'read': {
        const data = await WorkspaceFS.read(path);
        return {
          summary: `Read ${path}`,
          output: data,
        };
      }
      case 'write': {
        if (content === undefined) {
          return new ToolResult({
            error: 'content parameter is required for write',
            isError: true,
          });
        }
        await WorkspaceFS.write(path, content);
        return {
          summary: `Wrote ${path}`,
          output: 'written',
        };
      }
      case 'append': {
        if (content === undefined) {
          return new ToolResult({
            error: 'content parameter is required for append',
            isError: true,
          });
        }
        await WorkspaceFS.appendFile(path, content);
        return {
          summary: `Appended to ${path}`,
          output: 'appended',
        };
      }
      default:
        throw new ToolError(
          `File operation error: Unknown command '${command}'. Expected 'read', 'write', or 'append'.`,
        );
    }
  }
}
