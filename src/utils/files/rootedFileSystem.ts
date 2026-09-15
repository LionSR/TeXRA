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

// Node imports
import { platform } from 'node:process';

// Third-party imports
import { Effect, FileSystem, Path, PlatformError, Stream } from 'effect';
import { Glob } from 'glob';

// Local imports
import {
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

/**
 * The options Node's `fs.glob` compiles a pattern with (`createMatcher` in
 * `lib/internal/fs/glob.js`). Effect's Node `FileSystem.glob` delegates to
 * `fs.glob`, whose matcher is its bundled minimatch; `glob`'s `Glob`
 * compiles with the same minimatch release line, so given these options it
 * produces the segment matchers the walker will run.
 */
const NODE_GLOB_MATCHER_OPTIONS = {
  nocase: platform === 'win32' || platform === 'darwin',
  windowsPathsNoEscape: true,
  nonegate: true,
  nocomment: true,
  optimizationLevel: 2,
  platform,
  nocaseMagicOnly: true,
} as const;

type CompiledGlobSegment = Glob<
  typeof NODE_GLOB_MATCHER_OPTIONS
>['patterns'][number];

/**
 * The first compiled alternative of `pattern` that can leave `root`, or
 * `undefined` when none can. The rule is the engine's own: compile the
 * pattern as the walker does — brace expansion, escapes, bracket classes,
 * extglobs and separators all resolved by minimatch — then reject an
 * alternative that is absolute, or that has a segment whose matcher accepts
 * the literal `..`. Nothing is recognised by spelling, so `\.\./x`,
 * `[.][.]/x`, `{a,../b}` and `@(..|a)` all fall to the same check.
 */
function globEscape(pattern: string, root: string): string | undefined {
  const { patterns } = new Glob(pattern, {
    ...NODE_GLOB_MATCHER_OPTIONS,
    cwd: root,
  });
  for (const alternative of patterns) {
    if (alternative.isAbsolute()) return alternative.globString();
    for (
      let segment: CompiledGlobSegment | null = alternative;
      segment !== null;
      segment = segment.rest()
    ) {
      const matcher = segment.pattern();
      if (
        matcher === '..' ||
        (matcher instanceof RegExp && matcher.test('..'))
      ) {
        return alternative.globString();
      }
    }
  }
  return undefined;
}

/**
 * The first temp-name fragment that is not a plain filename fragment, or
 * `undefined`: the platform joins `prefix`/`suffix` onto the directory, so a
 * separator, `.`/`..` or a NUL would place the entry somewhere else.
 */
function tempNameEscape(options: {
  readonly prefix?: string | undefined;
  readonly suffix?: string | undefined;
}): string | undefined {
  return [options.prefix, options.suffix].find(
    (fragment) =>
      fragment !== undefined &&
      (/[/\\\0]/.test(fragment) || fragment === '.' || fragment === '..'),
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
  /**
   * A temporary entry created under the root: `directory` confined, `prefix`
   * and `suffix` accepted only as filename fragments, and the created path
   * checked against the root once more before it is handed back.
   */
  const temp = <R>(
    method: string,
    options:
      | {
          readonly directory?: string | undefined;
          readonly prefix?: string | undefined;
          readonly suffix?: string | undefined;
        }
      | undefined,
    create: (
      directory: string,
    ) => Effect.Effect<string, PlatformError.PlatformError, R>,
  ) =>
    Effect.gen(function* () {
      const fragment = tempNameEscape(options ?? {});
      if (fragment !== undefined) {
        return yield* Effect.fail(
          PlatformError.badArgument({
            module: MODULE,
            method,
            description: `temp name fragment is not a file name: ${fragment}`,
          }),
        );
      }
      const directory = yield* inRoot(method, options?.directory);
      const created = yield* create(directory);
      return yield* at(method, created);
    });

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
    // Confined like every other method: no compiled alternative of the
    // pattern may be absolute or have a segment matching `..`, and every
    // match must still resolve under the root. A symlinked directory inside
    // the root is followed, as a read through it would be.
    glob: (pattern, options) =>
      Effect.gen(function* () {
        const resolvedRoot = yield* inRoot('glob', options?.root);
        const escaping = yield* Effect.try({
          try: () => globEscape(pattern, resolvedRoot),
          catch: (cause) =>
            PlatformError.badArgument({
              module: MODULE,
              method: 'glob',
              description: `pattern does not compile: ${pattern}`,
              cause,
            }),
        });
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
      temp('makeTempDirectory', options, (directory) =>
        fs.makeTempDirectory({ ...options, directory }),
      ),
    makeTempDirectoryScoped: (options) =>
      temp('makeTempDirectoryScoped', options, (directory) =>
        fs.makeTempDirectoryScoped({ ...options, directory }),
      ),
    makeTempFile: (options) =>
      temp('makeTempFile', options, (directory) =>
        fs.makeTempFile({ ...options, directory }),
      ),
    makeTempFileScoped: (options) =>
      temp('makeTempFileScoped', options, (directory) =>
        fs.makeTempFileScoped({ ...options, directory }),
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
    removeEmptyDirectory: on('removeEmptyDirectory', (resolved) =>
      bound(removeEmptyDirectory(resolved)),
    ),
    readDirectoryTyped: on('readDirectoryTyped', (resolved) =>
      bound(readDirectoryTyped(resolved)),
    ),
  };
}
