// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - filesystem utilities
import { StorageFS } from '@utils/files';

// Local imports - tool core
import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';

// Local imports - shared memory constants and utilities
import {
  MEMORY_DISPLAY_ROOT,
  MEMORY_STORAGE_ROOT,
  MAX_VIEW_LINES,
  LINE_NUMBER_WIDTH,
  DIRECTORY_LISTING_DEPTH,
  shouldSkipEntry,
} from './constants';
import { toDisplayPath, formatSize, displayToStoragePath } from './memoryUtils';

const MemoryToolInputSchema = z.strictObject({
  command: z.enum([
    'view',
    'create',
    'str_replace',
    'insert',
    'delete',
    'rename',
  ]),
  path: z.string().nullish(),
  file_text: z.string().nullish(),
  view_range: z
    .array(z.int().min(1))
    .length(2)
    .refine(([start, end]) => end >= start, {
      error: 'view_range[1] must be greater than or equal to view_range[0]',
    })
    .nullish(),
  old_str: z.string().nullish(),
  new_str: z.string().nullish(),
  insert_line: z.int().min(0).nullish(),
  insert_text: z.string().nullish(),
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
});

/** Derived from MemoryToolInputSchema - single source of truth */
export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

/**
 * Memory tool for managing persistent context files under /memories.
 */
