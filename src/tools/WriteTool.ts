// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult } from '@tools/result';
import { clearTrackedFile } from './fileAccessTracker';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

const WriteInputSchema = z
  .object({
    path: z.string(),
    content: z.string(),
  })
  .strict();

export type WriteInput = z.infer<typeof WriteInputSchema>;

export class WriteFileTool extends defineTool({
  name: 'write_file',
  description:
    'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
  schema: WriteInputSchema,
}) {
  protected async execute(input: WriteInput): Promise<ToolResult> {
    await WorkspaceFS.write(input.path, input.content);
    clearTrackedFile(input.path);
    return new ToolResult({ output: 'written' });
  }
}
