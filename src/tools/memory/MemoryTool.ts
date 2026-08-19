// Node imports
import * as path from 'node:path';

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  getRunContextAgentName,
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { ToolError, type ToolResult } from '@shared/schemas';
import { replaceLiteralMatches } from '@tools/fileEditFlow';
import {
  setMemoryPinned,
  walkMemoryDirectory,
} from '@tools/memory/memoryFileSystem';
import { executed } from '@tools/core/result';
import { StorageFS } from '@utils/files/storageFS';
import { isDirectory } from '@utils/files/fsEntryType';
import {
  formatBytes,
  formatRelativeTime,
  splitContentLines,
} from '@utils/text/stringUtils';

// Local file imports
import { defineTool } from '../core/define';
import {
  recordToolFileRead,
  requireFileReadForEdit,
} from '../fileInteractions';
import {
  formatFileView,
  formatLinesWithNumbers,
  formatPaginationHint,
  paginateToolListing,
  ViewRangeSchema,
} from '../formatting';
import {
  MAX_VIEW_LINES,
  MAX_PINNED_MEMORIES,
  DIRECTORY_LISTING_DEPTH,
  MEMORY_DISPLAY_ROOT,
} from './constants';
import { displayToStoragePath, toDisplayPath } from './memoryUtils';
import {
  parseFrontmatter,
  buildFile,
  createMeta,
  formatAttribution,
  type MemoryFileMeta,
} from './memoryMeta';

const MEMORY_PATH_DESCRIPTION = `Path under ${MEMORY_DISPLAY_ROOT} (e.g. ${MEMORY_DISPLAY_ROOT}/notes.md).`;

// Branches use looseObject (not strictObject): after flattenTopLevelUnion()
// merges every branch's properties into one JSON schema for OpenAI/Gemini/
// Anthropic tool-calling, some OpenAI-compatible providers (DeepSeek, Kimi,
// ...) fill every advertised property — including ones only relevant to a
// different command — with null rather than omitting them. A strictObject
// branch rejects that as an unrecognized key regardless of nullability;
// looseObject tolerates the cross-branch leakage while still enforcing each
// branch's own required fields. See AGENTS.md "Tool input schemas".
const MemoryToolInputSchema = z.discriminatedUnion('command', [
  z.looseObject({
    command: z.literal('view'),
    path: z
      .string()
      .nullish()
      .describe(
        `${MEMORY_PATH_DESCRIPTION} Defaults to the ${MEMORY_DISPLAY_ROOT} root directory listing when omitted.`,
      ),
    view_range: ViewRangeSchema.nullish(),
    /** Zero-based offset for paginating directory listings (path points to a directory). */
    offset: z
      .int()
      .min(0)
      .nullish()
      .describe(
        'Zero-based offset into the directory listing. Use with limit for pagination. Default: 0.',
      ),
    /** Maximum entries to return from a directory listing (path points to a directory). */
    limit: z
      .int()
      .min(1)
      .max(200)
      .nullish()
      .describe(
        'Max entries to return from directory listing. Default: 100, max: 200.',
      ),
  }),
  z.looseObject({
    command: z.literal('create'),
    path: z.string().describe(MEMORY_PATH_DESCRIPTION),
    file_text: z.string(),
  }),
  z.looseObject({
    command: z.literal('str_replace'),
    path: z.string().describe(MEMORY_PATH_DESCRIPTION),
    old_str: z.string(),
    new_str: z.string(),
  }),
  z
    .looseObject({
      command: z.literal('insert'),
      path: z.string().describe(MEMORY_PATH_DESCRIPTION),
      insert_line: z.int().min(0),
      insert_text: z
        .string()
        .nullish()
        .describe('Text to insert. Aliased by `new_str` if omitted.'),
      new_str: z.string().nullish(),
    })
    .refine((data) => data.insert_text != null || data.new_str != null, {
      message: 'insert_text is required for command="insert".',
      path: ['insert_text'],
    }),
  z.looseObject({
    command: z.literal('delete'),
    path: z.string().describe(MEMORY_PATH_DESCRIPTION),
  }),
  z.looseObject({
    command: z.literal('rename'),
    old_path: z.string().describe(MEMORY_PATH_DESCRIPTION),
    new_path: z.string().describe(MEMORY_PATH_DESCRIPTION),
  }),
  z.looseObject({
    command: z.literal('pin'),
    path: z.string().describe(MEMORY_PATH_DESCRIPTION),
  }),
  z.looseObject({
    command: z.literal('unpin'),
    path: z.string().describe(MEMORY_PATH_DESCRIPTION),
  }),
]);

