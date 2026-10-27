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
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { JSONSchemaObject } from '@agent/core/tools/toolSchema';
import { ToolError, type RunId } from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { Settings } from '@shared/config/settings';
import type { SettingsStores } from '@shared/config/settings';
import { displayToStoragePath } from '@tools/memory/memoryUtils';
import { parseWorkingDirectory } from '@tools/pathResolution';
import { errorResult } from '@tools/core/result';
import type { ToolRegistry } from '@tools/toolTable';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { runStorageLocationUnder } from '@utils/files/runStorageFs';
import { workspaceAbsolutePath } from '@utils/files/workspaceFS';
import { entryExists } from '@utils/files/fsEntryExists';
import {
  ensureError,
  formatError,
  toErrorMessage,
} from '@utils/errors/errorMessage';
import { escapesRoot } from '@utils/core/pathCore';

/**
 * Shared field for the `memories` parameter on delegation tools.
 * Validates that all paths are within /memories using displayToStoragePath
 * (prefix + traversal checks). Existence is NOT checked — getAttachedMemories
 * handles read failures gracefully, avoiding a TOCTOU race.
 */
export const memoriesField = nullishWithDefault(
  Schema.Array(Schema.String),
  [],
  'Memory file paths to attach (e.g. /memories/conventions.md). Content is injected into the agent prompt as read-only context. Use for project conventions, style guides, or accumulated knowledge the agent should follow.',
).check(
  Schema.makeFilter((memories) =>
    memories.flatMap((memory, i) => {
      const parsed = displayToStoragePath(memory);
      return Result.isSuccess(parsed)
        ? []
        : [{ path: [i], issue: parsed.failure.message }];
    }),
  ),
);

const WORKTREE_DISABLED_MESSAGE =
  "git worktree support is disabled in this workspace. Omit working_directory, or ask the user to turn on `texra.git.worktreeSupport` ('Subagent worktrees' in Settings > General > Git).";

/**
 * The `working_directory` gate, over the settings of the project the call
 * belongs to: the worktree opt-in first, then that the path is an existing
 * directory. It lives here beside the field it guards, but runs in the tool's
 * `execute`, where `call.env.roots` names that project — the schema is static,
 * parsed once by the tool facade before any call exists, so a gate in its
 * transform could only ever answer for whichever workspace the process came
 * up in.
 */
