// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Stream } from 'effect';
import { z } from 'zod';

// Local imports
import {
  getRunContextAgentName,
  getRunContextExecutionId,
  tryUseRunContext,
} from '@agent/runtime/RunContext';
import type { FileStat } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { MEMORY_STORAGE_DIR } from '@platform/defaults/workspaceStorage';
import { ToolError, type ToolResult } from '@shared/schemas';
import { replaceLiteralMatches } from '@tools/fileEditFlow';
import {
  MemoryEntryUnreadable,
  MemoryFileUnwritable,
  memoryPathExists,
  setMemoryPinned,
  walkMemoryDirectory,
} from '@tools/memory/memoryFileSystem';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
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

/** Stat one memory path; the two callers share the one wrap of `StorageFS`. */
const statMemoryStorage = Effect.fn('MemoryTool.statMemoryStorage')(
  (storagePath: string) =>
    Effect.tryPromise({
      try: () => StorageFS.stat(storagePath),
      catch: (cause) => new MemoryEntryUnreadable({ storagePath, cause }),
    }),
);

/** Create a memory directory and its parents. */
const ensureMemoryDir = Effect.fn('MemoryTool.ensureMemoryDir')(
  (storagePath: string) =>
    Effect.tryPromise({
      try: () => StorageFS.ensureDir(storagePath),
      catch: (cause) => new MemoryFileUnwritable({ storagePath, cause }),
    }),
);

const MEMORY_PATH_DESCRIPTION = `Path under ${MEMORY_DISPLAY_ROOT} (e.g. ${MEMORY_DISPLAY_ROOT}/notes.md).`;