/** Derived from MemoryToolInputSchema - single source of truth */
export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

/** Canonical pair of display path (`/memories/...`) and storage path. */
type MemoryLocation = { display: string; storage: string };

/** One tab-separated row of a memory directory listing. Directories and files
 *  without frontmatter pass `meta: null` and render an empty attribution. */
function formatListingRow(
  storagePath: string,
  size: number,
  mtime: number,
  meta: MemoryFileMeta | null,
): string {
  const display = toDisplayPath(storagePath);
  return [
    formatBytes(size),
    formatRelativeTime(mtime),
    meta ? formatAttribution(meta) : '-',
    meta?.pinned ? `${display} [pinned]` : display,
  ].join('\t');
}

/**
 * Memory tool for managing persistent context files under /memories.
 */
export class MemoryTool extends defineTool({
  name: 'memory',
  description: `Manage persistent memory files under /memories (view, create, str_replace, insert, delete, rename, pin, unpin).

\`view\` with no path defaults to the /memories root listing; \`rename\` uses old_path/new_path instead of path; all other commands require path.
Directory listings are paginated: use offset/limit to page through results (default: offset 0, limit 100).

Use \`pin\` to mark a memory as a core long-term insight (techniques, strategies, pitfalls, best practices). Pinned memories are always loaded at session start. Use \`unpin\` to remove the pinned status. Maximum ${MAX_PINNED_MEMORIES} pinned memories allowed.`,
  schema: MemoryToolInputSchema,
}) {
  protected async execute(input: MemoryToolInput): Promise<ToolResult> {
    // Normalize a raw display path into a `{ display, storage }` pair at the
    // dispatch boundary so ops never need to call `resolveMemoryPath`
    // themselves. Throws ToolError if the path is outside `/memories`.
    const locate = (raw: string): MemoryLocation => {
      const storage = this.resolveMemoryPath(raw);
      return { display: toDisplayPath(storage), storage };
    };

    switch (input.command) {
      case 'view':
        // `path` defaults to the memory root so an omitted path lists
        // /memories instead of erroring - the model's first call in a
        // fresh session is reliably a bare `view` with no path.
        return this.view(
          locate(input.path ?? MEMORY_DISPLAY_ROOT),
          input.view_range ?? undefined,
          input.offset ?? 0,
          input.limit ?? 100,
        );
      case 'create':
        return this.create(locate(input.path), input.file_text);
      case 'str_replace':
        return this.strReplace(
          locate(input.path),
          input.old_str,
          input.new_str,
        );
      case 'insert': {
        // Schema-enforced: the branch's .refine() rejects insert_text and
        // new_str both being absent before execute() is ever reached.
        const insertText = (input.insert_text ?? input.new_str)!;
        return this.insert(locate(input.path), input.insert_line, insertText);
      }
      case 'delete':
        return this.delete(locate(input.path));
      case 'rename':
        return this.rename(locate(input.old_path), locate(input.new_path));
      case 'pin':
        return this.pin(locate(input.path));
      case 'unpin':
        return this.unpin(locate(input.path));
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
    const meta = createMeta(
      getRunContextAgentName(ctx),
      getRunContextExecutionId(ctx),
      existingMeta,
    );
    await StorageFS.writeAtomic(resolvedPath, buildFile(content, meta));
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
  ): ToolResult | null {
    return requireFileReadForEdit(
      inputPath,
      true,
      `Modifications to memory files require viewing the file first. Please use the view command before ${operation}.`,
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
      if (resolvedPath === MEMORY_STORAGE_DIR) {
        return executed(
          `The memory directory is empty. This is a fresh start - use the create command to add memory files.`,
          'Viewed empty memory directory',
        );
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

      const header = `Contents of ${inputPath} (showing ${start}\u2013${end} of ${total}, up to ${DIRECTORY_LISTING_DEPTH} levels deep):`;
      return executed(
        `${header}\nSIZE\tMODIFIED\tBY\tPATH\n${page.join('\n')}${formatPaginationHint(end, total)}`,
        `Listed directory: ${inputPath} (${start}\u2013${end} of ${total})`,
      );
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

    await StorageFS.ensureDir(MEMORY_STORAGE_DIR);
    await StorageFS.ensureDir(path.dirname(resolvedPath));
    await this.writeMemoryFile(resolvedPath, fileText);
    recordToolFileRead(inputPath);

    return executed(
      `File created successfully at: ${inputPath}`,
      `Created memory file: ${inputPath}`,
    );
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
    const replacement = replaceLiteralMatches({
      content,
      search: oldStr,
      replacement: newStr,
      mode: 'unique',
      notFoundError: () =>
        `The provided old_str was not found in ${inputPath}. Ensure it matches the file content exactly.`,
      multipleMatchesError: ({ lineNumbers }) =>
        `old_str is not unique within ${inputPath} (found in lines ${lineNumbers.join(', ')}). Include more surrounding context to make it unique.`,
    });

    const updated = replacement.content;
    await this.writeMemoryFile(resolvedPath, updated, meta);
    recordToolFileRead(inputPath);

    const updatedLines = updated.split('\n');
    const numbered = formatLinesWithNumbers(updatedLines);

    return executed(
      `The file has been edited.\n${numbered.join('\n')}`,
      `Replaced text in: ${inputPath}`,
    );
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

    return executed(
      `The file ${inputPath} has been edited.`,
      `Inserted text at line ${insertLine} in: ${inputPath}`,
    );
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
    return executed(
      `Successfully deleted ${inputPath}`,
      `Deleted: ${inputPath}`,
    );
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
    return executed(
      `Successfully renamed ${oldPathInput} to ${newPathInput}`,
      `Renamed: ${oldPathInput} to ${newPathInput}`,
    );
  }

  private async pin(loc: MemoryLocation): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    await this.requireEditableFile(resolvedPath, inputPath);

    const result = await setMemoryPinned(resolvedPath, true);
    if (result.status === 'already') {
      return executed(
        `The memory file ${inputPath} is already pinned.`,
        `Already pinned: ${inputPath}`,
      );
    }
    if (result.status === 'cap-reached') {
      throw new ToolError(
        `Cannot pin ${inputPath}: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
      );
    }

    return executed(
      `Successfully pinned ${inputPath} as a core long-term memory. (${result.pinnedCount}/${MAX_PINNED_MEMORIES} pinned)`,
      `Pinned memory: ${inputPath}`,
    );
  }

  private async unpin(loc: MemoryLocation): Promise<ToolResult> {
    const { display: inputPath, storage: resolvedPath } = loc;
    await this.requireEditableFile(resolvedPath, inputPath);

    const result = await setMemoryPinned(resolvedPath, false);
    if (result.status === 'already') {
      return executed(
        `The memory file ${inputPath} is not pinned.`,
        `Not pinned: ${inputPath}`,
      );
    }

    return executed(
      `Successfully unpinned ${inputPath}.`,
      `Unpinned memory: ${inputPath}`,
    );
  }

  private async buildDirectoryListing(resolvedPath: string): Promise<string[]> {
    const rootStats = await StorageFS.stat(resolvedPath);
    const rows = [
      formatListingRow(resolvedPath, rootStats.size, rootStats.mtime, null),
    ];

    for await (const entry of walkMemoryDirectory(resolvedPath, '', {
      maxDepth: DIRECTORY_LISTING_DEPTH,
      includeDirs: true,
    })) {
      rows.push(
        formatListingRow(
          entry.storagePath,
          entry.size,
          entry.mtime,
          entry.isDir ? null : entry.meta,
        ),
      );
    }

    return rows;
  }
}
