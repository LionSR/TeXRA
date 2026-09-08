# R-1: which filesystem surface? — the leaf conversion, measured

Status: proposed · 2026-09-08 · resolves the R-1 ruling on #12073

R-1 asked which filesystem surface the migration should converge on:

- **Candidate A** — the repo's own `FileSystemProvider` port (`platform().fs`).
- **Candidate B** — `effect`'s own `FileSystem` service.

The earlier framing treated this as one binary choice, and the first
experiment proposed for it was invalid: swapping `createFakePlatform`'s
default `fs` for another `FileSystemProvider` measures A against A. This note
records the corrected experiment — convert one leaf subsystem to take
`FileSystem` from context, delete its `platform().fs` use, and measure — and
what it found.

The experiment is commit `e4fc3df` on `claude/effect-ts-tracking-issues-usoj7h`,
green on typecheck, lint, both ratchets, and the full 8884-test suite. The
commit after it reverts the production half, for the reason in
"Why this was not landed" below.

## The leaf

`listWorkspaceFiles` (`src/common/files/workspaceFileListing.ts`) and
`workspaceFileOptions` (`src/controllers/session/workspaceFileOptions.ts`):
one production `platform()` site, one internal caller, three host consumers.
It is the launcher's workspace file catalog — a filtered recursive directory
walk.

## What the conversion cost

|                                |                                               |
| ------------------------------ | --------------------------------------------- |
| `platform()` sites removed     | 1                                             |
| Files touched                  | 17                                            |
| New infrastructure             | 384 lines (`effectNodeFileSystem.ts`)         |
| Test composition roots reached | 6                                             |
| Directory walk                 | **3,913 extra `stat` syscalls; 7–10× slower** |

Measured, not estimated. On a synthetic LaTeX-shaped workspace of 3,096
files across 302 directories (`scripts/bench/fs-walk-strategies.mjs`):

| Strategy                | `readdir` | `stat` | wall time      |
| ----------------------- | --------- | ------ | -------------- |
| A — repo port           | 302       | 2      | 25.7–31.9 ms   |
| B — `effect/FileSystem` | 302       | 3,915  | 220.0–254.2 ms |

The syscall counts are deterministic and are the number to reason about.
Wall time varied over seven runs; the ratio ranged 7.1–9.7× with a median of
8.7×.

The cause is not implementation quality. `FileSystem.readDirectory` returns
`Array<string>`; the repo's `FileSystemProvider.readDirectory` returns
`[string, number][]`, reading each entry's type off the `withFileTypes`
dirent for free and paying a `stat` only for the symlinks it must resolve.
Effect's shape forces one `stat` per entry — 3,913 extra syscalls here.

## Where Effect's surface is thinner than the port

These are gaps in the interface, not in any implementation of it. Each was
checked against `node_modules/effect/dist/FileSystem.d.ts` at 4.0.0-rc.112,
and the first two are pinned by tests in the experiment commit.

1. **No `lstat`.** `FileSystem.stat` follows symlinks and there is no
   non-following variant, so `File.Info.type` never reports `SymbolicLink`
   for a link to a real file. The port's `isSymlink` — documented as "does
   NOT follow the link" — is inexpressible. `readLink` plus an `EINVAL`
   catch is error-as-control-flow, not a substitute.
2. **`readDirectory` drops entry types**, per the measurement above.
3. **`copy` cannot dereference.** Its options are `overwrite` and
   `preserveTimestamps`. `runPackRunDir` snapshots a run directory into
   `workspace/History/` with `dereference: true` precisely so the snapshot is
   self-contained; through Effect's `copy` the snapshot would keep symlinks
   that dangle as soon as the run directory is cleaned.
4. **No atomic write and no publish.** The port's `writeFileAtomic` and
   `publishFile` (stage, fsync, rename) back durable run/flow state and
   execution-lease claims. Effect offers no equivalent; composing one from
   `makeTempFile` + `rename` reimplements `write-file-atomic` without its
   fsync and permission-preservation semantics.

## Why a partial layer is not an option

Core `effect` ships **no working `FileSystem` layer** — only `makeNoop` /
`layerNoop`. Its unimplemented methods do not signal "unimplemented": they
fabricate answers. `exists()` returns `Effect.succeed(false)`, and `access`,
`copy`, `copyFile`, `readFile`, `readDirectory`, `readLink` and `realPath`
fail with `NotFound` for paths that exist. Under the repo's
silent-degradation rule that is a defect generator, not a stub, so any
adoption of B needs a complete real implementation up front.

The two ways to get one:

- `@effect/platform-node`, which is not installed and carries a non-optional
  `redis` peer. Under this workspace's `autoInstallPeers: true`
  (`pnpm-lock.yaml:4`) that puts a Redis client in the **production** install
  graph with no warning, for `NodeFileSystem` and `NodePath`.
- Hand-write it: the 384 lines in the experiment. 25 required methods, plus
  `open` returning a `File` with 8 more, plus `watch` as a `Stream` and
  `glob`.

## Two hazards worth recording separately

**A converted subsystem escapes the test sandbox.** `FakePlatform` backs
`fs` with memfs. Code that takes `FileSystem` from context is served by
whatever layer the runtime carries — a `node:fs`-backed one in the
experiment — so the memfs sandbox silently stops applying. No test broke
here only because this leaf has none. Adopting B anywhere with memfs-based
tests needs a memfs-backed `FileSystem` layer built alongside; `layerNoop`
cannot serve, for the reason above.

**Promise → Effect conversions can pass typecheck at spread sites.** In
`desktopHostRequests.ts`, `...(await listWorkspaceFilesOfType(...))`
typechecked unchanged after the function started returning an `Effect`,
because `Effect` implements `Symbol.iterator` and `await` on a non-thenable
is legal. The error surfaced only downstream, where the resulting array was
used as `string[]`. A spread feeding a loosely typed sink would have compiled
and shipped broken. Worth a grep at every Promise→Effect conversion, not
just this one.

## Recommendation

**R-1 does not resolve to one surface — it splits by capability.**

- **Directory enumeration and symlink classification stay on the port.**
  Effect's surface is strictly weaker here: 3,913 extra syscalls on a
  3,096-file tree, plus an inexpressible `isSymlink`. This is where `platform().fs` earns its
  place.
- **Plain read / write / copy / remove can move to `effect/FileSystem`**,
  where the surfaces agree and the Effect version composes with the rest of
  the migration.
- The port therefore **shrinks to what Effect cannot express** —
  `isSymlink`, typed `readDirectory`, `writeFileAtomic`, `publishFile`,
  dereferencing `copy` — rather than being kept whole or deleted. That is a
  smaller target than #12071's 29 `platform()` sites imply, and it is the
  shape the Node lane (#12078) should assume for its filesystem half.

One caveat on candidate A's own standing: `nodeFilesystem` is the only
production implementation of `FileSystemProvider` — all three hosts install
it via `createNodePlatform`, and the extension does **not** swap in a
`vscode.workspace.fs`-backed provider. The doc comment on `BaseFS` saying it
does is stale and should be corrected. A port with one production
implementation is not earning abstraction; it is earning the five specific
capabilities listed above, which is a different and narrower claim.

## Why this was not landed

The conversion is correct and green, but it makes the launcher's file
catalog — which runs when a user opens the file picker — roughly eight times
slower. Real
workspaces carrying build artifacts are larger than the 3,096-file
benchmark. Shipping a known regression to settle a design question is the
wrong trade, so the production half is reverted in the commit that adds this
note; `e4fc3df` keeps the experiment reproducible.
