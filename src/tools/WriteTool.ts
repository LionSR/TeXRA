// Local imports - core
import { z } from 'zod';

// Internal imports
import { isTexFile } from '@common/files/fileTypeUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult } from '@shared/schemas/toolResult';
import { requireFileReadForEdit } from '@tools/fileInteractions';
import {
  assertWritable,
  resolveAndFormat,
  currentToolRoot,
} from '@tools/pathResolution';
import {
  appendApprovalDiffNote,
  requestAndWriteApprovedEdit,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS } from '@utils/files';
import { countLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';

const WriteInputSchema = z.strictObject({
  path: z
    .string()
    .describe('The file path to write, workspace-relative or absolute.'),
  content: z.string().describe('The full file contents to write.'),
});

export type WriteInput = z.infer<typeof WriteInputSchema>;

export class WriteFileTool extends defineTool({
  name: 'write_file',
  description:
    'Overwrite a workspace file with the provided content. Creates the file if it does not exist.',
  schema: WriteInputSchema,
}) {
  protected async execute(input: WriteInput): Promise<ToolResult> {
    const root = currentToolRoot();
    const { path: resolved, display: displayPath } = resolveAndFormat(
      input.path,
      root,
    );
    assertWritable(resolved, displayPath);
    const filePath = resolved.fsPath;

    const exists = await WorkspaceFS.exists(filePath);
    const readGate = requireFileReadForEdit(filePath, exists);
    if (readGate) {
      return readGate;
    }

    const originalContent = exists ? await WorkspaceFS.read(filePath) : '';

    const proposedContent = isTexFile(filePath)
      ? replacementEngine.applyAll(input.content)
      : input.content;

    const outcome = await requestAndWriteApprovedEdit({
      path: filePath,
      displayPath,
      originalContent,
      proposedContent,
      sourceTool: 'write_file',
    });
    if ('rejected' in outcome) {
      return outcome.rejected;
    }
    const { approval, appliedContent } = outcome;

    const output = appendApprovalDiffNote(
      'written',
      displayPath,
      proposedContent,
      appliedContent,
    );

    const originalLineCount = countLines(originalContent);
    const newLineCount = countLines(appliedContent);
    const action = exists ? 'Overwrote' : 'Created';
    const summary = `${action} ${displayPath} (${newLineCount} lines)`;
    const userInstruction =
      exists && originalLineCount > 0
        ? `Replaced ${originalLineCount} lines with ${newLineCount} lines.`
        : undefined;

    return {
      status: 'executed',
      summary,
      output,
      userPatch: approval.userPatch,
      edits: [
        {
          path: displayPath,
          lineChanges: approval.lineChanges,
          startLine: approval.startLine,
        },
      ],
      ...(userInstruction && { userInstruction }),
    };
  }
}
