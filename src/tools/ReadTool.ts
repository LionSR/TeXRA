// Third-party imports
// Standard library imports

// Local imports - core
import { z } from 'zod';
import { defineTool } from './core/define';

// Local imports - tools
import { ToolResult, toolResult } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

export const READ_FILE_MAX_LINES = 400;

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
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const totalLines = lines.length;
    if (totalLines > READ_FILE_MAX_LINES) {
      const visibleLines = lines.slice(0, READ_FILE_MAX_LINES);
      const truncatedOutput = `${visibleLines.join('\n')}\n...(truncated, ${totalLines - READ_FILE_MAX_LINES} more lines)`;

      return toolResult({
        summary: `Read ${input.path} (first ${READ_FILE_MAX_LINES} of ${totalLines} lines)`,
        output: truncatedOutput,
      });
    }

    return toolResult({
      summary: `Read ${input.path}`,
      output: content,
    });
  }
}
