// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports - filesystem utilities
import { formatRelativeTime } from '@shared/utils/string';
import { StorageFS } from '@utils/files';
import { normalizeLineEndings } from '@utils/text/stringUtils';

// Local imports - tool core
import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '../fileInteractions';
import {
  countOccurrences,
  formatLinesWithNumbers,
  requireField,
} from '../utils';
import { getCurrentToolFileInteractionContext } from '@agent/toolUse/ToolFileInteractionContext';

// Local imports - shared memory constants and utilities
import {
  MEMORY_DISPLAY_ROOT,
  MEMORY_STORAGE_ROOT,
  MAX_VIEW_LINES,
  DIRECTORY_LISTING_DEPTH,
  shouldSkipEntry,
} from './constants';
import { toDisplayPath, formatSize, displayToStoragePath } from './memoryUtils';
import {
  parseFrontmatter,
  buildFile,
  createMeta,
  formatAttribution,
} from './memoryMeta';

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
  description: `Manage persistent memory files under /memories (view, create, str_replace, insert, delete, rename).

Paths must start with /memories. Use /memories to list files, /memories/file.md for specific files. "/" alone is invalid.`,
  schema: MemoryToolInputSchema,
}) {
  protected async execute(input: MemoryToolInput): Promise<ToolResult> {
    switch (input.command) {
      case 'view':
        return this.view(
          requireField(input.path, 'path', input.command),
          input.view_range ?? undefined,
        );
      case 'create':
        return this.create(
          requireField(input.path, 'path', input.command),
          requireField(input.file_text, 'file_text', input.command),
        );
      case 'str_replace':
        return this.strReplace(
          requireField(input.path, 'path', input.command),
          requireField(input.old_str, 'old_str', input.command),
          requireField(input.new_str, 'new_str', input.command),
        );
      case 'insert':
        return this.insert(
          requireField(input.path, 'path', input.command),
          requireField(input.insert_line, 'insert_line', input.command),
          requireField(
            input.insert_text ?? input.new_str,
            'insert_text',
            input.command,
          ),
        );
      case 'delete':
        return this.delete(requireField(input.path, 'path', input.command));
      case 'rename':
        return this.rename(
          requireField(input.old_path, 'old_path', input.command),
          requireField(input.new_path, 'new_path', input.command),
        );
      default:
        throw new ToolError(`Unrecognized command: ${input.command}`);
    }
  }

  /** Read a memory file, stripping frontmatter. Returns user-visible content and optional metadata. */
  private async readMemoryFile(resolvedPath: string) {
    const raw = normalizeLineEndings(await StorageFS.read(resolvedPath));
    return parseFrontmatter(raw);
  }

  /** Write a memory file with fresh attribution frontmatter. */
  private async writeMemoryFile(
    resolvedPath: string,
    content: string,
  ): Promise<void> {
    const ctx = getCurrentToolFileInteractionContext();
    const meta = createMeta(ctx?.agentName, ctx?.executionId);
    await StorageFS.write(resolvedPath, buildFile(content, meta));
  }

  private resolveMemoryPath(inputPath: string): string {
    try {
      return displayToStoragePath(inputPath);
    } catch {
      throw new ToolError(
        `Invalid path "${inputPath}". All memory paths must start with /memories (e.g., /memories or /memories/notes.md).`,
      );
    }
  }

  private async requireEditableFile(
    resolvedPath: string,
    inputPath: string,
  ): Promise<void> {
    const exists = await StorageFS.exists(resolvedPath);
    const isDir = exists && (await StorageFS.isDir(resolvedPath));
    if (!exists || isDir) {
      throw new ToolError(
        `The path ${inputPath} does not exist or is a directory.`,
      );
    }
  }

  private async view(
    inputPath: string,
    viewRange?: number[],
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);

    // Handle non-existent root directory gracefully - return empty listing
    // instead of error (consistent with MemoryViewMessageHandler behavior)
    if (!exists) {
      if (resolvedPath === MEMORY_STORAGE_ROOT) {
        return {
          summary: 'Viewed empty memory directory',
          output: `The memory directory is empty. This is a fresh start - use the create command to add memory files.`,
        };
      }
      throw new ToolError(
        `The path ${inputPath} does not exist. Please provide a valid path.`,
      );
    }

    const stats = await StorageFS.stat(resolvedPath);
    if (stats.type === vscode.FileType.Directory) {
      const listing = await this.buildDirectoryListing(resolvedPath);
      return {
        summary: `Listed directory: ${inputPath}`,
        output: [
          `Contents of ${inputPath} (up to 2 levels deep):`,
          `SIZE\tMODIFIED\tBY\tPATH`,
          ...listing,
        ].join('\n'),
      };
    }

    const { meta, content } = await this.readMemoryFile(resolvedPath);
    recordToolFileRead(inputPath);
    const lines = content.split('\n');
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
    const numbered = formatLinesWithNumbers(selected, startIndex + 1);

    const header = meta
      ? `Here's the content of ${inputPath} (last modified by: ${formatAttribution(meta)}) with line numbers:`
      : `Here's the content of ${inputPath} with line numbers:`;

    return {
      summary: `Viewed file: ${inputPath}`,
      output: [header, ...numbered].join('\n'),
    };
  }

  private async create(
    inputPath: string,
    fileText: string,
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (exists) {
      throw new ToolError(`File ${inputPath} already exists.`);
    }

    await StorageFS.ensureDir(MEMORY_STORAGE_ROOT);
    await StorageFS.ensureDir(path.dirname(resolvedPath));
    await this.writeMemoryFile(resolvedPath, fileText);
    recordToolFileRead(inputPath);

    return {
      summary: `Created memory file: ${inputPath}`,
      output: `File created successfully at: ${inputPath}`,
    };
  }

  private async strReplace(
    inputPath: string,
    oldStr: string,
    newStr: string,
  ): Promise<ToolResult> {
    if (oldStr.length === 0) {
      throw new ToolError(
        `old_str must not be empty for ${inputPath}. Provide the exact text to replace.`,
      );
    }

    const resolvedPath = this.resolveMemoryPath(inputPath);
    await this.requireEditableFile(resolvedPath, inputPath);

    // Gate: require view before edit (matches edit_file behavior)
    const readGate = requireFileReadForEdit(
      inputPath,
      true,
      'Edits to memory files require viewing the file first. Please use the view command before editing.',
    );
    if (readGate) {
      return readGate;
    }

    const { content } = await this.readMemoryFile(resolvedPath);
    const occurrences = countOccurrences(content, oldStr);
    if (occurrences === 0) {
      throw new ToolError(
        `The provided old_str was not found in ${inputPath}. Ensure it matches the file content exactly.`,
      );
    }

    if (occurrences > 1) {
      const lines = content.split('\n');
      const lineNumbers = lines
        .map((line, index) => (line.includes(oldStr) ? index + 1 : -1))
        .filter((n) => n !== -1);
      throw new ToolError(
        `old_str is not unique within ${inputPath} (found in lines ${lineNumbers.join(', ')}). Include more surrounding context to make it unique.`,
      );
    }

    // Use indexOf/slice for literal replacement
    // (String.replace has special patterns like $$, $&, $' that corrupt content)
    const idx = content.indexOf(oldStr);
    const updated =
      content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    await this.writeMemoryFile(resolvedPath, updated);
    recordToolFileRead(inputPath);

    const updatedLines = updated.split('\n');
    const numbered = formatLinesWithNumbers(updatedLines);

    return {
      summary: `Replaced text in: ${inputPath}`,
      output: `The memory file has been edited.\nHere's the content of ${inputPath} with line numbers:\n${numbered.join('\n')}`,
    };
  }

  private async insert(
    inputPath: string,
    insertLine: number,
    insertText: string,
  ): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    await this.requireEditableFile(resolvedPath, inputPath);

    // Gate: require view before edit (matches edit_file behavior)
    const readGate = requireFileReadForEdit(
      inputPath,
      true,
      'Edits to memory files require viewing the file first. Please use the view command before editing.',
    );
    if (readGate) {
      return readGate;
    }

    const { content } = await this.readMemoryFile(resolvedPath);
    const lines = content.split('\n');
    const totalLines = lines.length;
    if (insertLine < 0 || insertLine > totalLines) {
      throw new ToolError(
        `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${totalLines}].`,
      );
    }

    const insertLines = insertText.split('\n');
    const updatedLines = [
      ...lines.slice(0, insertLine),
      ...insertLines,
      ...lines.slice(insertLine),
    ];

    await this.writeMemoryFile(resolvedPath, updatedLines.join('\n'));
    recordToolFileRead(inputPath);

    return {
      summary: `Inserted text at line ${insertLine} in: ${inputPath}`,
      output: `The file ${inputPath} has been edited.`,
    };
  }

  private async delete(inputPath: string): Promise<ToolResult> {
    const resolvedPath = this.resolveMemoryPath(inputPath);
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(`The path ${inputPath} does not exist.`);
    }

    await StorageFS.delete(resolvedPath, { recursive: true });
    return {
      summary: `Deleted: ${inputPath}`,
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
      throw new ToolError(`The path ${oldPathInput} does not exist.`);
    }

    const newExists = await StorageFS.exists(resolvedNewPath);
    if (newExists) {
      throw new ToolError(`The destination ${newPathInput} already exists.`);
    }

    await StorageFS.rename(resolvedOldPath, resolvedNewPath);
    return {
      summary: `Renamed: ${oldPathInput} to ${newPathInput}`,
      output: `Successfully renamed ${oldPathInput} to ${newPathInput}`,
    };
  }

  private async buildDirectoryListing(resolvedPath: string): Promise<string[]> {
    const entries: Array<{
      path: string;
      size: number;
      mtime: number;
      isDir: boolean;
    }> = [];
    const rootStats = await StorageFS.stat(resolvedPath);
    entries.push({
      path: resolvedPath,
      size: rootStats.size,
      mtime: rootStats.mtime,
      isDir: true,
    });

    await this.walkDirectory(resolvedPath, 0, entries);

    return Promise.all(
      entries.map(async (entry) => {
        const display = toDisplayPath(entry.path);
        const age = formatRelativeTime(entry.mtime);
        let by = '-';
        if (!entry.isDir) {
          try {
            const { meta } = await this.readMemoryFile(entry.path);
            if (meta) by = formatAttribution(meta);
          } catch {
            // Unreadable file — skip attribution
          }
        }
        return `${formatSize(entry.size)}\t${age}\t${by}\t${display}`;
      }),
    );
  }

  private async walkDirectory(
    currentPath: string,
    depth: number,
    entries: Array<{
      path: string;
      size: number;
      mtime: number;
      isDir: boolean;
    }>,
  ): Promise<void> {
    if (depth >= DIRECTORY_LISTING_DEPTH) return;

    const children = await StorageFS.readDir(currentPath);
    for (const [name, type] of children) {
      if (shouldSkipEntry(name)) continue;
      const childPath = path.join(currentPath, name);
      const stats = await StorageFS.stat(childPath);
      const isDir = type === vscode.FileType.Directory;
      entries.push({ path: childPath, size: stats.size, mtime: stats.mtime, isDir });

      if (isDir) {
        await this.walkDirectory(childPath, depth + 1, entries);
      }
    }
  }
}