// Branches use looseObject (not strictObject): provider conversion flattens
// the union into one advertised object and OpenAI-compatible providers
// null-fill the properties belonging to the other commands. See AGENTS.md
// "Tool input schemas".
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
  /**
   * The one run edge of this tool (PRD run-edge category b): every line of
   * logic below is an Effect program, run once here on the process runtime.
   * The two filesystem failures are re-raised as their own causes so a
   * caller still sees the error the filesystem raised, exactly as the
   * previous `await` chain did; a `ToolError` stays a typed failure and
   * `runPromise` rejects with that instance.
   */
  protected execute(input: MemoryToolInput): Promise<ToolResult> {
    return effectRuntime().runPromise(
      this.run(input).pipe(
        Effect.catchTags({
          MemoryEntryUnreadable: (error) => Effect.die(error.cause),
          MemoryFileUnwritable: (error) => Effect.die(error.cause),
        }),
      ),
    );
  }

  private readonly run = Effect.fn('MemoryTool.run')(function* (
    this: MemoryTool,
    input: MemoryToolInput,
  ) {
    // Normalize a raw display path into a `{ display, storage }` pair at the
    // dispatch boundary. Fails with a ToolError if the path is outside
    // `/memories`.
    const locate = (raw: string): Effect.Effect<MemoryLocation, ToolError> =>
      Effect.try({
        try: () => {
          const storage = displayToStoragePath(raw);
          return { display: toDisplayPath(storage), storage };
        },
        catch: (cause) => new ToolError(toErrorMessage(cause), { cause }),
      });

    switch (input.command) {
      case 'view':
        // `path` defaults to the memory root so an omitted path lists
        // /memories instead of erroring - the model's first call in a
        // fresh session is reliably a bare `view` with no path.
        return yield* this.view(
          yield* locate(input.path ?? MEMORY_DISPLAY_ROOT),
          input.view_range ?? undefined,
          input.offset ?? 0,
          input.limit ?? 100,
        );
      case 'create':
        return yield* this.create(yield* locate(input.path), input.file_text);
      case 'str_replace':
        return yield* this.strReplace(
          yield* locate(input.path),
          input.old_str,
          input.new_str,
        );
      case 'insert': {
        // Schema-enforced: the branch's .refine() rejects insert_text and
        // new_str both being absent before execute() is ever reached.
        const insertText = (input.insert_text ?? input.new_str)!;
        return yield* this.insert(
          yield* locate(input.path),
          input.insert_line,
          insertText,
        );
      }
      case 'delete':
        return yield* this.delete(yield* locate(input.path));
      case 'rename':
        return yield* this.rename(
          yield* locate(input.old_path),
          yield* locate(input.new_path),
        );
      case 'pin':
        return yield* this.pin(yield* locate(input.path));
      case 'unpin':
        return yield* this.unpin(yield* locate(input.path));
    }
  });

  /** Read a memory file, stripping frontmatter. Returns user-visible content and optional metadata. */
  private readonly readMemoryFile = Effect.fn('MemoryTool.readMemoryFile')(
    (resolvedPath: string) =>
      Effect.map(
        Effect.tryPromise({
          try: () => StorageFS.read(resolvedPath),
          catch: (cause) =>
            new MemoryEntryUnreadable({ storagePath: resolvedPath, cause }),
        }),
        (raw) => parseFrontmatter(raw),
      ),
  );

  /** Write a memory file with fresh attribution frontmatter, preserving pinned status from existing file. */
  private readonly writeMemoryFile = Effect.fn('MemoryTool.writeMemoryFile')(
    (
      resolvedPath: string,
      content: string,
      existingMeta?: MemoryFileMeta | null,
    ) =>
      Effect.suspend(() => {
        const ctx = tryUseRunContext();
        const meta = createMeta(
          getRunContextAgentName(ctx),
          getRunContextExecutionId(ctx),
          existingMeta,
        );
        return Effect.tryPromise({
          try: () =>
            StorageFS.writeAtomic(resolvedPath, buildFile(content, meta)),
          catch: (cause) =>
            new MemoryFileUnwritable({ storagePath: resolvedPath, cause }),
        });
      }),
  );

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

  /**
   * Fail unless `resolvedPath` names an existing regular file. A missing
   * path and a directory are the same user-facing mistake, and an
   * unreadable stat is reported as that mistake too — the same collapse
   * the previous `try { stat } catch { throw ToolError }` made.
   */
  private readonly requireEditableFile = Effect.fn(
    'MemoryTool.requireEditableFile',
  )(function* (resolvedPath: string, inputPath: string) {
    const errorMsg = `The path ${inputPath} does not exist or is a directory.`;
    const stats = yield* statMemoryStorage(resolvedPath).pipe(
      Effect.catchTag('MemoryEntryUnreadable', () =>
        Effect.fail(new ToolError(errorMsg)),
      ),
    );
    if (isDirectory(stats.type)) {
      return yield* Effect.fail(new ToolError(errorMsg));
    }
  });

  private readonly view = Effect.fn('MemoryTool.view')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
    viewRange?: [number, number],
    offset = 0,
    limit = 100,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    const exists = yield* memoryPathExists(resolvedPath);

    // Handle non-existent root directory gracefully - return empty listing
    // instead of error (consistent with MemoryViewMessageHandler behavior)
    if (!exists) {
      if (resolvedPath === MEMORY_STORAGE_DIR) {
        return executed(
          `The memory directory is empty. This is a fresh start - use the create command to add memory files.`,
          'Viewed empty memory directory',
        );
      }
      return yield* Effect.fail(
        new ToolError(
          `The path ${inputPath} does not exist. Please provide a valid path.`,
        ),
      );
    }

    const stats = yield* statMemoryStorage(resolvedPath);
    if (isDirectory(stats.type)) {
      const allEntries = yield* this.buildDirectoryListing(resolvedPath, stats);
      recordToolFileRead(inputPath);

      const { page, start, end, total } = paginateToolListing(
        allEntries,
        offset,
        limit,
      );

      const header = `Contents of ${inputPath} (showing ${start}–${end} of ${total}, up to ${DIRECTORY_LISTING_DEPTH} levels deep):`;
      return executed(
        `${header}\nSIZE\tMODIFIED\tBY\tPATH\n${page.join('\n')}${formatPaginationHint(end, total)}`,
        `Listed directory: ${inputPath} (${start}–${end} of ${total})`,
      );
    }

    const { meta, content } = yield* this.readMemoryFile(resolvedPath);
    recordToolFileRead(inputPath);
    const lines = splitContentLines(content);
    if (lines.length > MAX_VIEW_LINES) {
      return yield* Effect.fail(
        new ToolError(
          `File ${inputPath} exceeds maximum line limit of 999,999 lines.`,
        ),
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
  });

  private readonly create = Effect.fn('MemoryTool.create')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
    fileText: string,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    const exists = yield* memoryPathExists(resolvedPath);
    if (exists) {
      return yield* Effect.fail(
        new ToolError(`File ${inputPath} already exists.`),
      );
    }

    yield* ensureMemoryDir(MEMORY_STORAGE_DIR);
    yield* ensureMemoryDir(path.dirname(resolvedPath));
    yield* this.writeMemoryFile(resolvedPath, fileText);
    recordToolFileRead(inputPath);

    return executed(
      `File created successfully at: ${inputPath}`,
      `Created memory file: ${inputPath}`,
    );
  });

  private readonly strReplace = Effect.fn('MemoryTool.strReplace')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
    oldStr: string,
    newStr: string,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    if (oldStr.length === 0) {
      return yield* Effect.fail(
        new ToolError(
          `old_str must not be empty for ${inputPath}. Provide the exact text to replace.`,
        ),
      );
    }

    yield* this.requireEditableFile(resolvedPath, inputPath);

    const readGate = this.requireViewBeforeModify(inputPath);
    if (readGate) return readGate;

    const { content, meta } = yield* this.readMemoryFile(resolvedPath);
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
    yield* this.writeMemoryFile(resolvedPath, updated, meta);
    recordToolFileRead(inputPath);

    const updatedLines = updated.split('\n');
    const numbered = formatLinesWithNumbers(updatedLines);

    return executed(
      `The file has been edited.\n${numbered.join('\n')}`,
      `Replaced text in: ${inputPath}`,
    );
  });

  private readonly insert = Effect.fn('MemoryTool.insert')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
    insertLine: number,
    insertText: string,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    yield* this.requireEditableFile(resolvedPath, inputPath);

    const readGate = this.requireViewBeforeModify(inputPath);
    if (readGate) return readGate;

    const { content, meta } = yield* this.readMemoryFile(resolvedPath);
    const lines = content.split('\n');
    const totalLines = lines.length;
    if (insertLine < 0 || insertLine > totalLines) {
      return yield* Effect.fail(
        new ToolError(
          `Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${totalLines}].`,
        ),
      );
    }

    const insertLines = insertText.split('\n');
    const updatedLines = [
      ...lines.slice(0, insertLine),
      ...insertLines,
      ...lines.slice(insertLine),
    ];

    yield* this.writeMemoryFile(resolvedPath, updatedLines.join('\n'), meta);
    recordToolFileRead(inputPath);

    return executed(
      `The file ${inputPath} has been edited.`,
      `Inserted text at line ${insertLine} in: ${inputPath}`,
    );
  });

  private readonly delete = Effect.fn('MemoryTool.delete')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    const exists = yield* memoryPathExists(resolvedPath);
    if (!exists) {
      return yield* Effect.fail(
        new ToolError(`The path ${inputPath} does not exist.`),
      );
    }

    const readGate = this.requireViewBeforeModify(inputPath, 'deleting');
    if (readGate) return readGate;

    yield* Effect.tryPromise({
      try: () => StorageFS.delete(resolvedPath, { recursive: true }),
      catch: (cause) =>
        new MemoryFileUnwritable({ storagePath: resolvedPath, cause }),
    });
    return executed(
      `Successfully deleted ${inputPath}`,
      `Deleted: ${inputPath}`,
    );
  });

  private readonly rename = Effect.fn('MemoryTool.rename')(function* (
    this: MemoryTool,
    oldLoc: MemoryLocation,
    newLoc: MemoryLocation,
  ) {
    const { display: oldPathInput, storage: resolvedOldPath } = oldLoc;
    const { display: newPathInput, storage: resolvedNewPath } = newLoc;

    const oldExists = yield* memoryPathExists(resolvedOldPath);
    if (!oldExists) {
      return yield* Effect.fail(
        new ToolError(`The path ${oldPathInput} does not exist.`),
      );
    }

    const readGate = this.requireViewBeforeModify(oldPathInput, 'renaming');
    if (readGate) return readGate;

    const newExists = yield* memoryPathExists(resolvedNewPath);
    if (newExists) {
      return yield* Effect.fail(
        new ToolError(`The destination ${newPathInput} already exists.`),
      );
    }

    yield* Effect.tryPromise({
      try: () => StorageFS.rename(resolvedOldPath, resolvedNewPath),
      catch: (cause) =>
        new MemoryFileUnwritable({ storagePath: resolvedOldPath, cause }),
    });
    return executed(
      `Successfully renamed ${oldPathInput} to ${newPathInput}`,
      `Renamed: ${oldPathInput} to ${newPathInput}`,
    );
  });

  private readonly pin = Effect.fn('MemoryTool.pin')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    yield* this.requireEditableFile(resolvedPath, inputPath);

    const result = yield* setMemoryPinned(resolvedPath, true);
    if (result.status === 'already') {
      return executed(
        `The memory file ${inputPath} is already pinned.`,
        `Already pinned: ${inputPath}`,
      );
    }
    if (result.status === 'cap-reached') {
      return yield* Effect.fail(
        new ToolError(
          `Cannot pin ${inputPath}: maximum of ${MAX_PINNED_MEMORIES} pinned memories reached. Unpin an existing memory first.`,
        ),
      );
    }

    return executed(
      `Successfully pinned ${inputPath} as a core long-term memory. (${result.pinnedCount}/${MAX_PINNED_MEMORIES} pinned)`,
      `Pinned memory: ${inputPath}`,
    );
  });

  private readonly unpin = Effect.fn('MemoryTool.unpin')(function* (
    this: MemoryTool,
    loc: MemoryLocation,
  ) {
    const { display: inputPath, storage: resolvedPath } = loc;
    yield* this.requireEditableFile(resolvedPath, inputPath);

    const result = yield* setMemoryPinned(resolvedPath, false);
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
  });

  /** Rows for an already-stat'ed directory; `rootStats` is the caller's snapshot so the root row and the is-a-directory decision are one observation. */
  private readonly buildDirectoryListing = Effect.fn(
    'MemoryTool.buildDirectoryListing',
  )(function* (resolvedPath: string, rootStats: FileStat) {
    const entries = yield* Stream.runCollect(
      walkMemoryDirectory(resolvedPath, '', {
        maxDepth: DIRECTORY_LISTING_DEPTH,
        includeDirs: true,
      }),
    );
    return [
      formatListingRow(resolvedPath, rootStats.size, rootStats.mtime, null),
      ...entries.map((entry) =>
        formatListingRow(
          entry.storagePath,
          entry.size,
          entry.mtime,
          entry.isDir ? null : entry.meta,
        ),
      ),
    ];
  });
}
