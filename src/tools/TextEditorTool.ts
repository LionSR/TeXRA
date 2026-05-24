// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports - tool definitions
import { toErrorMessage } from '@common/errors';
import { isDirectory } from '@common/files/fsEntryType';
import { isTexFile } from '@common/files/fileTypeUtils';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
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
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { ToolResult, ToolError } from './result';
import { formatFileView, formatLinesWithNumbers } from './formatting';
import {
  assertWritable,
  resolveAndFormat,
  currentToolRoot,
} from './pathResolution';
import { requireField } from './utils';

// Constants
const CHANNEL = 'TextEditorTool';
logger.initialize(CHANNEL);
const SNIPPET_LINES = 4;

/** Rethrow ToolError as-is; wrap other errors with context message */
function rethrowWithContext(error: unknown, context: string): never {
  if (error instanceof ToolError) {
    throw error;
  }
  throw new ToolError(`${context}: ${toErrorMessage(error)}`, { cause: error });
}

/** Maps API type versions to their corresponding tool names */
const API_TYPE_TO_NAME = {
  text_editor_20250429: 'str_replace_based_edit_tool',
  text_editor_20250124: 'str_replace_editor',
  text_editor_20241022: 'str_replace_editor',
} as const;

export const TextEditorInputSchema = z.strictObject({
  command: z.enum(['view', 'create', 'str_replace', 'insert', 'undo_edit']),
  path: z.string(),
  file_text: z.string().nullish(),
  view_range: z
    .array(z.number())
    .length(2)
    .nullish()
    .describe('1-indexed. Use -1 for EOF.'),
  old_str: z.string().nullish(),
  new_str: z.string().nullish(),
  insert_line: z.number().nullish().describe('1-indexed.'),
});

/** Derived from TextEditorInputSchema - single source of truth */
export type TextEditorInput = z.infer<typeof TextEditorInputSchema>;

/** Command type derived from TextEditorInputSchema */
export type EditorCommand = TextEditorInput['command'];

/**
 * Implementation of Anthropic's text editor tool for VS Code
 */
