// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const ReadInputSchema = z
  .object({
    path: z.string(),
  })
  .strict();

export type ReadInput = z.infer<typeof ReadInputSchema>;

export class ReadFileTool extends defineTool({
  name: 'read_file',
  description: 'Read and return the contents of a workspace file.',
  schema: ReadInputSchema,
}) {
  protected async execute(input: ReadInput): Promise<ToolResult> {
    const content = await WorkspaceFS.read(input.path);
    return toolResult({
      summary: `Read ${input.path}`,
      output: content,
    });
  }
}
