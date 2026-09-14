/**
 * A `FileSystem` confined to one root.
 *
 * The static `WorkspaceFS` / `StorageFS` facades resolve every path against
 * the ambient `workspaceRoots()` at call time, which is why a caller that
 * wants a different root has to enter an AsyncLocalStorage scope around its
 * I/O. A rooted view inverts that: the root is captured when the view is
 * built, the view resolves relative paths against it, refuses paths that
 * escape it, and delegates every operation to the standard library's
 * `FileSystem`. A consumer takes the view from context and never reads a root.
 *
 * The view IS a `FileSystem.FileSystem`, so its operations, options and
 * errors are the standard ones: an escape fails with `PlatformError`'s
 * `BadArgument` reason, and everything else fails with whatever the
 * underlying filesystem reports (`SystemError`, matched by `reason._tag`).
 */

// Third-party imports
import { Effect, FileSystem, Path, PlatformError, Stream } from 'effect';

// Local imports
import {
  publishFile,
  readDirectoryTyped,
  removeEmptyDirectory,
  writeFileAtomic,
} from './fsDurability';

const MODULE = 'RootedFileSystem';

/**
 * A `FileSystem` whose paths are resolved against — and confined to — one
 * root, plus the durability primitives of {@link './fsDurability'} bound to
 * that same root.
 */
