// Standard library imports

import * as path from 'path';
import * as vscode from 'vscode';

// Local imports - core
import { BaseAnthropicTool, CLIResult, ToolError, ToolResult } from './base';
import {
  TextEditorToolParams,
  ToolCallInput,
  EditorCommand,
  FileHistoryEntry,
} from './types';

// Local imports - utilities
import * as workspaceFileUtils from '../utils/workspaceFileUtils';

// Local imports - Log
import * as logger from '../logger/logUtils';

// Constants
const CHANNEL = 'TextEditorTool';
const SNIPPET_LINES = 4;

/**
 * Implementation of Anthropic's text editor tool for VS Code
 */
export class TextEditorTool extends BaseAnthropicTool {
  // Tool type and name
  private apiType: 'text_editor_20250124' | 'text_editor_20241022';
  private name: 'str_replace_editor' = 'str_replace_editor';

  // File history for undo operations
  private fileHistory: Map<string, string[]> = new Map();

  /**
   * Create a new TextEditorTool
   * @param apiType - The type of text editor tool (based on Claude version)
   */
  constructor(
    apiType:
      | 'text_editor_20250124'
      | 'text_editor_20241022' = 'text_editor_20250124',
  ) {
    super();
    this.apiType = apiType;
  }

  /**
   * Convert the tool to the format expected by Anthropic's API
   */
  toParams(): TextEditorToolParams {
    return {
      name: this.name,
      type: this.apiType,
    };
  }

