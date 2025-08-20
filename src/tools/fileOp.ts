// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Local imports - tools
import { BaseTool } from './core/base';
import type { ToolDefinition } from '@model';
import { ToolResult } from '@tools/result';
import { WorkspaceFS } from '@utils/files';

const FileOpInputSchema = z.object({
  command: z.enum(['read', 'write', 'append']),
  path: z.string(),
  content: z.string().optional(),
});

export type FileOpInput = z.infer<typeof FileOpInputSchema>;

export class FileOpTool extends BaseTool<FileOpInput> {
  constructor() {
    const definition: ToolDefinition = {
      name: 'file_op',
      description: 'Perform basic file operations',
      parameters: zodToJsonSchema(FileOpInputSchema),
    };
    super(definition, FileOpInputSchema);
  }

  protected async execute(input: FileOpInput): Promise<ToolResult> {
    const { command, path, content } = input;
    try {
      switch (command) {
        case 'read': {
          const data = await WorkspaceFS.readFile(path);
          return new ToolResult({ output: data });
        }
        case 'write': {
          if (content === undefined) {
            return new ToolResult({
              error: 'content parameter is required for write',
              isError: true,
            });
          }
          await WorkspaceFS.writeFile(path, content);
          return new ToolResult({ output: 'written' });
        }
        case 'append': {
          if (content === undefined) {
            return new ToolResult({
              error: 'content parameter is required for append',
              isError: true,
            });
          }
          await WorkspaceFS.appendFile(path, content);
          return new ToolResult({ output: 'appended' });
        }
        default:
          return new ToolResult({ error: 'unknown command', isError: true });
      }
    } catch (err) {
      return new ToolResult({
        error: err instanceof Error ? err.message : String(err),
        isError: true,
      });
    }
  }
}
