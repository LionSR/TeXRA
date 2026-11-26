/**
 * Shared input-field schemas and attachment validation for delegation tools.
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import {
  Effect,
  FileSystem,
  Option,
  Result,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from 'effect';

// Local imports
import { resolveChildRunOutput } from '@agent/storage/childRunOutput';
import { runStorageLocationUnder } from '@common/storage/storageLayout';
import { SessionRoots } from '@platform/rootedFs';
import { asToolError, ToolError, type RunId } from '@shared/schemas';
import type {
  RunHistory,
  SessionLog,
  SessionViewAccess,
} from '@shared/session/runHistory';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { errorResult } from '@tools/core/result';
import type { ToolRegistry } from '@tools/toolTable';
import {
  nullishWithDefault,
  optionalInput,
  timeoutMsField,
} from '@tools/core/inputSchema';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { meansAbsent, entryExists } from '@utils/files/fsEntryExists';
import { formatError } from '@utils/errors/errorMessage';
import { escapesRoot } from '@utils/core/pathCore';

/**
 * The `working_directory` check: the path is an existing directory. It runs
 * in the tool's `execute`, since the field's schema is parsed once by the
 * tool facade and cannot read the file system.
 */
export const rejectUnusableWorkingDirectory = Effect.fn(function* (
  workingDirectory: string | undefined,
) {
  if (!workingDirectory) return null;
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* Effect.result(fs.stat(workingDirectory));
  if (Result.isFailure(stat)) {
    return errorResult(
      `working_directory must be an existing directory: ${stat.failure.message}`,
    );
  }
  if (stat.success.type !== 'Directory') {
    return errorResult(
      `working_directory must be a directory: ${workingDirectory}`,
    );
  }
  return null;
});
/**
 * Shared field for the `working_directory` parameter on delegation tools.
 * Validates and normalizes in one step so downstream code always receives the
 * canonical `string | undefined` value — no trimming or absolute-path checks
 * needed at the call site.
 */
const workingDirectoryField = optionalInput(
  Schema.String,
  'Absolute path of an existing directory for the subagent to operate in: a copy of the project you made, or a git worktree you added. All tool calls within the subagent will automatically use this as their root directory. Defaults to workspace root.',
).pipe(
  Schema.decodeTo(Schema.optional(Schema.String), {
    decode: SchemaGetter.transformOptionalEffect((value) => {
      // The path's existence is not checked here: this runs on the tool
      // facade's one decode of a static schema, before any call exists.
      // `rejectUnusableWorkingDirectory` checks it in `execute`.
      const parsed = parseWorkingDirectory(Option.getOrUndefined(value));
      return Result.isSuccess(parsed)
        ? Effect.succeed(Option.some(parsed.success))
        : Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: parsed.failure.message },
              value,
            ),
          );
    }),
    encode: SchemaGetter.passthrough(),
  }),
);

/** A list of file paths, empty when the call names none. */
export const fileList = (
  description: string,
): ReturnType<typeof nullishWithDefault<Schema.$Array<Schema.String>>> =>
  nullishWithDefault(Schema.Array(Schema.String), [], description);

/**
 * The fields every child launch takes, `self()` included: the model the
 * child runs on, its card label, how long its call waits for it
 * (`withinTime`, `agentChild.ts`) and its spend cap (`spendCap.ts`).
 */
export const CHILD_FIELDS = Object.freeze({
  model: optionalInput(
    Schema.String,
    'Model reference, `@effort` suffix allowed (`@low` … `@max`, `@none`). Defaults to your current model when available.',
  ),
  label: optionalInput(
    Schema.String,
    'A short name for the child: its card’s title and its run’s name.',
  ),
  timeoutMs: timeoutMsField.annotate({
    description:
      'Stops the child after this many milliseconds: `TimedOut`. Only for a call that waits for its child.',
  }),
  maxCostUsd: optionalInput(
    Schema.Finite.check(Schema.isGreaterThan(0)),
    'A spend cap in USD on the child and every run it starts, for as long as the child exists: once they have spent it, they are stopped. A call that waits for the child rejects with `BudgetExceeded`; a background child reports it as its result.',
  ),
});

/** The fields an `agent` or `program` launch takes beside its own: those of
 *  every child, the call's reuse id, and whether a script waits. */
export const CALL_FIELDS = Object.freeze({
  working_directory: workingDirectoryField,
  id: optionalInput(
    Schema.String,
    'Tells apart two otherwise identical calls: a completed call is reused by a later one with the same prompt, options and files.',
  ),
  ...CHILD_FIELDS,
  background: optionalInput(
    Schema.Boolean,
    'In a script: return `{ runId }` at once; the result arrives as a follow-up. A direct call always runs in the background, except in a one-shot run. A background child takes no `timeoutMs`.',
  ),
});

