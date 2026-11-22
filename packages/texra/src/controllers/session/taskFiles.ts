/**
 * The files a run is given, from what a person named for it: each named
 * path, directory or glob expanded and checked, text the host captured
 * written to a file, the result de-duplicated and put in the form the
 * launcher's picker and drop use (project-relative inside the project,
 * absolute outside it), and the inputs split into text and media.
 */
// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { glob, hasMagic, type GlobOptionsWithFileTypesFalse } from 'glob';
import {
  Effect,
  FileSystem,
  Schema,
  type PlatformError,
  Result,
  Scope,
} from 'effect';

// Local imports
import { meansAbsent, relativeToRoot } from '@texra-ai/harness/node';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { HostFailed } from '@texra/hosts/uiHosts';

/**
 * A glob that did not expand. The `glob` package rejects, and a named path
 * that cannot be listed is a failure of the request, not a defect, so the
 * rejection is typed here instead of caught raw.
 */
class GlobFailed extends Schema.TaggedError<GlobFailed>()('GlobFailed', {
  pattern: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to list ${this.pattern}: ${String(this.cause)}`;
  }
}

const TaskFileRoleSchema = Schema.Literals(['input', 'context']);

/** What a named file is to the run: an input it works on, or context it
 *  only reads. */
export type TaskFileRole = typeof TaskFileRoleSchema.Type;

/**
 * One thing a person named for a run: a path, a directory (its `.tex`
 * files) or a glob, as written; or text the host captured, which is
 * written to a file called `name` that lives as long as the caller's
 * scope. A text source's `text` is read once, after every named path has
 * been checked, so a bad path is reported before the host waits for text.
 */
export type TaskFileSource =
  | { readonly role: TaskFileRole; readonly spec: string }
  | {
      readonly role: TaskFileRole;
      readonly text: Effect.Effect<string, HostFailed>;
      readonly name: string;
    };

/** Why the named files cannot start the run, with what was named. */
const TaskFilesReasonSchema = Schema.TaggedUnion({
  /** Nothing is at a named path. */
  NotFound: { role: TaskFileRoleSchema, path: Schema.String },
  /** A named glob matched no file. */
  NoMatch: { role: TaskFileRoleSchema, pattern: Schema.String },
  /** A named directory holds no `.tex` file. */
  NoTexFiles: { role: TaskFileRoleSchema, directory: Schema.String },
  /** An agent works in its project, and a named file is outside it. */
  OutsideProject: { role: TaskFileRoleSchema, path: Schema.String },
  /** The captured text was empty or only whitespace. */
  EmptyText: { role: TaskFileRoleSchema },
  /** A program needs an input, and the inputs named resolve to none. */
  NoInput: {},
});
export type TaskFilesReason = typeof TaskFilesReasonSchema.Type;

/** The named files cannot start the run; `reason` says which and why. */
export class TaskFilesRejected extends Schema.TaggedError<TaskFilesRejected>()(
  'TaskFilesRejected',
  { reason: TaskFilesReasonSchema },
) {
  override get message(): string {
    const { reason } = this;
    switch (reason._tag) {
      case 'NotFound':
        return `${reason.role} file not found: ${reason.path}`;
      case 'NoMatch':
        return `no ${reason.role} files matched: ${reason.pattern}`;
      case 'NoTexFiles':
        return `no .tex files in ${reason.role} directory: ${reason.directory}`;
      case 'OutsideProject':
        return `${reason.role} file is outside the project: ${reason.path}`;
      case 'EmptyText':
        return `the ${reason.role} text is empty`;
      case 'NoInput':
        return 'at least one input file is required';
    }
  }
}

/** What the files are for: a program reads files from anywhere and needs
 *  an input; an agent works inside its project. */
export type TaskKind = 'program' | 'agent';

/** The run's files, each in the launcher's form. */
export interface TaskFiles {
  /** The inputs the run reads as text. */
  readonly inputFiles: string[];
  /** The inputs that are binary media ({@link splitMediaFiles}). */
  readonly mediaFiles: string[];
  readonly contextFiles: string[];
  /** The files this resolution wrote from captured text, in the same form:
   *  the run's only files that will not outlast the caller's scope. */
  readonly writtenFiles: readonly string[];
}

type TaskFilesFailure =
  | TaskFilesRejected
  | GlobFailed
  | HostFailed
  | PlatformError.PlatformError;

const reject = (reason: TaskFilesReason) => new TaskFilesRejected({ reason });

// Matches the extension of an exact path even when its name holds glob
// syntax; Windows glob mode has no backslash escape.
const GLOB_OPTIONS = {
  magicalBraces: true,
  windowsPathsNoEscape: process.platform === 'win32',
};

/** Whether a named path is a glob the resolution would expand, for a host
 *  that checks a name before it resolves. */
export function isTaskFileGlob(spec: string): boolean {
  return hasMagic(spec, GLOB_OPTIONS);
}

/**
 * `candidate` in the launcher's form: relative to `root` (symlinks on
 * either side followed) when inside it, else absolute. An agent's run
 * refuses a file outside its project.
 */
const projectPath = Effect.fn('taskFiles.projectPath')(function* (
  candidate: string,
  role: TaskFileRole,
  root: string,
  task: TaskKind,
) {
  const absolutePath = path.resolve(root, candidate);
  const relative = relativeToRoot(root, absolutePath);
  if (relative !== undefined) return relative;
  if (task === 'agent')
    return yield* reject({ _tag: 'OutsideProject', role, path: candidate });
  return absolutePath;
});

const listMatches = (pattern: string, options: GlobOptionsWithFileTypesFalse) =>
  Effect.tryPromise({
    try: () => glob(pattern, options),
    catch: (cause) => new GlobFailed({ pattern, cause }),
  });

/** The files one named path, directory or glob resolves to. */
const expandSpec = Effect.fn('taskFiles.expandSpec')(function* (
  spec: string,
  role: TaskFileRole,
  root: string,
  task: TaskKind,
): Effect.fn.Return<string[], TaskFilesFailure, FileSystem.FileSystem> {
  const trimmed = spec.trim();
  if (!trimmed) return [];
  const inProject = (matches: string[]) =>
    Effect.forEach(
      matches.toSorted(),
      (match) => projectPath(match, role, root, task),
      { concurrency: 8 },
    );

  const absolutePath = path.resolve(root, trimmed);
  // An exact existing path wins even when its valid name holds glob syntax.
  const fs = yield* FileSystem.FileSystem;
  const stats = yield* fs
    .stat(absolutePath)
    .pipe(Effect.catchIf(meansAbsent, () => Effect.succeed(null)));

  if (!stats && isTaskFileGlob(trimmed)) {
    const isAbsolute = path.isAbsolute(trimmed);
    const matches = yield* listMatches(trimmed, {
      cwd: isAbsolute ? undefined : root,
      absolute: isAbsolute,
      nodir: true,
      ...GLOB_OPTIONS,
    });
    if (matches.length === 0)
      return yield* reject({ _tag: 'NoMatch', role, pattern: trimmed });
    return yield* inProject(matches);
  }

  if (stats?.type === 'Directory') {
    // The directory itself must be one the run may read.
    yield* projectPath(trimmed, role, root, task);
    const matches = yield* listMatches('**/*.tex', {
      cwd: absolutePath,
      absolute: true,
      nodir: true,
    });
    if (matches.length === 0)
      return yield* reject({ _tag: 'NoTexFiles', role, directory: trimmed });
    return yield* inProject(matches);
  }

  if (!stats) return yield* reject({ _tag: 'NotFound', role, path: trimmed });
  return [yield* projectPath(trimmed, role, root, task)];
});

/** Write captured text to `name` in a fresh directory under `root`, removed
 *  when the caller's scope closes. */
const writeText = Effect.fn('taskFiles.writeText')(function* (
  text: string,
  name: string,
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // Not makeTempDirectoryScoped: its release omits `force` and dies on a
  // directory that is already gone.
  const directory = yield* Effect.acquireRelease(
    fs.makeTempDirectory({
      directory: root,
      // LaTeX derives auxiliary names from the input's; a job name with a
      // leading dot can be refused by TeX's file-open policy.
      prefix: `texra-${path.parse(name).name}-${process.pid}-`,
    }),
    (created) =>
      fs.remove(created, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const file = path.join(directory, name);
  // The process's file system finishes a write it started before an
  // interruption lands, so the scope never removes the directory under it.
  yield* fs.writeFileString(file, text, { flag: 'wx' });
  return file;
});

/**
 * Resolve the files named for a run under `root`. A program reads files
 * from anywhere and needs at least one input; an agent works inside its
 * project and may be given none. Every named path is expanded at once (they
 * only read), and the first failing one in `sources` order is reported;
 * then each role's captured text is read and written, inputs first, and a
 * program with no input is refused before the context's text is read.
 * A file named twice is kept once, at its first place.
 */
export const resolveTaskFiles = Effect.fn('resolveTaskFiles')(function* (
  sources: readonly TaskFileSource[],
  root: string,
  task: TaskKind,
): Effect.fn.Return<
  TaskFiles,
  TaskFilesFailure,
  Scope.Scope | FileSystem.FileSystem
> {
  const expanded = yield* Effect.forEach(
    sources,
    (source) =>
      Effect.result(
        'spec' in source
          ? expandSpec(source.spec, source.role, root, task)
          : Effect.succeed(null),
      ),
    { concurrency: 8 },
  );
  const paths = yield* Effect.fromResult(Result.all(expanded));

  const writtenFiles: string[] = [];
  const filesOf = Effect.fn('taskFiles.filesOf')(function* (
    role: TaskFileRole,
  ) {
    const files: string[] = [];
    for (const [index, source] of sources.entries()) {
      if (source.role !== role) continue;
      if ('spec' in source) {
        files.push(...(paths[index] ?? []));
        continue;
      }
      // No resource exists while the host is still reading, so an
      // interruption there leaves nothing to remove.
      const text = yield* source.text;
      if (text.trim().length === 0)
        return yield* reject({ _tag: 'EmptyText', role });
      const written = yield* projectPath(
        yield* writeText(text, source.name, root),
        role,
        root,
        task,
      );
      writtenFiles.push(written);
      files.push(written);
    }
    return [...new Set(files)];
  });

  const inputs = yield* filesOf('input');
  if (inputs.length === 0 && task === 'program')
    return yield* reject({ _tag: 'NoInput' });
  const contextFiles = yield* filesOf('context');
  return { ...splitMediaFiles(inputs), contextFiles, writtenFiles };
});

/** Inputs split by what a run does with each: binary media travels as
 *  media, so it stays out of the text a run interpolates and names its
 *  outputs after. */
export function splitMediaFiles(files: readonly string[]): {
  readonly inputFiles: string[];
  readonly mediaFiles: string[];
} {
  const mediaExtensions = getIncludedExtensions('media');
  const inputFiles: string[] = [];
  const mediaFiles: string[] = [];
  for (const file of files) {
    if (mediaExtensions.includes(path.extname(file).toLowerCase()))
      mediaFiles.push(file);
    else inputFiles.push(file);
  }
  return { inputFiles, mediaFiles };
}
