// Standard library imports
import * as path from 'path';

// Third-party imports
import { z } from 'zod';

// Local imports
import { tryUseRunContext } from '@agent/runtime/RunContext';
import { isDirectory } from '@common/files/fsEntryType';
import { formatRelativeTime } from '@shared/utils/string';
import { StorageFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';

// Local imports - tool core
import { defineTool } from '../core/define';
import { ToolError, type ToolResult } from '../result';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '../fileInteractions';
import {
  formatFileView,
  formatLinesWithNumbers,
  formatPaginationHint,
  paginateToolListing,
} from '../formatting';
import { countOccurrences, requireField } from '../utils';

// Local imports - shared memory constants and utilities
import {
  MEMORY_STORAGE_ROOT,
  MAX_VIEW_LINES,
  MAX_PINNED_MEMORIES,
  DIRECTORY_LISTING_DEPTH,
  shouldSkipEntry,
} from './constants';
import { toDisplayPath, formatSize, displayToStoragePath } from './memoryUtils';
import {
  parseFrontmatter,
  buildFile,
  createMeta,
  formatAttribution,
  setPinnedMeta,
  countPinnedMemories,
  type MemoryFileMeta,
} from './memoryMeta';

const MemoryToolInputSchema = z.strictObject({
  command: z.enum([
    'view',
    'create',
    'str_replace',
    'insert',
    'delete',
    'rename',
    'pin',
    'unpin',
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

  /** Zero-based offset for paginating directory listings (command="view" on a directory). */
  offset: z
    .int()
    .min(0)
    .nullish()
    .describe(
      'Zero-based offset into the directory listing. Use with limit for pagination. Default: 0.',
    ),

  /** Maximum entries to return from a directory listing (command="view" on a directory). */
  limit: z
    .int()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      'Max entries to return from directory listing. Default: 100, max: 200.',
    ),
});

/** Derived from MemoryToolInputSchema - single source of truth */
export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

/** Canonical pair of display path (`/memories/...`) and storage path. */
type MemoryLocation = { display: string; storage: string };

/**
 * Memory tool for managing persistent context files under /memories.
 */
export class MemoryTool extends defineTool({
  name: 'memory',
  description: `Manage persistent memory files under /memories (view, create, str_replace, insert, delete, rename, pin, unpin).

Paths must start with /memories. Use /memories to list files, /memories/file.md for specific files. "/" alone is invalid.
Directory listings are paginated — use offset/limit to page through results (default: offset 0, limit 100).

Use \`pin\` to mark a memory as a core long-term insight (techniques, strategies, pitfalls, best practices). Pinned memories are always loaded at session start. Use \`unpin\` to remove the pinned status. Maximum ${MAX_PINNED_MEMORIES} pinned memories allowed.`,
  schema: MemoryToolInputSchema,
}) {
  /**
   * Normalize a raw display path into a `{ display, storage }` pair at the
   * dispatch boundary so ops never need to call `resolveMemoryPath` themselves.
   * Throws ToolError if the path is outside `/memories`.
   */
  private locate(rawPath: string): MemoryLocation {
    const storage = this.resolveMemoryPath(rawPath);
    return { display: toDisplayPath(storage), storage };
  }

  protected async execute(input: MemoryToolInput): Promise<ToolResult> {
    const locate = (
      raw: string | undefined | null,
      field: string,
    ): MemoryLocation =>
      this.locate(requireField(raw, field, input.command));

    switch (input.command) {
      case 'view':
        return this.view(
          locate(input.path, 'path'),
          // Schema enforces length 2; cast since Zod infers number[]
          input.view_range as [number, number] | undefined,
          input.offset ?? 0,
          input.limit ?? 100,
        );
      case 'create':
        return this.create(
          locate(input.path, 'path'),
          requireField(input.file_text, 'file_text', input.command),
        );
      case 'str_replace':
        return this.strReplace(
          locate(input.path, 'path'),
          requireField(input.old_str, 'old_str', input.command),
          requireField(input.new_str, 'new_str', input.command),
        );
      case 'insert':
        return this.insert(
          locate(input.path, 'path'),
          requireField(input.insert_line, 'insert_line', input.command),
          requireField(
            input.insert_text ?? input.new_str,
            'insert_text',
            input.command,
          ),
        );
      case 'delete':
        return this.delete(locate(input.path, 'path'));
      case 'rename':
        return this.rename(
          locate(input.old_path, 'old_path'),
          locate(input.new_path, 'new_path'),
        );
      case 'pin':
        return this.pin(locate(input.path, 'path'));
      case 'unpin':
        return this.unpin(locate(input.path, 'path'));
      default:
        throw new ToolError(`Unrecognized command: ${input.command}`);
    }
  }

  /** Read a memory file, stripping frontmatter. Returns user-visible content and optional metadata. */
  private async readMemoryFile(resolvedPath: string) {
    return parseFrontmatter(await StorageFS.read(resolvedPath));
  }

  /** Write a memory file with fresh attribution frontmatter, preserving pinned status from existing file. */
  private async writeMemoryFile(
    resolvedPath: string,
    content: string,
    existingMeta?: MemoryFileMeta | null,
  ): Promise<void> {
    const ctx = tryUseRunContext();
    const meta = createMeta(ctx?.agentName, ctx?.executionId, existingMeta);
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

  /** Return early result if the file hasn't been viewed yet. */
  private requireViewBeforeModify(
    inputPath: string,
    operation = 'editing',
  ): ToolResult | undefined {
    return (
      requireFileReadForEdit(
        inputPath,
        true,
        `Modifications to memory files require viewing the file first. Please use the view command before ${operation}.`,
      ) ?? undefined
    );
  }

  private async requireEditableFile(
    resolvedPath: string,
    inputPath: string,
  ): Promise<void> {
    const errorMsg = `The path ${inputPath} does not exist or is a directory.`;
    let stats;
    try {
      stats = await StorageFS.stat(resolvedPath);
    } catch {
      throw new ToolError(errorMsg);
    }
    if (isDirectory(stats.type)) {
      throw new ToolError(errorMsg);
    }
  }

  private async view(
    loc: MemoryLocation,
    viewRange?: [number, number],
    offset = 0,
    limit = 100,
  ): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
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
    if (isDirectory(stats.type)) {
      const allEntries = await this.buildDirectoryListing(resolvedPath);
      recordToolFileRead(inputPath);

      const { page, start, end, total } = paginateToolListing(
        allEntries,
        offset,
        limit,
      );

      const header = `Contents of ${inputPath} (showing ${start}\u2013${end} of ${total}, up to 2 levels deep):`;
      return {
        summary: `Listed directory: ${inputPath} (${start}\u2013${end} of ${total})`,
        output: `${header}\nSIZE\tMODIFIED\tBY\tPATH\n${page.join('\n')}${formatPaginationHint(end, total)}`,
      };
    }

    const { meta, content } = await this.readMemoryFile(resolvedPath);
    recordToolFileRead(inputPath);
    const lines = splitContentLines(content);
    if (lines.length > MAX_VIEW_LINES) {
      throw new ToolError(
        `File ${inputPath} exceeds maximum line limit of 999,999 lines.`,
      );
    }

    // Build metadata suffix for the summary
    const metaParts: string[] = [];
    if (meta) {
      metaParts.push(`last modified by: ${formatAttribution(meta)}`);
      if (meta.pinned) metaParts.push('pinned');
    }
    const summarySuffix =
      metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';

    return formatFileView({
      path: inputPath,
      lines,
      viewRange,
      summarySuffix,
    });
  }

  private async create(
    loc: MemoryLocation,
    fileText: string,
  ): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
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
    loc: MemoryLocation,
    oldStr: string,
    newStr: string,
  ): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    if (oldStr.length === 0) {
      throw new ToolError(
        `old_str must not be empty for ${inputPath}. Provide the exact text to replace.`,
      );
    }

    await this.requireEditableFile(resolvedPath, inputPath);

    const readGate = this.requireViewBeforeModify(inputPath);
    if (readGate) return readGate;

    const { content, meta } = await this.readMemoryFile(resolvedPath);
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
    await this.writeMemoryFile(resolvedPath, updated, meta);
    recordToolFileRead(inputPath);

    const updatedLines = updated.split('\n');
    const numbered = formatLinesWithNumbers(updatedLines);

    return {
      summary: `Replaced text in: ${inputPath}`,
      output: `The file has been edited.\n${numbered.join('\n')}`,
    };
  }

  private async insert(
    loc: MemoryLocation,
    insertLine: number,
    insertText: string,
  ): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    await this.requireEditableFile(resolvedPath, inputPath);

    const readGate = this.requireViewBeforeModify(inputPath);
    if (readGate) return readGate;

    const { content, meta } = await this.readMemoryFile(resolvedPath);
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

    await this.writeMemoryFile(resolvedPath, updatedLines.join('\n'), meta);
    recordToolFileRead(inputPath);

    return {
      summary: `Inserted text at line ${insertLine} in: ${inputPath}`,
      output: `The file ${inputPath} has been edited.`,
    };
  }

  private async delete(loc: MemoryLocation): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    const exists = await StorageFS.exists(resolvedPath);
    if (!exists) {
      throw new ToolError(`The path ${inputPath} does not exist.`);
    }

    const readGate = this.requireViewBeforeModify(inputPath, 'deleting');
    if (readGate) return readGate;

    await StorageFS.delete(resolvedPath, { recursive: true });
    return {
      summary: `Deleted: ${inputPath}`,
      output: `Successfully deleted ${inputPath}`,
    };
  }

  private async rename(
    oldLoc: MemoryLocation,
    newLoc: MemoryLocation,
  ): Promise<ToolResult> {
    const { display: oldPathInput, storage: resolvedOldPath } = oldLoc;
    const { display: newPathInput, storage: resolvedNewPath } = newLoc;

    const oldExists = await StorageFS.exists(resolvedOldPath);
    if (!oldExists) {
      throw new ToolError(`The path ${oldPathInput} does not exist.`);
    }

    const readGate = this.requireViewBeforeModify(oldPathInput, 'renaming');
    if (readGate) return readGate;

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

  private async pin(loc: MemoryLocation): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    await this.requireEditableFile(resolvedPath, inputPath);

    const { meta, content } = await this.readMemoryFile(resolvedPath);
    if (meta?.pinned) {
      return {
        summary: `Already pinned: ${inputPath}`,
        output: `The memory file ${inputPath} is already pinned.`,
      };
    }

    const pinnedCount = await countPinnedMemories(MAX_PINNED_MEMORIES);
    if (pinnedCount >= MAX_PINNED_MEMORIES) {
      throw new ToolError(
        `Cannot pin ${inputPath}: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
      );
    }

    const updatedMeta = setPinnedMeta(meta, true);
    await StorageFS.write(resolvedPath, buildFile(content, updatedMeta));

    return {
      summary: `Pinned memory: ${inputPath}`,
      output: `Successfully pinned ${inputPath} as a core long-term memory. (${pinnedCount + 1}/${MAX_PINNED_MEMORIES} pinned)`,
    };
  }

  private async unpin(loc: MemoryLocation): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    await this.requireEditableFile(resolvedPath, inputPath);

    const { meta, content } = await this.readMemoryFile(resolvedPath);
    if (!meta?.pinned) {
      return {
        summary: `Not pinned: ${inputPath}`,
        output: `The memory file ${inputPath} is not pinned.`,
      };
    }

    const updatedMeta = setPinnedMeta(meta, false);
    await StorageFS.write(resolvedPath, buildFile(content, updatedMeta));

    return {
      summary: `Unpinned memory: ${inputPath}`,
      output: `Successfully unpinned ${inputPath}.`,
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
        let display = toDisplayPath(entry.path);
        const age = formatRelativeTime(entry.mtime);
        let by = '-';
        if (!entry.isDir) {
          try {
            const { meta } = await this.readMemoryFile(entry.path);
            if (meta) {
              by = formatAttribution(meta);
              if (meta.pinned) display += ' [pinned]';
            }
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
      const isDir = isDirectory(type);
      entries.push({
        path: childPath,
        size: stats.size,
        mtime: stats.mtime,
        isDir,
      });

      if (isDir) {
        await this.walkDirectory(childPath, depth + 1, entries);
      }
    }
  }
}