export interface RootedFileSystem extends FileSystem.FileSystem {
  /**
   * The absolute root every relative path resolves against.
   *
   * `undefined` only for the workspace view of a session with no folder
   * open, where every operation fails with `BadArgument` — the typed form of
   * what `WorkspaceFS` threw ("Workspace path is not available."). A consumer
   * that needs the root as a value (a glob's `cwd`) checks it and does
   * nothing, exactly as it checked `WorkspaceFS.getPath()`.
   */
  readonly root: string | undefined;
  /** The confined absolute path of `target`, for the rare operation that
   *  spans two roots and needs each side vouched for by its own view. */
  readonly resolve: (
    target: string,
  ) => Effect.Effect<string, PlatformError.PlatformError>;
  /**
   * Crash-safe replace: stage, fsync, rename over the target. The target's
   * real path is resolved first, as `write-file-atomic` does, so a symlink
   * inside the root that points outside it is written through — the same
   * reach `platform().fs.writeFileAtomic` has always had, and the reason this
   * operation is documented as storage-only, never for workspace files.
   */
  readonly writeFileAtomic: (
    target: string,
    data: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Publish a single-writer name: staged, fsynced, renamed into place. */
  readonly publishFile: (
    target: string,
    data: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Remove `target` only if it is an empty directory. */
  readonly removeEmptyDirectory: (
    target: string,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Directory entries with the type of each, one `stat` per entry. */
  readonly readDirectoryTyped: (
    target: string,
  ) => Effect.Effect<
    ReadonlyArray<readonly [string, FileSystem.File.Type]>,
    PlatformError.PlatformError
  >;
}

/**
 * Build the resolver for one root: relative paths join the root, absolute
 * paths must already be inside it, and anything that lands outside fails
 * with `BadArgument` rather than reaching the filesystem.
 */
function resolverFor(root: string | undefined, path: Path.Path) {
  return (method: string, target: string) =>
    Effect.suspend(() => {
      if (root === undefined) {
        return Effect.fail(
          PlatformError.badArgument({
            module: MODULE,
            method,
            description: 'no workspace folder is open',
          }),
        );
      }
      const resolved = path.resolve(root, target);
      const relative = path.relative(root, resolved);
      const escapes =
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`);
      return escapes
        ? Effect.fail(
            PlatformError.badArgument({
              module: MODULE,
              method,
              description: `path escapes the root ${root}: ${target}`,
            }),
          )
        : Effect.succeed(resolved);
    });
}

/** More brace alternatives than this is a pattern no caller writes. */
const MAX_GLOB_ALTERNATIVES = 256;

/** Split a brace body on its top-level commas, honouring escapes and
 *  nested braces. */
function topLevelAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\') i++;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

/**
 * Every brace alternative of `pattern`, so `{a,../b}/**` is checked as both
 * `a/**` and `../b/**`. A group without a top-level comma (`{a}`, a range
 * like `{1..3}`) is left as written; the scan continues past it. `undefined`
 * when the expansion exceeds {@link MAX_GLOB_ALTERNATIVES}.
 */
function braceAlternatives(pattern: string): string[] | undefined {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
    } else if (char === '{') {
      if (depth++ === 0) open = i;
    } else if (char === '}' && depth > 0 && --depth === 0) {
      const parts = topLevelAlternatives(pattern.slice(open + 1, i));
      if (parts.length > 1) {
        const expanded: string[] = [];
        for (const part of parts) {
          const rest = braceAlternatives(
            pattern.slice(0, open) + part + pattern.slice(i + 1),
          );
          if (rest === undefined) return undefined;
          expanded.push(...rest);
          if (expanded.length > MAX_GLOB_ALTERNATIVES) return undefined;
        }
        return expanded;
      }
    }
  }
  return [pattern];
}

/**
 * The alternative of a glob pattern that names a place outside the root, or
 * `undefined` when none does: an absolute alternative (POSIX, UNC or drive
 * letter), or one with a `..` segment — including a `..` inside an extglob
 * group such as `@(..|x)`. Separators are both `/` and `\`, which on POSIX
 * also rejects the rare pattern that escapes a dot. A pattern too large to
 * expand is reported as escaping rather than delegated unchecked.
 */
function globEscape(pattern: string, path: Path.Path): string | undefined {
  const alternatives = braceAlternatives(pattern);
  if (alternatives === undefined) return pattern;
  return alternatives.find(
    (alternative) =>
      path.isAbsolute(alternative) ||
      /^[A-Za-z]:/.test(alternative) ||
      alternative.startsWith('\\') ||
      alternative
        .split(/[\\/]/)
        .some((segment) =>
          segment
            .split(/[()|]/)
            .some((token) => token.replace(/^[?*+@!]/, '') === '..'),
        ),
  );
}

/**
 * A view of `fs` rooted at `root`. One implementation for every rooted
 * service: the tags in `@platform/rootedFs` differ only in which root they
 * capture.
 */
export function rootedFileSystem(
  root: string | undefined,
  fs: FileSystem.FileSystem,
  path: Path.Path,
): RootedFileSystem {
  const at = resolverFor(root, path);
  /** Run `use` on the confined path of `target`. */
  const on =
    <A, E, R>(
      method: string,
      use: (resolved: string) => Effect.Effect<A, E, R>,
    ) =>
    (target: string) =>
      Effect.flatMap(at(method, target), use);
  /** Run `use` on the confined paths of both arguments. */
  const onPair =
    <A, E, R>(
      method: string,
      use: (from: string, to: string) => Effect.Effect<A, E, R>,
    ) =>
    (from: string, to: string) =>
      Effect.flatMap(at(method, from), (resolvedFrom) =>
        Effect.flatMap(at(method, to), (resolvedTo) =>
          use(resolvedFrom, resolvedTo),
        ),
      );
  /** A temp-path option set confined to the root. */
  const inRoot = (method: string, directory: string | undefined) =>
    at(method, directory ?? '.');

  const base = FileSystem.make({
    access: (target, options) =>
      on('access', (resolved) => fs.access(resolved, options))(target),
    chmod: (target, mode) =>
      on('chmod', (resolved) => fs.chmod(resolved, mode))(target),
    chown: (target, uid, gid) =>
      on('chown', (resolved) => fs.chown(resolved, uid, gid))(target),
    copy: (from, to, options) =>
      onPair('copy', (a, b) => fs.copy(a, b, options))(from, to),
    copyFile: (from, to) => onPair('copyFile', fs.copyFile)(from, to),
    // Confined lexically, like every other method: the pattern may not name
    // an absolute path or a `..` segment in any brace or extglob alternative,
    // and every match must still resolve under the root. A symlinked
    // directory inside the root is followed, as a read through it would be.
    glob: (pattern, options) =>
      Effect.gen(function* () {
        const resolvedRoot = yield* inRoot('glob', options?.root);
        const escaping = globEscape(pattern, path);
        if (escaping !== undefined) {
          return yield* Effect.fail(
            PlatformError.badArgument({
              module: MODULE,
              method: 'glob',
              description: `pattern escapes the root ${root}: ${escaping}`,
            }),
          );
        }
        const matches = yield* fs.glob(pattern, {
          ...options,
          root: resolvedRoot,
        });
        yield* Effect.forEach(
          matches,
          (match) => at('glob', path.resolve(resolvedRoot, match)),
          { discard: true },
        );
        return matches;
      }),
    link: (from, to) => onPair('link', fs.link)(from, to),
    makeDirectory: (target, options) =>
      on('makeDirectory', (resolved) => fs.makeDirectory(resolved, options))(
        target,
      ),
    makeTempDirectory: (options) =>
      Effect.flatMap(
        inRoot('makeTempDirectory', options?.directory),
        (directory) => fs.makeTempDirectory({ ...options, directory }),
      ),
    makeTempDirectoryScoped: (options) =>
      Effect.flatMap(
        inRoot('makeTempDirectoryScoped', options?.directory),
        (directory) => fs.makeTempDirectoryScoped({ ...options, directory }),
      ),
    makeTempFile: (options) =>
      Effect.flatMap(inRoot('makeTempFile', options?.directory), (directory) =>
        fs.makeTempFile({ ...options, directory }),
      ),
    makeTempFileScoped: (options) =>
      Effect.flatMap(
        inRoot('makeTempFileScoped', options?.directory),
        (directory) => fs.makeTempFileScoped({ ...options, directory }),
      ),
    open: (target, options) =>
      on('open', (resolved) => fs.open(resolved, options))(target),
    readDirectory: (target, options) =>
      on('readDirectory', (resolved) => fs.readDirectory(resolved, options))(
        target,
      ),
    readFile: on('readFile', fs.readFile),
    readLink: on('readLink', fs.readLink),
    realPath: on('realPath', fs.realPath),
    remove: (target, options) =>
      on('remove', (resolved) => fs.remove(resolved, options))(target),
    rename: (from, to) => onPair('rename', fs.rename)(from, to),
    stat: on('stat', fs.stat),
    // A symlink's target is the text stored in the link, resolved by the OS
    // relative to the link's own directory at read time — not a path of this
    // view. Only the link location is confined; the target passes verbatim.
    symlink: (from, to) =>
      on('symlink', (resolvedTo) => fs.symlink(from, resolvedTo))(to),
    truncate: (target, length) =>
      on('truncate', (resolved) => fs.truncate(resolved, length))(target),
    utimes: (target, atime, mtime) =>
      on('utimes', (resolved) => fs.utimes(resolved, atime, mtime))(target),
    watch: (target, options) =>
      Stream.unwrap(
        Effect.map(at('watch', target), (resolved) =>
          fs.watch(resolved, options),
        ),
      ),
    writeFile: (target, data, options) =>
      on('writeFile', (resolved) => fs.writeFile(resolved, data, options))(
        target,
      ),
  });

  /** The durability primitives run on this view's own filesystem, not on
   *  whatever the calling fiber happens to carry. */
  const bound = <A, E>(
    program: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    program.pipe(
      Effect.provideService(FileSystem.FileSystem)(fs),
      Effect.provideService(Path.Path)(path),
    );

  return {
    ...base,
    root,
    resolve: (target) => at('resolve', target),
    writeFileAtomic: (target, data) =>
      on('writeFileAtomic', (resolved) =>
        bound(writeFileAtomic(resolved, data)),
      )(target),
    publishFile: (target, data) =>
      on('publishFile', (resolved) => bound(publishFile(resolved, data)))(
        target,
      ),
    removeEmptyDirectory: on('removeEmptyDirectory', (resolved) =>
      bound(removeEmptyDirectory(resolved)),
    ),
    readDirectoryTyped: on('readDirectoryTyped', (resolved) =>
      bound(readDirectoryTyped(resolved)),
    ),
  };
}
