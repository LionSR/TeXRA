// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports - tool definitions
import {
  getRunContextExecutionId,
  getRunContextSession,
  tryUseRunContext,
  type RunContext,
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
import { executed } from '@tools/core/result';
import { assertNever } from '@utils/core';
import { WorkspaceFS, AbsoluteFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory } from '@utils/files/fsEntryType';
import { splitContentLines } from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from './core/define';
import {
  formatFileView,
  formatLinesWithNumbers,
  sliceLineRange,
} from './formatting';
import {
  assertWritable,
  resolveAndFormat,
  currentToolRoot,
} from './pathResolution';

// Constants
const CHANNEL = 'TextEditorTool';
const SNIPPET_LINES = 4;

/** Columns a literal tab expands to when normalizing text for display and matching. */
const TAB_WIDTH = 4;

/**
 * Expand tabs to spaces so file views and `str_replace`/`insert` matching stay
 * consistent regardless of whether the file uses tabs or spaces.
 */
function expandTabs(text: string): string {
  return text.replaceAll('\t', ' '.repeat(TAB_WIDTH));
}

/** Rethrow ToolError as-is; wrap other errors with context message */
function rethrowWithContext(error: unknown, context: string): never {
  if (error instanceof ToolError) {
    throw error;
  }
  throw new ToolError(`${context}: ${toErrorMessage(error)}`, { cause: error });
}

/**
 * Undo snapshots keyed by execution, then by file path. Owns the two-level
 * get-or-create/prune bookkeeping in one place instead of spreading it across
 * every caller that touches the nested map.
 */
class ExecutionFileHistory {
  private readonly byExecution = new Map<string, Map<string, string[]>>();

  hasExecution(executionId: string): boolean {
    return this.byExecution.has(executionId);
  }

  /** Record a pre-edit snapshot, trimming the oldest once `maxPerFile` is exceeded. */
  push(
    executionId: string,
    filePath: string,
    content: string,
    maxPerFile: number,
  ): void {
    let files = this.byExecution.get(executionId);
    if (!files) {
      files = new Map();
      this.byExecution.set(executionId, files);
    }
    const history = files.get(filePath);
    if (!history) {
      files.set(filePath, [content]);
      return;
    }
    history.push(content);
    if (history.length > maxPerFile) history.shift();
  }

  /** Most recent snapshot for a file, or `undefined` if none was recorded. */
  last(executionId: string, filePath: string): string | undefined {
    return this.byExecution.get(executionId)?.get(filePath)?.at(-1);
  }

  /**
   * Pop the most recent snapshot, pruning the file entry once empty. The
   * execution entry stays until `clearExecution`, so `hasExecution` reports
   * "already observed" for the whole execution and the completion listener is
   * registered exactly once.
   */
  popLast(executionId: string, filePath: string): void {
    const files = this.byExecution.get(executionId);
    const history = files?.get(filePath);
    if (!files || !history) return;
    history.pop();
    if (history.length === 0) files.delete(filePath);
  }

  clearExecution(executionId: string): void {
    this.byExecution.delete(executionId);
  }

  /** Read-only per-file snapshot view for one execution (test inspection only). */
  filesFor(
    executionId: string,
  ): ReadonlyMap<string, readonly string[]> | undefined {
    return this.byExecution.get(executionId);
  }
}

// Branches use looseObject (not strictObject): after flattenTopLevelUnion()
// merges every branch's properties into one JSON schema for OpenAI/Gemini/
// Anthropic tool-calling, some OpenAI-compatible providers (DeepSeek, Kimi,
// ...) fill every advertised property — including ones only relevant to a
// different command — with null rather than omitting them. A strictObject
// branch rejects that as an unrecognized key regardless of nullability;
// looseObject tolerates the cross-branch leakage while still enforcing each
// branch's own required fields. See AGENTS.md "Tool input schemas".
const TextEditorInputSchema = z.discriminatedUnion('command', [
  z.looseObject({
    command: z.literal('view'),
    path: z.string(),
    view_range: z
      .array(z.number())
      .length(2)
      .nullish()
      .describe('1-indexed. Use -1 for EOF.'),
  }),
  z.looseObject({
    command: z.literal('create'),
    path: z.string(),
    file_text: z.string(),
  }),
  z.looseObject({
    command: z.literal('str_replace'),
    path: z.string(),
    old_str: z.string(),
    new_str: z.string().nullish(),
  }),
  z.looseObject({
    command: z.literal('insert'),
    path: z.string(),
    insert_line: z.number().describe('1-indexed.'),
    new_str: z.string(),
  }),
  z.looseObject({
    command: z.literal('undo_edit'),
    path: z.string(),
  }),
]);

/** Derived from TextEditorInputSchema - single source of truth */
type TextEditorInput = z.infer<typeof TextEditorInputSchema>;

/** Command type derived from TextEditorInputSchema */
type EditorCommand = TextEditorInput['command'];

/**
 * Implementation of Anthropic's text editor tool for VS Code
 */
export class TextEditorTool extends defineTool({
  name: 'str_replace_editor',
  requiresApproval: true,
  description: 'Edit files using search and replace or insertion operations',
  schema: TextEditorInputSchema,
}) {
  // Undo snapshots owned by the execution that created them.
  private readonly fileHistory = new ExecutionFileHistory();

  /**
   * Cap on retained full-file snapshots per execution and file.
   * `undo_edit` only ever pops the most recent snapshot (`history.at(-1)`),
   * so trimming the oldest entries beyond this depth never changes that
   * behavior — deep multi-level undo past this many edits in a single
   * execution isn't a documented or relied-upon usage pattern. Without this,
   * a long execution that edits the same file many times without ever
   * calling undo_edit retains every historical version of that file for the
   * lifetime of a long-running execution.
   */
  private static readonly MAX_HISTORY_PER_FILE = 50;

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
      case 'create':
        logger.info(CHANNEL, `create: ${displayPath}`);
        return this.create(filePath, displayPath, input.file_text);
      case 'str_replace':
        logger.info(
          CHANNEL,
          `str_replace: ${input.old_str} -> ${input.new_str}`,
        );
        return this.strReplace(
          filePath,
          displayPath,
          input.old_str,
          input.new_str ?? '',
        );
      case 'insert':
        logger.info(
          CHANNEL,
          `insert: ${input.insert_line} -> ${input.new_str}`,
        );
        return this.insert(
          filePath,
          displayPath,
          input.insert_line,
          input.new_str,
        );
      case 'undo_edit':
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
    const stats = await AbsoluteFS.stat(WorkspaceFS.fullPath(filePath)).catch(
      (error: unknown) => rethrowWithContext(error, 'Error validating path'),
    );
    if (isDirectory(stats.type) && command !== 'view') {
      throw new ToolError(
        `The path ${displayPath} is a directory and only the 'view' command can be used on directories`,
      );
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

        return executed(formattedContents, `Listed directory: ${displayPath}`);
      }

      const fileContent = expandTabs(await WorkspaceFS.read(filePath));
      const lines = splitContentLines(fileContent);
      const totalLines = lines.length;

      let range: [number, number] | null = null;

      if (viewRange) {
        const [startLine, endLine] = viewRange;
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
          throw new ToolError(
            'Invalid `view_range`. It should be a list of two integers.',
          );
        }

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

        range = [startLine, endLine === -1 ? totalLines : endLine];
      }

      recordToolFileRead(filePath);

      return formatFileView({
        path: displayPath,
        lines,
        viewRange: range,
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
      const expandedFileContent = expandTabs(fileContent);

      const expandedOldStr = expandTabs(oldStr);
      const expandedNewStr = expandTabs(newStr);

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

      const replacementLine = replacement.firstMatchLine;
      const startLine = Math.max(1, replacementLine - SNIPPET_LINES);
      const endLine =
        replacementLine + SNIPPET_LINES + (newStr.match(/\n/g) ?? []).length;

      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: fileContent,
        proposedContent: replacement.content,
        sourceTool: 'text_editor:str_replace',
        afterWrite: this.undoHistoryAfterWrite(filePath),
        present: ({ appliedContent }) => {
          const snippet = sliceLineRange(
            appliedContent.split('\n'),
            startLine,
            endLine,
          ).join('\n');
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
      const expandedFileContent = expandTabs(fileContent);

      const expandedNewStr = expandTabs(newStr);

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
        afterWrite: this.undoHistoryAfterWrite(filePath),
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
      const executionId = this.currentExecutionId();
      const previousContent = this.fileHistory.last(executionId, filePath);
      if (previousContent === undefined) {
        throw new ToolError(`No edit history found for ${displayPath}.`);
      }

      const loaded = await loadEditableFile(filePath);
      if ('blocked' in loaded) {
        return loaded.blocked;
      }

      return applyApprovedFileEdit({
        path: filePath,
        displayPath,
        originalContent: loaded.originalContent,
        proposedContent: previousContent,
        sourceTool: 'text_editor:undo_edit',
        diffSeparator: '\n',
        afterWrite: () => {
          this.fileHistory.popLast(executionId, filePath);
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
   * Resolve the history owned by the active execution. Calls made with no run
   * context share one unnamed execution scope.
   */
  private currentExecutionId(context = tryUseRunContext()): string {
    return getRunContextExecutionId(context) ?? '';
  }

  /** `afterWrite` callback recording pre-edit content for undo, only when the write actually changed the file. */
  private undoHistoryAfterWrite(
    filePath: string,
  ): (edit: { appliedContent: string; baseContent: string }) => void {
    return ({ appliedContent, baseContent }) => {
      if (appliedContent !== baseContent) {
        this.addToHistory(filePath, baseContent);
      }
    };
  }

  private addToHistory(filePath: string, content: string): void {
    const context = tryUseRunContext();
    const executionId = this.currentExecutionId(context);
    const isNewExecution = !this.fileHistory.hasExecution(executionId);
    this.fileHistory.push(
      executionId,
      filePath,
      content,
      TextEditorTool.MAX_HISTORY_PER_FILE,
    );
    if (isNewExecution) {
      this.observeExecutionCompletion(executionId, context);
    }
  }

  /** Release all snapshots when their owning execution leaves the registry. */
  private observeExecutionCompletion(
    executionId: string,
    context: RunContext | undefined,
  ): void {
    if (!executionId) return;

    const registry = getRunContextSession(context)?.executions;
    if (!registry?.getHandle(executionId)) return;

    // The registry releases persistent listeners after this terminal callback.
    registry.addListener(executionId, (handle) => {
      if (handle) return;
      this.fileHistory.clearExecution(executionId);
    });
  }

  private makeOutput(content: string, initLine: number = 1): string {
    const lines = splitContentLines(content);
    return '\n' + formatLinesWithNumbers(lines, initLine).join('\n') + '\n';
  }
}