export const rejectUnusableWorkingDirectory = Effect.fn(function* (
  stores: SettingsStores,
  workingDirectory: string | undefined,
) {
  if (!workingDirectory) return null;
  const worktrees = yield* Settings.get<boolean>(
    stores,
    WorkspaceStateKey.GIT_WORKTREE_SUPPORT,
  );
  if (!worktrees) return errorResult(WORKTREE_DISABLED_MESSAGE);
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
/** A file a call names, and where it resolved. */
interface CallFile {
  readonly file: string;
  readonly absolutePath: string;
}
/** A call's input, context and media files, resolved. */
export type CallFiles = readonly [
  inputs: readonly CallFile[],
  contexts: readonly CallFile[],
  media: readonly CallFile[],
];

/** A launch's files, resolved at once: a run-storage file must be the
 *  calling run's own or a declared output of a completed child of it; a
 *  trusted script's files pass as named. */
export const resolveCallFiles = (
  session: SessionHandle,
  runId: RunId,
  files: Record<
    'inputFiles' | 'contextFiles' | 'mediaFiles',
    readonly string[]
  >,
  trusted: boolean,
): Effect.Effect<CallFiles, Error, FileSystem.FileSystem | ToolRegistry> => {
  const resolve = (label: string, list: readonly string[]) =>
    trusted
      ? Effect.succeed(list.map((file) => ({ file, absolutePath: file })))
      : resolveInvocationFileList(session, runId, label, list);
  return Effect.all(
    [
      resolve('Input file', files.inputFiles),
      resolve('Context file', files.contextFiles),
      resolve('Media file', files.mediaFiles),
    ],
    { concurrency: 'unbounded' },
  );
};

/** The JSON Schema a delegated call's answer takes, when its `schema` names
 *  one; an unsupported one fails the call. */
export const outputJsonSchemaOf = (
  schema: Record<string, unknown> | null | undefined,
): Effect.Effect<JSONSchemaObject | undefined, ToolError> =>
  schema == null
    ? Effect.succeed(undefined)
    : Effect.try({
        try: () => normalizeStructuredOutputSchema(schema).jsonSchema,
        catch: (error) =>
          new ToolError(
            `\`schema\` is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
          ),
      });

const TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION = [
  'The delegated instruction above is your full task contract. This includes any tool, network, file, approval, output-format, or scope constraints it states. If a requested action conflicts with those constraints or needs missing context, report the conflict instead of assuming permission.',
  'Your final response is delivered verbatim to the parent orchestrator. End with the substantive result (answer, findings, evidence, unresolved caveats), never only a status note such as "done".',
].join(' ');
/**
 * A subagent's instruction with the parent's request attached as binding
 * context (when given) and the closing note on how its final answer is
 * delivered.
 */
export function withToolUseSubagentHandoffInstruction(
  instruction: string,
  parentInstruction?: string,
): string {
  const trimmed = instruction.trim();
  const trimmedParent = parentInstruction?.trim();
  const parts = trimmed ? [trimmed] : [];
  if (trimmedParent) {
    const contextBlock =
      trimmedParent === trimmed
        ? 'The delegated task above is copied verbatim from the parent user request.'
        : `Parent user request (constraint context only):\n${trimmedParent}`;
    parts.push(
      `${contextBlock}\n\nConstraints in the parent user request are mandatory and override conflicting delegated-task wording. Do not repeat orchestration actions assigned to the parent.`,
    );
  }
  parts.push(TOOL_USE_SUBAGENT_HANDOFF_INSTRUCTION);
  return parts.join('\n\n');
}

/** An agent an `agent` call defines instead of naming one from the
 *  catalog, named by its `agentName`. */
export const personaField = Schema.optional(
  Schema.NullOr(
    Schema.Struct({
      prompt: Schema.NonEmptyString.annotate({
        description: 'Its system prompt: who it is and how it works.',
      }),
      tools: Schema.optional(
        Schema.NullOr(Schema.Array(Schema.NonEmptyString)),
      ).annotate({
        description:
          'The tools it gets, by name; omitted, none. It gets only those you have.',
      }),
    }),
  ),
).annotate({
  description:
    'Define the agent here, named `agentName`, instead of naming one from the catalog: for this call alone.',
});

/**
 * Shared field for the `working_directory` parameter on delegation tools.
 * Validates and normalizes in one step so downstream code always receives the
 * canonical `string | undefined` value — no trimming or absolute-path checks
 * needed at the call site.
 */
export const workingDirectoryField = Schema.optional(
  Schema.NullOr(Schema.String),
)
  .annotate({
    description:
      'Absolute path for the subagent to operate in (e.g. a git worktree). All tool calls within the subagent will automatically use this as their root directory. Defaults to workspace root. Only accepted when git worktree support (`texra.git.worktreeSupport`) is enabled for this workspace.',
  })
  .pipe(
    Schema.decodeTo(Schema.optional(Schema.String), {
      decode: SchemaGetter.transformOptionalEffect((value) => {
        // Neither the worktree opt-in nor the path's existence is checked here:
        // this runs on the tool facade's one decode of a static schema, before
        // any call exists. Both run in `execute`, through
        // `rejectUnusableWorkingDirectory`, where `call.env.roots` names the project.
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
): Effect.Effect<string, Error> =>
  Effect.try({
    try: () => workspaceAbsolutePath(workspaceRoot, target),
    catch: ensureError,
  });

interface WorkflowFileGroup {
  readonly label: string;
  readonly files: readonly string[];
}

/**
 * Validate workspace-backed workflow inputs before launching a child run.
 * `workspaceRoot` is the owning session's workspace folder, handed in as
 * data, so a relative declaration resolves against that session.
 */
const assertWorkflowFilesExist = Effect.fn('assertWorkflowFilesExist')(
  function* (
    workspaceRoot: string | undefined,
    groups: readonly WorkflowFileGroup[],
  ): Effect.fn.Return<void, Error, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const entries = groups.flatMap(({ label, files }) =>
      files
        .filter((file) => file.trim() !== '')
        .map((path) => ({ label, path })),
    );
    const inspected = yield* Effect.forEach(
      entries,
      (entry) =>
        absoluteWorkspacePath(workspaceRoot, entry.path).pipe(
          Effect.flatMap((absolute) => entryExists(fs, absolute)),
          Effect.map((exists) => ({ ...entry, exists })),
        ),
      { concurrency: 'unbounded' },
    );
    const missing = inspected.find((entry) => !entry.exists);
    if (missing) {
      return yield* Effect.fail(
        new Error(`${missing.label} not found: ${missing.path}`),
      );
    }
  },
);

/**
 * Resolve workflow file dependencies against their owning session's roots,
 * read once from `session.roots` rather than from an ambient session scope.
 */
const resolveInvocationFileList = Effect.fn('resolveInvocationFileList')(
  function* (
    session: SessionHandle,
    parentRunId: RunId,
    label: string,
    files: readonly string[],
  ): Effect.fn.Return<
    { file: string; absolutePath: string }[],
    Error,
    FileSystem.FileSystem | ToolRegistry
  > {
    const fs = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const { storage, workspace } = session.roots;
      // Storage is created by the first store that writes to it, so a
      // session that has not written (an ephemeral one) may have none yet;
      // then no referenced file can lie under it.
      const storageRoot = yield* fs.realPath(storage).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      );
      const references = yield* Effect.forEach(
        files,
        (file) =>
          Effect.gen(function* () {
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
              return yield* Effect.fail(
                new Error(
                  `${file}; workspace-storage files must be declared outputs of a completed child run.`,
                ),
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
      yield* assertWorkflowFilesExist(workspace, [
        {
          label,
          files: references
            .filter((reference) => reference.runStoragePath === undefined)
            .map((reference) => reference.absolutePath),
        },
      ]);
      return yield* Effect.forEach(
        references,
        ({ file, absolutePath, runStoragePath }) =>
          Effect.gen(function* () {
            if (runStoragePath !== undefined) {
              const output = yield* resolveChildRunOutput(
                parentRunId,
                runStoragePath,
                session,
              );
              if (!output)
                return yield* Effect.fail(
                  new Error(
                    `${runStoragePath}; pass a matching workflow file option whose files still exist.`,
                  ),
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
          new Error(
            formatError(`Workflow ${label} files could not be resolved`, error),
            { cause: error },
          ),
      ),
    );
  },
);
