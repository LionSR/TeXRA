// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports - tool definitions
import {
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { isTexFile } from '@common/files/fileTypeUtils';
import * as logger from '@logger/logUtils';
import replacementEngine from '@replacement/engine';
import { ToolResult, ToolError } from '@shared/schemas/toolResult';
import {
  applyApprovedFileEdit,
  loadEditableFile,
  replaceLiteralMatches,
} from '@tools/fileEditFlow';
import { recordToolFileRead } from '@tools/fileInteractions';
import { assertNever } from '@utils/core';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import { formatFileView, formatLinesWithNumbers } from './formatting';
import {
  assertWritable,
  resolveAndFormat,
  currentToolRoot,
} from './pathResolution';
import { requireField } from './utils';

// Constants
const CHANNEL = 'TextEditorTool';
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

type TextEditorApiType = keyof typeof API_TYPE_TO_NAME;

const TextEditorInputSchema = z.strictObject({
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
  requiresApproval: true,
  description: 'Edit files using search and replace or insertion operations',
  schema: TextEditorInputSchema,
}) {
  // Tool API type
  private apiType: TextEditorApiType;

  // File history for undo operations
  private fileHistory: Map<string, string[]> = new Map();

  /**
   * Cap on retained full-file snapshots per (execution, file) key.
   * `undo_edit` only ever pops the most recent snapshot (`history.at(-1)`),
   * so trimming the oldest entries beyond this depth never changes that
   * behavior — deep multi-level undo past this many edits in a single
   * execution isn't a documented or relied-upon usage pattern. Without this,
   * a long execution that edits the same file many times without ever
   * calling undo_edit retains every historical version of that file for the
   * rest of the process's lifetime (fileHistory is a process-wide
   * singleton, never cleared per-execution).
   */
  private static readonly MAX_HISTORY_PER_FILE = 50;

  constructor(apiType: TextEditorApiType = 'text_editor_20250124') {
    const name = API_TYPE_TO_NAME[apiType];
    super({ name });
    this.apiType = apiType;
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
        return assertNever(command, 'Unrecognized TextEditor command');
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
          status: 'executed',
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
      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: '',
        proposedContent,
        sourceTool: 'text_editor:create',
        beforeWrite: async () => {
          const dirPath = path.dirname(filePath);
          if (dirPath !== '.') {
            await WorkspaceFS.ensureDir(dirPath);
          }
        },
        present: () => ({
          summary: `Created file ${displayPath}`,
          output: `File created successfully at: ${displayPath}`,
        }),
      });
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
      const loaded = await loadEditableFile(filePath);
      if ('blocked' in loaded) {
        return loaded.blocked;
      }
      const fileContent = loaded.originalContent;
      const expandedFileContent = fileContent.replaceAll('\t', '    ');

      const expandedOldStr = oldStr.replaceAll('\t', '    ');
      const expandedNewStr = newStr.replaceAll('\t', '    ');

      if (expandedOldStr.length === 0) {
        throw new ToolError(
          `old_str must not be empty for ${displayPath}. Provide the exact text to replace.`,
        );
      }

      const replacement = replaceLiteralMatches({
        content: expandedFileContent,
        search: expandedOldStr,
        replacement: expandedNewStr,
        mode: 'unique',
        notFoundError: () =>
          `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${displayPath}.`,
        multipleMatchesError: ({ lineNumbers }) =>
          `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines ${lineNumbers.join(', ')}. Please ensure it is unique`,
      });

      const newFileContent = replacement.content;

      const replacementLine = replacement.firstMatchLine;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) ?? []).length;

      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: fileContent,
        proposedContent: newFileContent,
        sourceTool: 'text_editor:str_replace',
        afterWrite: ({ appliedContent, baseContent }) => {
          if (appliedContent !== baseContent) {
            this.addToHistory(filePath, baseContent);
          }
        },
        present: ({ appliedContent }) => {
          const snippet = appliedContent
            .split('\n')
            .slice(startLine - 1, endLine)
            .join('\n');
          return {
            summary: `Updated ${displayPath}`,
            output:
              `The file ${displayPath} has been edited. ` +
              this.makeOutput(snippet, startLine) +
              'Review the changes and make sure they are as expected. Edit the file again if necessary.',
          };
        },
      });
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
      const loaded = await loadEditableFile(filePath);
      if ('blocked' in loaded) {
        return loaded.blocked;
      }
      const fileContent = loaded.originalContent;
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

      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: fileContent,
        proposedContent: newFileContent,
        sourceTool: 'text_editor:insert',
        afterWrite: ({ appliedContent, baseContent }) => {
          if (appliedContent !== baseContent) {
            this.addToHistory(filePath, baseContent);
          }
        },
        present: ({ appliedContent }) => {
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
          return {
            summary: `Inserted text into ${displayPath}`,
            output:
              `The file ${displayPath} has been edited. ` +
              this.makeOutput(snippetText, startLine) +
              'Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.',
          };
        },
      });
    } catch (error) {
      rethrowWithContext(error, `Error inserting text in ${displayPath}`);
    }
  }

  private async undoEdit(
    filePath: string,
    displayPath: string,
  ): Promise<ToolResult> {
    try {
      const key = this.historyKey(filePath);
      const history = this.fileHistory.get(key);
      if (!history || history.length === 0) {
        throw new ToolError(`No edit history found for ${displayPath}.`);
      }

      const loaded = await loadEditableFile(filePath);
      if ('blocked' in loaded) {
        return loaded.blocked;
      }

      const previousContent = history.at(-1)!;
      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: loaded.originalContent,
        proposedContent: previousContent,
        sourceTool: 'text_editor:undo_edit',
        diffSeparator: '\n',
        afterWrite: () => {
          history.pop();
          if (history.length === 0) {
            this.fileHistory.delete(key);
          }
        },
        present: ({ appliedContent }) => ({
          summary: `Undid edit on ${displayPath}`,
          output: `Last edit to ${displayPath} undone successfully. ${this.makeOutput(appliedContent)}`,
        }),
      });
    } catch (error) {
      rethrowWithContext(error, `Error undoing edit to ${displayPath}`);
    }
  }

  /**
   * Scope undo history to the run that produced the edit. `fileHistory` is a
   * process singleton (one TextEditorTool in the default registry), so keying by
   * path alone bleeds edits across concurrent runs — a non-awaited subagent and
   * its parent editing the same absolute path share the stack, so undo_edit could
   * pop, or silently write to disk under YOLO, a foreign run's snapshot. Keying
   * by the active run's executionId isolates them; with no run context
   * (tests/manual) it collapses to the prior path-only behavior.
   */
  private historyKey(filePath: string): string {
    return `${getRunContextExecutionId(tryUseRunContext()) ?? ''}\u0000${filePath}`;
  }

  private addToHistory(filePath: string, content: string): void {
    const key = this.historyKey(filePath);
    const history = this.fileHistory.get(key);
    if (history) {
      history.push(content);
      if (history.length > TextEditorTool.MAX_HISTORY_PER_FILE) {
        history.shift();
      }
    } else {
      this.fileHistory.set(key, [content]);
    }
  }

  private makeOutput(content: string, initLine: number = 1): string {
    const lines = splitContentLines(content);
    return '\n' + formatLinesWithNumbers(lines, initLine).join('\n') + '\n';
  }
}
