// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - tool definitions
import { isTexFile } from '@common/files/fileTypeUtils';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '@tools/fileInteractions';
import {
  executeToolEditApprovalFlow,
  executeToolEditApprovalFlowWithResult,
} from '@tools/approval/executeApprovalFlow';
import { formatUnifiedApprovalUserDiff } from '@tools/approval/toolEditApproval';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';
import { ToolResult, ToolError } from './result';

// Constants
const CHANNEL = 'TextEditorTool';
logger.initialize(CHANNEL);
const SNIPPET_LINES = 4;

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
  view_range: z.array(z.number()).length(2).nullish(),
  old_str: z.string().nullish(),
  new_str: z.string().nullish(),
  insert_line: z.number().nullish(),
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

  /**
   * Create a new TextEditorTool
   * @param apiType - The type of text editor tool (based on Claude version)
   */
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

  /**
   * Get the list of allowed commands for this API version.
   */
  private getAllowedCommands(): string {
    if (this.apiType === 'text_editor_20250429') {
      return 'view, create, str_replace, insert';
    }
    return 'view, create, str_replace, insert, undo_edit';
  }

  /**
   * Execute the tool with the given arguments
   * @param input - Tool call input parameters
   */
  protected async execute(input: TextEditorInput): Promise<ToolResult> {
    const { command, path: filePath } = input;

    // Validate the path and command
    await this.validatePath(command, filePath);

    // Execute the appropriate command
    switch (command) {
      case 'view':
        return this.view(filePath, input.view_range ?? undefined);
      case 'create':
        if (!input.file_text) {
          throw new ToolError(
            'Parameter `file_text` is required for command: create',
          );
        }
        logger.info(CHANNEL, `create: ${filePath}`);
        return this.create(filePath, input.file_text);
      case 'str_replace':
        if (!input.old_str) {
          throw new ToolError(
            'Parameter `old_str` is required for command: str_replace',
          );
        }
        logger.info(
          CHANNEL,
          `str_replace: ${input.old_str} -> ${input.new_str}`,
        );
        return this.strReplace(filePath, input.old_str, input.new_str ?? '');

      case 'insert':
        // eslint-disable-next-line eqeqeq
        if (input.insert_line == null) {
          throw new ToolError(
            'Parameter `insert_line` is required for command: insert',
          );
        }
        if (!input.new_str) {
          throw new ToolError(
            'Parameter `new_str` is required for command: insert',
          );
        }
        logger.info(
          CHANNEL,
          `insert: ${input.insert_line} -> ${input.new_str}`,
        );
        return this.insert(filePath, input.insert_line, input.new_str);
      case 'undo_edit':
        // Claude 4 models don't support undo_edit command
        if (this.apiType === 'text_editor_20250429') {
          throw new ToolError(
            `The 'undo_edit' command is not supported in Claude 4 models. Use the str_replace_based_edit_tool with explicit content instead.`,
          );
        }
        logger.info(CHANNEL, `undo_edit: ${filePath}`);
        return this.undoEdit(filePath);
      default:
        throw new ToolError(
          `Unrecognized command ${command}. The allowed commands for the ${this.name} tool are: ${this.getAllowedCommands()}`,
        );
    }
  }

  /**
   * Validate the path and command combination
   * @param command - The command to validate
   * @param filePath - The path to validate
   * @private
   */
  private async validatePath(
    command: EditorCommand,
    filePath: string,
  ): Promise<void> {
    // Check if the path exists (except for create command)
    const exists = await WorkspaceFS.exists(filePath);

    if (!exists && command !== 'create') {
      throw new ToolError(
        `The path ${filePath} does not exist. Please provide a valid path.`,
      );
    }

    if (exists && command === 'create') {
      throw new ToolError(
        `File already exists at: ${filePath}. Cannot overwrite files using command 'create'.`,
      );
    }

    // Check if the path is a directory (only view command can be used on directories)
    try {
      if (exists) {
        const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));

        if (stats.type === vscode.FileType.Directory && command !== 'view') {
          throw new ToolError(
            `The path ${filePath} is a directory and only the 'view' command can be used on directories`,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof ToolError)) {
        throw new ToolError(`Error validating path: ${error}`);
      }
      throw error;
    }
  }

  /**
   * View a file or list directory contents
   * @param filePath - Path to the file or directory
   * @param viewRange - Optional range of lines to view (start, end)
   * @private
   */
  private async view(
    filePath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    try {
      // Check if the path is a directory
      const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));

      if (stats.type === vscode.FileType.Directory) {
        if (viewRange) {
          throw new ToolError(
            'The `view_range` parameter is not allowed when `path` points to a directory.',
          );
        }

        // Get directory contents
        const dirContents = await WorkspaceFS.readDir(filePath);
        const formattedContents = dirContents
          .map(([fileName, fileType]) => {
            const type =
              fileType === vscode.FileType.Directory ? 'dir' : 'file';
            return `[${type}] ${fileName}`;
          })
          .join('\n');

        return {
          summary: `View directory ${filePath}`,
          output: `Here's the files and directories in ${filePath}:\n${formattedContents}`,
        };
      }

      // Read file contents
      let fileContent = await WorkspaceFS.read(filePath);
      let initLine = 1;

      // Handle view range if provided
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

        const fileLines = fileContent.split('\n');
        const numLines = fileLines.length;
        const [startLine, endLine] = viewRange;

        if (startLine < 1 || startLine > numLines) {
          throw new ToolError(
            `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its first element \`${startLine}\` should be within the range of lines of the file: [1, ${numLines}]`,
          );
        }

        if (endLine !== -1 && endLine > numLines) {
          throw new ToolError(
            `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be smaller than the number of lines in the file: \`${numLines}\``,
          );
        }

        if (endLine !== -1 && endLine < startLine) {
          throw new ToolError(
            `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be larger or equal than its first \`${startLine}\``,
          );
        }

        initLine = startLine;
        const sliceEnd = endLine === -1 ? undefined : endLine;
        fileContent = fileLines.slice(startLine - 1, sliceEnd).join('\n');
      }

      // Record read only after successful validation
      recordToolFileRead(filePath);

      let rangeSummary: string | undefined;
      if (viewRange) {
        const [startLine, endLine] = viewRange;
        rangeSummary = `${startLine}-${endLine === -1 ? 'end' : endLine}`;
      }

      return {
        summary: rangeSummary
          ? `View ${filePath} (${rangeSummary})`
          : `View ${filePath}`,
        output: this.makeOutput(fileContent, filePath, initLine),
      };
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(`Error viewing ${filePath}: ${error}`);
    }
  }

  /**
   * Create a new file with the given content
   * @param filePath - Path to the file to create
   * @param content - Content to write to the file
   * @private
   */
  private async create(filePath: string, content: string): Promise<ToolResult> {
    try {
      // Create parent directories if they don't exist
      const dirPath = path.dirname(filePath);
      if (dirPath !== '.') {
        await WorkspaceFS.ensureDir(dirPath);
      }

      // Apply LaTeX transformations before approval
      const proposedContent = isTexFile(filePath)
        ? replacementEngine.applyAll(content)
        : content;

      return executeToolEditApprovalFlow({
        path: filePath,
        originalContent: '',
        proposedContent,
        sourceTool: 'text_editor:create',
        summaryMessage: `Created file ${filePath}`,
        successOutputPrefix: `File created successfully at: ${filePath}`,
        skipFileReadCheck: true,
      });
    } catch (error) {
      throw new ToolError(`Error creating file ${filePath}: ${error}`);
    }
  }

  /**
   * Replace text in a file
   * @param filePath - Path to the file
   * @param oldStr - Text to replace
   * @param newStr - New text to insert
   * @private
   */
  private async strReplace(
    filePath: string,
    oldStr: string,
    newStr: string,
  ): Promise<ToolResult> {
    try {
      // Validation: file must exist and have been read
      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }
      const fileContent = await WorkspaceFS.read(filePath);

      // Expand tabs in content and search string
      const expandedFileContent = fileContent.replaceAll('\t', '    ');
      const expandedOldStr = oldStr.replaceAll('\t', '    ');
      const expandedNewStr = newStr.replaceAll('\t', '    ');

      // Validation: old_str must be found exactly once
      const occurrences = expandedFileContent.split(expandedOldStr).length - 1;

      if (occurrences === 0) {
        throw new ToolError(
          `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`,
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

      // Build proposed content
      const newFileContent = expandedFileContent.replace(
        expandedOldStr,
        expandedNewStr,
      );

      // Calculate snippet position for output
      const textBeforeReplacement =
        expandedFileContent.split(expandedOldStr)[0];
      const replacementLine =
        (textBeforeReplacement.match(/\n/g) ?? []).length + 1;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) ?? []).length;

      // Execute approval flow with history tracking
      return executeToolEditApprovalFlowWithResult(
        {
          path: filePath,
          originalContent: fileContent,
          proposedContent: newFileContent,
          sourceTool: 'text_editor:str_replace',
          summaryMessage: `Updated ${filePath}`,
          skipFileReadCheck: true,
        },
        (writeResult, approval) => {
          const { appliedContent, baseContent } = writeResult;

          // Track history for undo support
          if (appliedContent !== baseContent) {
            this.addToHistory(filePath, baseContent);
          }

          // Build snippet output
          const newFileLines = appliedContent.split('\n');
          const snippet = newFileLines.slice(startLine - 1, endLine).join('\n');
          const snippetOutput = this.makeOutput(
            snippet,
            `a snippet of ${filePath}`,
            startLine,
          );

          // Format output
          const userDiffNote = formatUnifiedApprovalUserDiff(
            filePath,
            newFileContent,
            appliedContent,
          );
          const successIntro = `The file ${filePath} has been edited.`;
          const reviewMessage =
            'Review the changes and make sure they are as expected. Edit the file again if necessary.';
          const baseMsg = `${successIntro} ${snippetOutput}${reviewMessage}`;
          const output = userDiffNote ? `${baseMsg}\n\n${userDiffNote}` : baseMsg;

          return {
            summary: `Updated ${filePath}`,
            output,
            userPatch: approval.userPatch,
            edits: [{ path: filePath, lineChanges: approval.lineChanges }],
          };
        },
      );
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(`Error replacing text in ${filePath}: ${error}`);
    }
  }

  /**
   * Insert text at a specific line in a file
   * @param filePath - Path to the file
   * @param insertLine - Line number to insert at (0-indexed)
   * @param newStr - Text to insert
   * @private
   */
  private async insert(
    filePath: string,
    insertLine: number,
    newStr: string,
  ): Promise<ToolResult> {
    try {
      // Validation: file must exist and have been read
      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }
      const fileContent = await WorkspaceFS.read(filePath);

      // Expand tabs in content and new string
      const expandedFileContent = fileContent.replaceAll('\t', '    ');
      const expandedNewStr = newStr.replaceAll('\t', '    ');

      // Validation: insert line must be in range
      const fileLines = expandedFileContent.split('\n');
      const numLines = fileLines.length;

      if (insertLine < 0 || insertLine > numLines) {
        throw new ToolError(
          `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${numLines}]`,
        );
      }

      // Build proposed content
      const newStrLines = expandedNewStr.split('\n');
      const newFileLines = [
        ...fileLines.slice(0, insertLine),
        ...newStrLines,
        ...fileLines.slice(insertLine),
      ];
      const newFileContent = newFileLines.join('\n');

      // Execute approval flow with history tracking
      return executeToolEditApprovalFlowWithResult(
        {
          path: filePath,
          originalContent: fileContent,
          proposedContent: newFileContent,
          sourceTool: 'text_editor:insert',
          summaryMessage: `Inserted text into ${filePath}`,
          skipFileReadCheck: true,
        },
        (writeResult, approval) => {
          const { appliedContent, baseContent } = writeResult;

          // Track history for undo support
          if (appliedContent !== baseContent) {
            this.addToHistory(filePath, baseContent);
          }

          // Build snippet output
          const previewLines = appliedContent.split('\n');
          const snippetStart = Math.max(0, insertLine - SNIPPET_LINES);
          const snippetEnd = Math.min(
            previewLines.length,
            insertLine + newStrLines.length + SNIPPET_LINES,
          );
          const snippetText = previewLines
            .slice(snippetStart, snippetEnd)
            .join('\n');
          const startLine = snippetStart + 1;
          const snippetOutput = this.makeOutput(
            snippetText,
            'a snippet of the edited file',
            startLine,
          );

          // Format output
          const userDiffNote = formatUnifiedApprovalUserDiff(
            filePath,
            newFileContent,
            appliedContent,
          );
          const successIntro = `The file ${filePath} has been edited.`;
          const reviewNote =
            'Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.';
          const baseMsg = `${successIntro} ${snippetOutput}${reviewNote}`;
          const output = userDiffNote ? `${baseMsg}\n\n${userDiffNote}` : baseMsg;

          return {
            summary: `Inserted text into ${filePath}`,
            output,
            userPatch: approval.userPatch,
            edits: [{ path: filePath, lineChanges: approval.lineChanges }],
          };
        },
      );
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(`Error inserting text in ${filePath}: ${error}`);
    }
  }

  /**
   * Undo the last edit to a file
   * @param filePath - Path to the file
   * @private
   */
  private async undoEdit(filePath: string): Promise<ToolResult> {
    try {
      // Validation: must have edit history
      const history = this.fileHistory.get(filePath);
      if (!history || history.length === 0) {
        throw new ToolError(`No edit history found for ${filePath}.`);
      }

      // Validation: file must exist and have been read
      const exists = await WorkspaceFS.exists(filePath);
      const readGate = requireFileReadForEdit(filePath, exists);
      if (readGate) {
        return readGate;
      }

      const previousContent = history.at(-1)!;
      const currentContent = await WorkspaceFS.read(filePath);

      // Execute approval flow with history cleanup
      return executeToolEditApprovalFlowWithResult(
        {
          path: filePath,
          originalContent: currentContent,
          proposedContent: previousContent,
          sourceTool: 'text_editor:undo_edit',
          summaryMessage: `Undid edit on ${filePath}`,
          skipFileReadCheck: true,
        },
        (writeResult, approval) => {
          const { appliedContent } = writeResult;

          // Pop from history after successful write
          history.pop();
          if (history.length === 0) {
            this.fileHistory.delete(filePath);
          }

          // Format output
          const userDiffNote = formatUnifiedApprovalUserDiff(
            filePath,
            previousContent,
            appliedContent,
          );
          const baseOutput = `Last edit to ${filePath} undone successfully. ${this.makeOutput(appliedContent, filePath)}`;
          const output = userDiffNote ? `${baseOutput}\n${userDiffNote}` : baseOutput;

          return {
            summary: `Undid edit on ${filePath}`,
            output,
            userPatch: approval.userPatch,
            edits: [{ path: filePath, lineChanges: approval.lineChanges }],
          };
        },
      );
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(`Error undoing edit to ${filePath}: ${error}`);
    }
  }

  /**
   * Add file content to history for undo operations
   * @param filePath - Path to the file
   * @param content - Content to add to history
   * @private
   */
  private addToHistory(filePath: string, content: string): void {
    if (!this.fileHistory.has(filePath)) {
      this.fileHistory.set(filePath, []);
    }
    this.fileHistory.get(filePath)!.push(content);
  }

  /**
   * Format output for CLI display
   * @param content - Content to display
   * @param fileDescriptor - Description of the file
   * @param initLine - Initial line number
   * @private
   */
  private makeOutput(
    content: string,
    fileDescriptor: string,
    initLine: number = 1,
  ): string {
    // Add line numbers to content
    const numberedLines = content
      .split('\n')
      .map((line, index) => {
        const lineNum = index + initLine;
        return `${lineNum.toString().padStart(6)}\t${line}`;
      })
      .join('\n');

    return `Here's the result of running \`cat -n\` on ${fileDescriptor}:\n${numberedLines}\n`;
  }
}