  /**
   * Execute the tool with the given arguments
   * @param input - Tool call input parameters
   */
  async call(input: ToolCallInput): Promise<ToolResult> {
    try {
      const { command, path: filePath } = input;

      // Validate the path and command
      await this.validatePath(command, filePath);

      // Execute the appropriate command
      switch (command) {
        case 'view':
          return await this.view(filePath, input.view_range);
        case 'create':
          if (!input.file_text) {
            throw new ToolError(
              'Parameter `file_text` is required for command: create',
            );
          }
          logger.info(CHANNEL, `create: ${filePath}`);
          return await this.create(filePath, input.file_text);
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
          return await this.strReplace(
            filePath,
            input.old_str,
            input.new_str || '',
          );

        case 'insert':
          if (input.insert_line === undefined) {
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
          return await this.insert(filePath, input.insert_line, input.new_str);
        case 'undo_edit':
          logger.info(CHANNEL, `undo_edit: ${filePath}`);
          return await this.undoEdit(filePath);
        default:
          throw new ToolError(
            `Unrecognized command ${command}. The allowed commands for the ${this.name} tool are: view, create, str_replace, insert, undo_edit`,
          );
      }
    } catch (error) {
      if (error instanceof ToolError) {
        return new ToolResult({ error: error.message, isError: true });
      }
      return new ToolResult({
        error: `Unexpected error: ${String(error)}`,
        isError: true,
      });
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
    const exists = await workspaceFileUtils.fileExists(filePath);

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
        const stats = await vscode.workspace.fs.stat(
          vscode.Uri.file(
            workspaceFileUtils.getFullPathFromWorkspace(filePath),
          ),
        );

        if (stats.type === vscode.FileType.Directory && command !== 'view') {
          throw new ToolError(
            `The path ${filePath} is a directory and only the 'view' command can be used on directories`,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof ToolError)) {
        throw new ToolError(`Error validating path: ${String(error)}`);
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
    viewRange?: [number, number],
  ): Promise<ToolResult> {
    try {
      // Check if the path is a directory
      const stats = await vscode.workspace.fs.stat(
        vscode.Uri.file(workspaceFileUtils.getFullPathFromWorkspace(filePath)),
      );

      if (stats.type === vscode.FileType.Directory) {
        if (viewRange) {
          throw new ToolError(
            'The `view_range` parameter is not allowed when `path` points to a directory.',
          );
        }

        // Get directory contents
        const dirContents = await workspaceFileUtils.readDirectory(filePath);
        const formattedContents = dirContents
          .map(([fileName, fileType]) => {
            const type =
              fileType === vscode.FileType.Directory ? 'dir' : 'file';
            return `[${type}] ${fileName}`;
          })
          .join('\n');

        return new CLIResult({
          output: `Here's the files and directories in ${filePath}:\n${formattedContents}`,
        });
      }

      // Read file contents
      let fileContent = await workspaceFileUtils.readFile(filePath);
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
        if (endLine === -1) {
          fileContent = fileLines.slice(startLine - 1).join('\n');
        } else {
          fileContent = fileLines.slice(startLine - 1, endLine).join('\n');
        }
      }

      return new CLIResult({
        output: this.makeOutput(fileContent, filePath, initLine),
      });
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(`Error viewing ${filePath}: ${String(error)}`);
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
        await this.ensureDirectoryExists(dirPath);
      }

      // Write file content
      await workspaceFileUtils.writeFile(filePath, content);

      return new ToolResult({
        output: `File created successfully at: ${filePath}`,
      });
    } catch (error) {
      throw new ToolError(`Error creating file ${filePath}: ${String(error)}`);
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
      // Read file content
      const fileContent = await workspaceFileUtils.readFile(filePath);

      // Expand tabs in content and search string
      const expandedFileContent = fileContent.replace(/\t/g, '    ');
      const expandedOldStr = oldStr.replace(/\t/g, '    ');
      const expandedNewStr = newStr.replace(/\t/g, '    ');

      // Check for occurrences of oldStr
      const occurrences = expandedFileContent.split(expandedOldStr).length - 1;

      if (occurrences === 0) {
        throw new ToolError(
          `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`,
        );
      }

      if (occurrences > 1) {
        // Find line numbers where oldStr occurs
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

      // Save current content to history
      this.addToHistory(filePath, fileContent);

      // Perform replacement
      const newFileContent = expandedFileContent.replace(
        expandedOldStr,
        expandedNewStr,
      );
      await workspaceFileUtils.writeFile(filePath, newFileContent);

      // Create a snippet of the edited section
      const textBeforeReplacement =
        expandedFileContent.split(expandedOldStr)[0];
      const replacementLine =
        (textBeforeReplacement.match(/\n/g) || []).length + 1;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) || []).length;

      const newFileLines = newFileContent.split('\n');
      const snippet = newFileLines.slice(startLine - 1, endLine).join('\n');

      // Prepare success message
      const successMsg = `The file ${filePath} has been edited. ${this.makeOutput(
        snippet,
        `a snippet of ${filePath}`,
        startLine,
      )}Review the changes and make sure they are as expected. Edit the file again if necessary.`;

      return new CLIResult({
        output: successMsg,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(
        `Error replacing text in ${filePath}: ${String(error)}`,
      );
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
      // Read file content
      const fileContent = await workspaceFileUtils.readFile(filePath);

      // Expand tabs in content and new string
      const expandedFileContent = fileContent.replace(/\t/g, '    ');
      const expandedNewStr = newStr.replace(/\t/g, '    ');

      // Split content into lines
      const fileLines = expandedFileContent.split('\n');
      const numLines = fileLines.length;

      // Validate insert line
      if (insertLine < 0 || insertLine > numLines) {
        throw new ToolError(
          `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${numLines}]`,
        );
      }

      // Save current content to history
      this.addToHistory(filePath, fileContent);

      // Insert new text
      const newStrLines = expandedNewStr.split('\n');
      const newFileLines = [
        ...fileLines.slice(0, insertLine),
        ...newStrLines,
        ...fileLines.slice(insertLine),
      ];

      // Create a snippet of the edited section
      const snippetLines = [
        ...fileLines.slice(Math.max(0, insertLine - SNIPPET_LINES), insertLine),
        ...newStrLines,
        ...fileLines.slice(insertLine, insertLine + SNIPPET_LINES),
      ];

      // Write new content to file
      const newFileContent = newFileLines.join('\n');
      await workspaceFileUtils.writeFile(filePath, newFileContent);

      // Prepare success message
      const snippetText = snippetLines.join('\n');
      const startLine = Math.max(1, insertLine - SNIPPET_LINES + 1);

      const successMsg = `The file ${filePath} has been edited. ${this.makeOutput(
        snippetText,
        'a snippet of the edited file',
        startLine,
      )}Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.`;

      return new CLIResult({
        output: successMsg,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(
        `Error inserting text in ${filePath}: ${String(error)}`,
      );
    }
  }

  /**
   * Undo the last edit to a file
   * @param filePath - Path to the file
   * @private
   */
  private async undoEdit(filePath: string): Promise<ToolResult> {
    try {
      // Check if there's history for this file
      const history = this.fileHistory.get(filePath);
      if (!history || history.length === 0) {
        throw new ToolError(`No edit history found for ${filePath}.`);
      }

      // Restore previous content
      const oldContent = history.pop()!;
      await workspaceFileUtils.writeFile(filePath, oldContent);

      // If the history is now empty, delete the entry
      if (history.length === 0) {
        this.fileHistory.delete(filePath);
      }

      return new CLIResult({
        output: `Last edit to ${filePath} undone successfully. ${this.makeOutput(oldContent, filePath)}`,
      });
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(
        `Error undoing edit to ${filePath}: ${String(error)}`,
      );
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

  /**
   * Ensure a directory exists, creating it if necessary
   * @param dirPath - Path to the directory
   * @private
   */
  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      const exists = await workspaceFileUtils.fileExists(dirPath);
      if (!exists) {
        await workspaceFileUtils.createDirectory(dirPath);
      }
    } catch (error) {
      throw new ToolError(
        `Error creating directory ${dirPath}: ${String(error)}`,
      );
    }
  }
}