export class TextEditorTool extends defineTool({
  name: 'str_replace_editor',
  description: 'Edit files using search and replace or insertion operations',
  schema: TextEditorInputSchema,
}) {
  // Tool type and name
  private apiType:
    | 'text_editor_20250124'
    | 'text_editor_20241022'
    | 'text_editor_20250429';
  private name: 'str_replace_editor' | 'str_replace_based_edit_tool';

  // File history for undo operations
  private fileHistory: Map<string, string[]> = new Map();

  constructor(
    apiType:
      | 'text_editor_20250124'
      | 'text_editor_20241022'
      | 'text_editor_20250429' = 'text_editor_20250124',
  ) {
    const name = API_TYPE_TO_NAME[apiType];
    super({ name });
    this.apiType = apiType;
    this.name = name;
  }

  private getAllowedCommands(): string {
    return this.apiType === 'text_editor_20250429'
      ? 'view, create, str_replace, insert'
      : 'view, create, str_replace, insert, undo_edit';
  }

  protected async execute(input: TextEditorInput): Promise<ToolResult> {
    const { command, path: inputPath } = input;
    const root = currentToolRoot();
    const { path: resolved, display: displayPath } = resolveAndFormat(
      inputPath,
      root,
    );
    const filePath = resolved.fsPath;

    // Every command except `view` mutates the target file. Enforce the
    // external-root writable policy here (workspace paths are always allowed
    // — assertWritable is a no-op for them).
    if (command !== 'view') {
      assertWritable(resolved, displayPath);
    }

    await this.validatePath(command, filePath, displayPath);

    switch (command) {
      case 'view':
        return this.view(filePath, displayPath, input.view_range ?? undefined);
      case 'create': {
        const fileText = requireField(input.file_text, 'file_text', command);
        logger.info(CHANNEL, `create: ${displayPath}`);
        return this.create(filePath, displayPath, fileText);
      }
      case 'str_replace': {
        const oldStr = requireField(input.old_str, 'old_str', command);
        logger.info(CHANNEL, `str_replace: ${oldStr} -> ${input.new_str}`);
        return this.strReplace(
          filePath,
          displayPath,
          oldStr,
          input.new_str ?? '',
        );
      }
      case 'insert': {
        const insertLine = requireField(
          input.insert_line,
          'insert_line',
          command,
        );
        const newStr = requireField(input.new_str, 'new_str', command);
        logger.info(CHANNEL, `insert: ${insertLine} -> ${newStr}`);
        return this.insert(filePath, displayPath, insertLine, newStr);
      }
      case 'undo_edit':
        // Claude 4 models don't support undo_edit command
        if (this.apiType === 'text_editor_20250429') {
          throw new ToolError(
            `The 'undo_edit' command is not supported in Claude 4 models. Use the str_replace_based_edit_tool with explicit content instead.`,
          );
        }
        logger.info(CHANNEL, `undo_edit: ${displayPath}`);
        return this.undoEdit(filePath, displayPath);
      default:
        throw new ToolError(
          `Unrecognized command ${command}. The allowed commands for the ${this.name} tool are: ${this.getAllowedCommands()}`,
        );
    }
  }

  private async validatePath(
    command: EditorCommand,
    filePath: string,
    displayPath: string,
  ): Promise<void> {
    const exists = await WorkspaceFS.exists(filePath);

    if (!exists) {
      if (command !== 'create') {
        throw new ToolError(
          `The path ${displayPath} does not exist. Please provide a valid path.`,
        );
      }
      return; // 'create' on non-existent path is valid — nothing more to check
    }

    if (command === 'create') {
      throw new ToolError(
        `File already exists at: ${displayPath}. Cannot overwrite files using command 'create'.`,
      );
    }

    // Check if the path is a directory (only view command can be used on directories)
    try {
      const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));
      if (isDirectory(stats.type) && command !== 'view') {
        throw new ToolError(
          `The path ${displayPath} is a directory and only the 'view' command can be used on directories`,
        );
      }
    } catch (error) {
      rethrowWithContext(error, `Error validating path`);
    }
  }

  private async view(
    filePath: string,
    displayPath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    try {
      const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));

      if (isDirectory(stats.type)) {
        if (viewRange) {
          throw new ToolError(
            'The `view_range` parameter is not allowed when `path` points to a directory.',
          );
        }

        const dirContents = await WorkspaceFS.readDir(filePath);
        const formattedContents = dirContents
          .map(([fileName, fileType]) => {
            const type = isDirectory(fileType) ? 'dir' : 'file';
            return `[${type}] ${fileName}`;
          })
          .join('\n');

        return {
          summary: `Listed directory: ${displayPath}`,
          output: formattedContents,
        };
      }

      // Expand tabs to 4 spaces for consistent display
      const fileContent = (await WorkspaceFS.read(filePath)).replaceAll(
        '\t',
        '    ',
      );
      const lines = splitContentLines(fileContent);
      const totalLines = lines.length;

      let viewStartLine = 1;
      let viewEndLine = totalLines;

      if (viewRange) {
        if (
          viewRange.length !== 2 ||
          !Number.isInteger(viewRange[0]) ||
          !Number.isInteger(viewRange[1])
        ) {
          throw new ToolError(
            'Invalid `view_range`. It should be a list of two integers.',
          );
        }

        const [startLine, endLine] = viewRange;

        // Only validate bounds when the file is non-empty; empty files
        // skip validation and formatFileView returns "file is empty".
        if (totalLines > 0) {
          if (startLine < 1 || startLine > totalLines) {
            throw new ToolError(
              `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its first element \`${startLine}\` should be within the range of lines of the file: [1, ${totalLines}]`,
            );
          }

          if (endLine !== -1) {
            if (endLine > totalLines) {
              throw new ToolError(
                `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be smaller than the number of lines in the file: \`${totalLines}\``,
              );
            }
            if (endLine < startLine) {
              throw new ToolError(
                `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be larger or equal than its first \`${startLine}\``,
              );
            }
          }
        }

        viewStartLine = startLine;
        viewEndLine = endLine === -1 ? totalLines : endLine;
      }

      recordToolFileRead(filePath);

      return formatFileView({
        path: displayPath,
        lines,
        viewRange: viewRange ? [viewStartLine, viewEndLine] : null,
        maxLines: Infinity,
      });
    } catch (error) {
      rethrowWithContext(error, `Error viewing ${displayPath}`);
    }
  }

  private async create(
    filePath: string,
    displayPath: string,
    content: string,
  ): Promise<ToolResult> {
    try {
      const proposedContent = isTexFile(filePath)
        ? replacementEngine.applyAll(content)
        : content;
      const approval = await requestToolEditApproval({
        path: filePath,
        originalContent: '',
        proposedContent: proposedContent,
        sourceTool: 'text_editor:create',
      });

      if (!approval.accepted) {
        return buildApprovalRejectedResult(
          displayPath,
          'text_editor:create',
          approval.userMessage,
        );
      }

      // Create parent directories if they don't exist
      const dirPath = path.dirname(filePath);
      if (dirPath !== '.') {
        await WorkspaceFS.ensureDir(dirPath);
      }

      const finalContent = getApprovedContent(approval, proposedContent);
      const { appliedContent } = await writeApprovedContent(
        filePath,
        '',
        finalContent,
      );

      // Record file as "read" after creation so subsequent edits don't require
      // an explicit read - this is essential for newly created files.
      recordToolFileRead(filePath);

      const userDiffNote = formatUnifiedApprovalUserDiff(
        displayPath,
        proposedContent,
        appliedContent,
      );
      const output = userDiffNote
        ? `File created successfully at: ${displayPath}\n\n${userDiffNote}`
        : `File created successfully at: ${displayPath}`;

      return {
        summary: `Created file ${displayPath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: displayPath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error creating file ${displayPath}`);
    }
  }

  private async strReplace(
    filePath: string,
    displayPath: string,
    oldStr: string,
    newStr: string,
  ): Promise<ToolResult> {
    try {
      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }
      const fileContent = await WorkspaceFS.read(filePath);

      // Expand tabs to 4 spaces for consistent display
      const expandedFileContent = fileContent.replaceAll('\t', '    ');
      const expandedOldStr = oldStr.replaceAll('\t', '    ');
      const expandedNewStr = newStr.replaceAll('\t', '    ');

      const occurrences = expandedFileContent.split(expandedOldStr).length - 1;

      if (occurrences === 0) {
        throw new ToolError(
          `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${displayPath}.`,
        );
      }

      if (occurrences > 1) {
        const lines = expandedFileContent.split('\n');
        const lineNumbers = lines
          .map((line, index) =>
            line.includes(expandedOldStr) ? index + 1 : -1,
          )
          .filter((num) => num !== -1);

        throw new ToolError(
          `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines ${lineNumbers.join(', ')}. Please ensure it is unique`,
        );
      }

      const newFileContent = expandedFileContent.replace(
        expandedOldStr,
        expandedNewStr,
      );

      const approval = await requestToolEditApproval({
        path: filePath,
        originalContent: fileContent,
        proposedContent: newFileContent,
        sourceTool: 'text_editor:str_replace',
      });

      if (!approval.accepted) {
        return buildApprovalRejectedResult(
          displayPath,
          'text_editor:str_replace',
          approval.userMessage,
        );
      }

      const approvedContent = getApprovedContent(approval, newFileContent);
      const { appliedContent, baseContent } = await writeApprovedContent(
        filePath,
        fileContent,
        approvedContent,
      );
      if (appliedContent !== baseContent) {
        this.addToHistory(filePath, baseContent);
      }

      recordToolFileRead(filePath);

      const textBeforeReplacement =
        expandedFileContent.split(expandedOldStr)[0];
      const replacementLine =
        (textBeforeReplacement.match(/\n/g) ?? []).length + 1;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) ?? []).length;

      const newFileLines = appliedContent.split('\n');
      const snippet = newFileLines.slice(startLine - 1, endLine).join('\n');

      const output = this.formatEditOutput(
        displayPath,
        snippet,
        startLine,
        newFileContent,
        appliedContent,
        'Review the changes and make sure they are as expected. Edit the file again if necessary.',
      );

      return {
        summary: `Updated ${displayPath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: displayPath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error replacing text in ${displayPath}`);
    }
  }

  private async insert(
    filePath: string,
    displayPath: string,
    insertLine: number,
    newStr: string,
  ): Promise<ToolResult> {
    try {
      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }
      const fileContent = await WorkspaceFS.read(filePath);

      // Expand tabs to 4 spaces for consistent display
      const expandedFileContent = fileContent.replaceAll('\t', '    ');
      const expandedNewStr = newStr.replaceAll('\t', '    ');

      const fileLines = expandedFileContent.split('\n');
      const numLines = fileLines.length;

      if (insertLine < 1 || insertLine > numLines + 1) {
        throw new ToolError(
          `Invalid \`insert_line\`: ${insertLine}. Should be in range [1, ${numLines + 1}] (1-indexed, insert after line N).`,
        );
      }

      const newStrLines = expandedNewStr.split('\n');
      const newFileLines = [
        ...fileLines.slice(0, insertLine - 1),
        ...newStrLines,
        ...fileLines.slice(insertLine - 1),
      ];
      const newFileContent = newFileLines.join('\n');

      const approval = await requestToolEditApproval({
        path: filePath,
        originalContent: fileContent,
        proposedContent: newFileContent,
        sourceTool: 'text_editor:insert',
      });

      if (!approval.accepted) {
        return buildApprovalRejectedResult(
          displayPath,
          'text_editor:insert',
          approval.userMessage,
        );
      }

      const approvedContent = getApprovedContent(approval, newFileContent);
      const { appliedContent, baseContent } = await writeApprovedContent(
        filePath,
        fileContent,
        approvedContent,
      );
      if (appliedContent !== baseContent) {
        this.addToHistory(filePath, baseContent);
      }

      recordToolFileRead(filePath);

      const previewLines = appliedContent.split('\n');
      const insertIndex = insertLine - 1;
      const snippetStart = Math.max(0, insertIndex - SNIPPET_LINES);
      const snippetEnd = Math.min(
        previewLines.length,
        insertIndex + newStrLines.length + SNIPPET_LINES,
      );
      const snippetText = previewLines
        .slice(snippetStart, snippetEnd)
        .join('\n');
      const startLine = snippetStart + 1;

      const output = this.formatEditOutput(
        displayPath,
        snippetText,
        startLine,
        newFileContent,
        appliedContent,
        'Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.',
      );

      return {
        summary: `Inserted text into ${displayPath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: displayPath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error inserting text in ${displayPath}`);
    }
  }

  private async undoEdit(
    filePath: string,
    displayPath: string,
  ): Promise<ToolResult> {
    try {
      const history = this.fileHistory.get(filePath);
      if (!history || history.length === 0) {
        throw new ToolError(`No edit history found for ${displayPath}.`);
      }

      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }

      const previousContent = history.at(-1)!;
      const currentContent = await WorkspaceFS.read(filePath);

      const approval = await requestToolEditApproval({
        path: filePath,
        originalContent: currentContent,
        proposedContent: previousContent,
        sourceTool: 'text_editor:undo_edit',
      });

      if (!approval.accepted) {
        return buildApprovalRejectedResult(
          displayPath,
          'text_editor:undo_edit',
          approval.userMessage,
        );
      }

      const approvedContent = getApprovedContent(approval, previousContent);
      const { appliedContent } = await writeApprovedContent(
        filePath,
        currentContent,
        approvedContent,
      );
      history.pop();

      recordToolFileRead(filePath);

      if (history.length === 0) {
        this.fileHistory.delete(filePath);
      }

      const userDiffNote = formatUnifiedApprovalUserDiff(
        displayPath,
        previousContent,
        appliedContent,
      );
      const baseOutput = `Last edit to ${displayPath} undone successfully. ${this.makeOutput(appliedContent)}`;
      const output = userDiffNote
        ? `${baseOutput}\n${userDiffNote}`
        : baseOutput;

      return {
        summary: `Undid edit on ${displayPath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: displayPath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error undoing edit to ${displayPath}`);
    }
  }

  /** Build the output message for str_replace/insert commands. */
  private formatEditOutput(
    filePath: string,
    snippetText: string,
    startLine: number,
    proposedContent: string,
    appliedContent: string,
    reviewNote: string,
  ): string {
    const successIntro = `The file ${filePath} has been edited.`;
    const snippetOutput = this.makeOutput(snippetText, startLine);
    const userDiffNote = formatUnifiedApprovalUserDiff(
      filePath,
      proposedContent,
      appliedContent,
    );
    const baseMsg = `${successIntro} ${snippetOutput}${reviewNote}`;
    return userDiffNote ? `${baseMsg}\n\n${userDiffNote}` : baseMsg;
  }

  private addToHistory(filePath: string, content: string): void {
    const history = this.fileHistory.get(filePath);
    if (history) {
      history.push(content);
    } else {
      this.fileHistory.set(filePath, [content]);
    }
  }

  private makeOutput(content: string, initLine: number = 1): string {
    const lines = splitContentLines(content);
    return '\n' + formatLinesWithNumbers(lines, initLine).join('\n') + '\n';
  }
}
