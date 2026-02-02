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
  buildApprovalRejectedResult,
  formatUnifiedApprovalUserDiff,
  getApprovedContent,
  requestToolEditApproval,
  writeApprovedContent,
} from '@tools/approval/toolEditApproval';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';

// Local file imports
import { defineTool } from './core/define';
import { ToolResult, ToolError } from './result';
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
  throw new ToolError(`${context}: ${error}`);
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
    if (this.apiType === 'text_editor_20250429') {
      return 'view, create, str_replace, insert';
    }
    return 'view, create, str_replace, insert, undo_edit';
  }

  protected async execute(input: TextEditorInput): Promise<ToolResult> {
    const { command, path: filePath } = input;

    await this.validatePath(command, filePath);

    switch (command) {
      case 'view':
        return this.view(filePath, input.view_range ?? undefined);
      case 'create': {
        const fileText = requireField(input.file_text, 'file_text', command);
        logger.info(CHANNEL, `create: ${filePath}`);
        return this.create(filePath, fileText);
      }
      case 'str_replace': {
        const oldStr = requireField(input.old_str, 'old_str', command);
        logger.info(CHANNEL, `str_replace: ${oldStr} -> ${input.new_str}`);
        return this.strReplace(filePath, oldStr, input.new_str ?? '');
      }
      case 'insert': {
        const insertLine = requireField(
          input.insert_line,
          'insert_line',
          command,
        );
        const newStr = requireField(input.new_str, 'new_str', command);
        logger.info(CHANNEL, `insert: ${insertLine} -> ${newStr}`);
        return this.insert(filePath, insertLine, newStr);
      }
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

  private async validatePath(
    command: EditorCommand,
    filePath: string,
  ): Promise<void> {
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
    if (exists) {
      try {
        const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));
        if (stats.type === vscode.FileType.Directory && command !== 'view') {
          throw new ToolError(
            `The path ${filePath} is a directory and only the 'view' command can be used on directories`,
          );
        }
      } catch (error) {
        rethrowWithContext(error, `Error validating path`);
      }
    }
  }

  private async view(
    filePath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    try {
      const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath));

      if (stats.type === vscode.FileType.Directory) {
        if (viewRange) {
          throw new ToolError(
            'The `view_range` parameter is not allowed when `path` points to a directory.',
          );
        }

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

      // Expand tabs to 4 spaces for consistent display
      let fileContent = (await WorkspaceFS.read(filePath)).replaceAll(
        '\t',
        '    ',
      );
      let initLine = 1;

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

        const fileLines = fileContent.split(/\r?\n/);
        const numLines = fileLines.length;
        const [startLine, endLine] = viewRange;

        if (startLine < 1 || startLine > numLines) {
          throw new ToolError(
            `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its first element \`${startLine}\` should be within the range of lines of the file: [1, ${numLines}]`,
          );
        }

        if (endLine !== -1) {
          if (endLine > numLines) {
            throw new ToolError(
              `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be smaller than the number of lines in the file: \`${numLines}\``,
            );
          }
          if (endLine < startLine) {
            throw new ToolError(
              `Invalid \`view_range\`: [${startLine}, ${endLine}]. Its second element \`${endLine}\` should be larger or equal than its first \`${startLine}\``,
            );
          }
        }

        initLine = startLine;
        const sliceEnd = endLine === -1 ? undefined : endLine;
        fileContent = fileLines.slice(startLine - 1, sliceEnd).join('\n');
      }

      recordToolFileRead(filePath);

      let summary: string;
      if (viewRange) {
        const endLabel = viewRange[1] === -1 ? 'end' : String(viewRange[1]);
        summary = `View ${filePath} (${viewRange[0]}-${endLabel})`;
      } else {
        summary = `View ${filePath}`;
      }

      return {
        summary,
        output: this.makeOutput(fileContent, filePath, initLine),
      };
    } catch (error) {
      rethrowWithContext(error, `Error viewing ${filePath}`);
    }
  }

  private async create(filePath: string, content: string): Promise<ToolResult> {
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
          filePath,
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
        filePath,
        proposedContent,
        appliedContent,
      );
      const output = userDiffNote
        ? `File created successfully at: ${filePath}\n\n${userDiffNote}`
        : `File created successfully at: ${filePath}`;

      return {
        summary: `Created file ${filePath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: filePath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      throw new ToolError(`Error creating file ${filePath}: ${error}`);
    }
  }

  private async strReplace(
    filePath: string,
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
          `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${filePath}.`,
        );
      }

      if (occurrences > 1) {
        const lines = expandedFileContent.split(/\r?\n/);
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
          filePath,
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
      const finalContent = appliedContent;

      recordToolFileRead(filePath);

      const textBeforeReplacement =
        expandedFileContent.split(expandedOldStr)[0];
      const replacementLine =
        (textBeforeReplacement.match(/\n/g) ?? []).length + 1;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) ?? []).length;

      const newFileLines = finalContent.split('\n');
      const snippet = newFileLines.slice(startLine - 1, endLine).join('\n');

      const userDiffNote = formatUnifiedApprovalUserDiff(
        filePath,
        newFileContent,
        finalContent,
      );
      const successIntro = `The file ${filePath} has been edited.`;
      const snippetOutput = this.makeOutput(
        snippet,
        `a snippet of ${filePath}`,
        startLine,
      );
      const reviewMessage =
        'Review the changes and make sure they are as expected. Edit the file again if necessary.';
      const baseMsg = `${successIntro} ${snippetOutput}${reviewMessage}`;
      const successMsg = userDiffNote
        ? `${baseMsg}\n\n${userDiffNote}`
        : baseMsg;

      return {
        summary: `Updated ${filePath}`,
        output: successMsg,
        userPatch: approval.userPatch,
        edits: [{ path: filePath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error replacing text in ${filePath}`);
    }
  }

  private async insert(
    filePath: string,
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

      const fileLines = expandedFileContent.split(/\r?\n/);
      const numLines = fileLines.length;

      if (insertLine < 1 || insertLine > numLines + 1) {
        throw new ToolError(
          `Invalid \`insert_line\`: ${insertLine}. Should be in range [1, ${numLines + 1}] (1-indexed, insert after line N).`,
        );
      }

      const newStrLines = expandedNewStr.split(/\r?\n/);
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
          filePath,
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
      const finalContent = appliedContent;

      recordToolFileRead(filePath);

      const previewLines = finalContent.split('\n');
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
      const userDiffNote = formatUnifiedApprovalUserDiff(
        filePath,
        newFileContent,
        finalContent,
      );

      const successIntro = `The file ${filePath} has been edited.`;
      const snippetOutput = this.makeOutput(
        snippetText,
        'a snippet of the edited file',
        startLine,
      );
      const reviewNote =
        'Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.';
      const baseMsg = `${successIntro} ${snippetOutput}${reviewNote}`;
      const successMsg = userDiffNote
        ? `${baseMsg}\n\n${userDiffNote}`
        : baseMsg;

      return {
        summary: `Inserted text into ${filePath}`,
        output: successMsg,
        userPatch: approval.userPatch,
        edits: [{ path: filePath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error inserting text in ${filePath}`);
    }
  }

  private async undoEdit(filePath: string): Promise<ToolResult> {
    try {
      const history = this.fileHistory.get(filePath);
      if (!history || history.length === 0) {
        throw new ToolError(`No edit history found for ${filePath}.`);
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
          filePath,
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
      const finalContent = appliedContent;

      recordToolFileRead(filePath);

      if (history.length === 0) {
        this.fileHistory.delete(filePath);
      }

      const userDiffNote = formatUnifiedApprovalUserDiff(
        filePath,
        previousContent,
        finalContent,
      );
      const baseOutput = `Last edit to ${filePath} undone successfully. ${this.makeOutput(finalContent, filePath)}`;
      const output = userDiffNote
        ? `${baseOutput}\n${userDiffNote}`
        : baseOutput;

      return {
        summary: `Undid edit on ${filePath}`,
        output,
        userPatch: approval.userPatch,
        edits: [{ path: filePath, lineChanges: approval.lineChanges }],
      };
    } catch (error) {
      rethrowWithContext(error, `Error undoing edit to ${filePath}`);
    }
  }

  private addToHistory(filePath: string, content: string): void {
    if (!this.fileHistory.has(filePath)) {
      this.fileHistory.set(filePath, []);
    }
    this.fileHistory.get(filePath)!.push(content);
  }

  private makeOutput(
    content: string,
    fileDescriptor: string,
    initLine: number = 1,
  ): string {
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