/**
 * `workspaceAbsolutePath` validates the path it resolved and throws when the
 * session has no workspace folder and the target is relative. Under an
 * `Effect.fn` body or an `Effect.forEach` mapper that throw is a defect, where
 * the facade's async call turned it into a typed failure; `Effect.try` keeps
 * the channel, so a no-workspace session still gets a tool error naming the
 * path rather than an unexpected-error defect.
 */
const absoluteWorkspacePath = (
  workspaceRoot: string | undefined,
  target: string,
): Effect.Effect<string, ToolError> =>
  Effect.try({
    try: () => workspaceAbsolutePath(workspaceRoot, target),
    catch: asToolError,
  });

interface InputFileGroup {
  readonly label: string;
  readonly files: readonly string[];
}

/**
 * Validate workspace-backed input files before launching a child run.
 * `workspaceRoot` is the owning session's workspace folder, handed in as
 * data, so a relative declaration resolves against that session.
 */
const assertInputFilesExist = Effect.fn('assertInputFilesExist')(function* (
  workspaceRoot: string | undefined,
  groups: readonly InputFileGroup[],
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = groups.flatMap(({ label, files }) =>
    files.filter((file) => file.trim() !== '').map((path) => ({ label, path })),
  );
  const missing = yield* Effect.filter(
    entries,
    (entry) =>
      absoluteWorkspacePath(workspaceRoot, entry.path).pipe(
        Effect.flatMap((absolute) => entryExists(fs, absolute)),
        Effect.map((exists) => !exists),
      ),
    { concurrency: 'unbounded' },
  );
  const first = missing[0];
  if (first !== undefined) {
    return yield* new ToolError(`${first.label} not found: ${first.path}`);
  }
});

/**
 * Resolve input files against their owning session's roots,
 * read once from the session's `SessionRoots`.
 */
export const resolveInvocationFileList = Effect.fn('resolveInvocationFileList')(
  function* (
    parentId: RunId,
    label: string,
    files: readonly string[],
  ): Effect.fn.Return<
    { file: string; absolutePath: string }[],
    ToolError,
    | FileSystem.FileSystem
    | ToolRegistry
    | SessionLog
    | SessionViewAccess
    | RunHistory
    | SessionRoots
  > {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const { storage, workspace } = yield* SessionRoots;
      // Storage is created by the first store that writes to it, so a
      // session that has not written (an ephemeral one) may have none yet;
      // then no referenced file can lie under it.
      const storageRoot = yield* fs
        .realPath(storage)
        .pipe(Effect.catchIf(meansAbsent, () => Effect.void));
      const references = yield* Effect.forEach(
        files,
        Effect.fnUntraced(function* (file) {
          const absolutePath = yield* absoluteWorkspacePath(workspace, file);
          const canonicalPath = yield* fs.realPath(absolutePath);
          const relative =
            storageRoot === undefined
              ? undefined
              : path.relative(storageRoot, canonicalPath);
          const storagePath =
            relative !== undefined &&
            !escapesRoot(relative) &&
            !path.isAbsolute(relative)
              ? path.join(storage, relative)
              : undefined;
          if (
            storagePath !== undefined &&
            runStorageLocationUnder(storage, storagePath) === undefined
          ) {
            return yield* new ToolError(
              `${file}; workspace-storage files must be declared outputs of a completed child run.`,
            );
          }
          // Explicit run paths still pass the resolver's symlink rejection,
          // even when a workspace mirror points outside storage.
          const runStoragePath =
            runStorageLocationUnder(storage, absolutePath) !== undefined
              ? absolutePath
              : storagePath;
          return { file, absolutePath: canonicalPath, runStoragePath };
        }),
        { concurrency: 'unbounded' },
      );
      // After the paths resolve, as it ran before: a reference this run does
      // not own is refused before anything is probed on disk.
      yield* assertInputFilesExist(workspace, [
        {
          label,
          files: references
            .filter((reference) => reference.runStoragePath === undefined)
            .map((reference) => reference.absolutePath),
        },
      ]);
      return yield* Effect.forEach(
        references,
        Effect.fnUntraced(function* ({ file, absolutePath, runStoragePath }) {
          if (runStoragePath !== undefined) {
            const output = yield* resolveChildRunOutput(
              parentId,
              runStoragePath,
            );
            if (!output)
              return yield* new ToolError(
                `${runStoragePath}; pass a matching file option whose files still exist.`,
              );
          }
          return {
            file: runStoragePath === undefined ? file : absolutePath,
            absolutePath,
          };
        }),
        { concurrency: 'unbounded' },
      );
    }).pipe(
      Effect.mapError(
        (error) =>
          new ToolError(
            formatError(`The ${label} files could not be resolved`, error),
            { cause: error },
          ),
      ),
    );
  },
);