export class MemoryTool extends defineTool({
  name: 'memory',
  description:
    'Store, read, and manage persistent memory files under /memories using view, create, str_replace, insert, delete, or rename.',
  schema: MemoryToolInputSchema,
}) {
  protected async execute(input: MemoryToolInput): Promise<ToolResult> {
    switch (input.command) {
      case 'view':
        return this.view(
          this.requirePath(input.path, input.command),
          input.view_range ?? undefined,
        );
      case 'create':
        return this.create(
          this.requirePath(input.path, input.command),
          this.requireField(input.file_text, 'file_text', input.command),
        );
      case 'str_replace':
        return this.strReplace(
          this.requirePath(input.path, input.command),
          this.requireField(input.old_str, 'old_str', input.command),
          this.requireField(input.new_str, 'new_str', input.command),
        );
      case 'insert':
        return this.insert(
          this.requirePath(input.path, input.command),
          this.requireField(input.insert_line, 'insert_line', input.command),
          this.requireField(
            input.insert_text ?? input.new_str,
            'insert_text',
            input.command,
          ),
        );
      case 'delete':
        return this.delete(this.requirePath(input.path, input.command));
      case 'rename':
        return this.rename(
          this.requireField(input.old_path, 'old_path', input.command),
          this.requireField(input.new_path, 'new_path', input.command),
        );
      default:
        throw new ToolError(`Unrecognized command: ${input.command}`);
    }
  }

  private requirePath(
    value: string | null | undefined,
    command: string,
  ): string {
    if (!value) {
      throw new ToolError(
        `Parameter \`path\` is required for command: ${command}`,
      );
    }
    return value;
  }

  private requireField<T>(
    value: T | null | undefined,
    name: string,
    command: string,
  ): T {
    // eslint-disable-next-line eqeqeq -- use nullish check for tool inputs
    if (value == null) {
      throw new ToolError(
        `Parameter \`${name}\` is required for command: ${command}`,
      );
    }
    return value;
  }

  private resolveMemoryPath(inputPath: string): string {
    try {
      return displayToStoragePath(inputPath);
    } catch {
      throw new ToolError(
        `The path ${inputPath} does not exist. Please provide a valid path.`,
      );
    }
  }

  private async view(
    inputPath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(
        `The path ${inputPath} does not exist. Please provide a valid path.`,
      );
    }

    const stats = await StorageFS.stat(resolvedPath);
    if (stats.type === vscode.FileType.Directory) {
      const listing = await this.buildDirectoryListing(resolvedPath);
      return {
        output: [
          `Here're the files and directories up to 2 levels deep in ${inputPath}, excluding hidden items and node_modules:`,
          ...listing,
        ].join('\n'),
      };
    }

    const content = await StorageFS.read(resolvedPath);
    const lines = content.split(/\r?\n/);
    if (lines.length > 0 && lines.at(-1) === '') {
      lines.pop();
    }
    if (lines.length > MAX_VIEW_LINES) {
      throw new ToolError(
        `File ${inputPath} exceeds maximum line limit of 999,999 lines.`,
      );
    }

    const [start, end] = viewRange ?? [1, lines.length];
    const startIndex = Math.max(start - 1, 0);
    const endIndex = Math.min(end, lines.length);
    const selected = lines.slice(startIndex, endIndex);

    const numbered = selected.map((line, index) => {
      const lineNumber = (startIndex + index + 1)
        .toString()
        .padStart(LINE_NUMBER_WIDTH, ' ');
      return `${lineNumber}\t${line}`;
    });

    return {
      output: [
        `Here's the content of ${inputPath} with line numbers:`,
        ...numbered,
      ].join('\n'),
    };
  }

  private async create(
    inputPath: string,
    fileText: string,
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (exists) {
      throw new ToolError(`Error: File ${inputPath} already exists`);
    }

    await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
    await StorageFS.ensureDir(path.dirname(resolvedPath));
    await StorageFS.write(resolvedPath, fileText);

    return {
      output: `File created successfully at: ${inputPath}`,
    };
  }

  private async strReplace(
    inputPath: string,
    oldStr: string,
    newStr: string,
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(
        `Error: The path ${inputPath} does not exist. Please provide a valid path.`,
      );
    }

    const isDir = await StorageFS.isDir(resolvedPath);
    if (isDir) {
      throw new ToolError(
        `Error: The path ${inputPath} does not exist. Please provide a valid path.`,
      );
    }

    const content = await StorageFS.read(resolvedPath);
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      throw new ToolError(
        `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${inputPath}.`,
      );
    }

    const lines = content.split(/\r?\n/);
    if (occurrences > 1) {
      const lineNumbers = lines
        .map((line, index) => (line.includes(oldStr) ? index + 1 : null))
        .filter((lineNumber): lineNumber is number => lineNumber !== null);
      throw new ToolError(
        `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${lineNumbers.join(
          ', ',
        )}. Please ensure it is unique`,
      );
    }

    const updated = content.replace(oldStr, newStr);
    await StorageFS.write(resolvedPath, updated);

    const updatedLines = updated.split(/\r?\n/);
    const numbered = updatedLines.map((line, index) => {
      const lineNumber = (index + 1)
        .toString()
        .padStart(LINE_NUMBER_WIDTH, ' ');
      return `${lineNumber}\t${line}`;
    });

    return {
      output: [
        'The memory file has been edited.',
        `Here's the content of ${inputPath} with line numbers:`,
        ...numbered,
      ].join('\n'),
    };
  }

  private async insert(
    inputPath: string,
    insertLine: number,
    insertText: string,
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(`Error: The path ${inputPath} does not exist`);
    }

    const isDir = await StorageFS.isDir(resolvedPath);
    if (isDir) {
      throw new ToolError(`Error: The path ${inputPath} does not exist`);
    }

    const content = await StorageFS.read(resolvedPath);
    const lines = content.split(/\r?\n/);
    const totalLines = lines.length;
    if (insertLine < 0 || insertLine > totalLines) {
      throw new ToolError(
        `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${totalLines}]`,
      );
    }

    const insertLines = insertText.split(/\r?\n/);
    const updatedLines = [
      ...lines.slice(0, insertLine),
      ...insertLines,
      ...lines.slice(insertLine),
    ];

    await StorageFS.write(resolvedPath, updatedLines.join('\n'));

    return {
      output: `The file ${inputPath} has been edited.`,
    };
  }

  private async delete(inputPath: string): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(`Error: The path ${inputPath} does not exist`);
    }

    await StorageFS.delete(resolvedPath, { recursive: true });
    return {
      output: `Successfully deleted ${inputPath}`,
    };
  }

  private async rename(
    oldPathInput: string,
    newPathInput: string,
  ): Promise<ToolResult> {
    const resolvedOldPath = this.resolveMemoryPath(oldPathInput);
    const resolvedNewPath = this.resolveMemoryPath(newPathInput);

    const oldExists = await StorageFS.exists(resolvedOldPath);
    if (!oldExists) {
      throw new ToolError(`Error: The path ${oldPathInput} does not exist`);
    }

    const newExists = await StorageFS.exists(resolvedNewPath);
    if (newExists) {
      throw new ToolError(
        `Error: The destination ${newPathInput} already exists`,
      );
    }

    await StorageFS.rename(resolvedOldPath, resolvedNewPath);
    return {
      output: `Successfully renamed ${oldPathInput} to ${newPathInput}`,
    };
  }

  private async buildDirectoryListing(resolvedPath: string): Promise<string[]> {
    const entries: Array<{ path: string; size: number }> = [];
    const rootStats = await StorageFS.stat(resolvedPath);
    entries.push({ path: resolvedPath, size: rootStats.size });

    await this.walkDirectory(resolvedPath, 0, entries);

    return entries.map((entry) => {
      const display = toDisplayPath(entry.path);
      return `${formatSize(entry.size)}\t${display}`;
    });
  }

  private async walkDirectory(
    currentPath: string,
    depth: number,
    entries: Array<{ path: string; size: number }>,
  ): Promise<void> {
    if (depth >= DIRECTORY_LISTING_DEPTH) {
      return;
    }

    const children = await StorageFS.readDir(currentPath);
    for (const [name, type] of children) {
      if (shouldSkipEntry(name)) {
        continue;
      }
      const childPath = path.join(currentPath, name);
      const stats = await StorageFS.stat(childPath);
      entries.push({ path: childPath, size: stats.size });

      if (
        type === vscode.FileType.Directory &&
        depth + 1 < DIRECTORY_LISTING_DEPTH
      ) {
        await this.walkDirectory(childPath, depth + 1, entries);
      }
    }
  }
}
