# Native session storage

The N-API 8 module provides SQLite connections and generated-directory removal under one held storage-directory handle. `src/agent/storage/nativeSessionStorage.mts` loads the packaged binary. `Database` owns the directory lifetime and supplies the same directory to persistent SQLite admission and generated-file cleanup. Replacing the directory's former pathname cannot redirect either operation to a different directory.

Effect SQL owns statement composition and transaction scope. The native connection executes statements against the host's SQLite engine; application schemas, event ordering, ownership claims and deletion decisions remain in TypeScript. The native module does not contain or link a second SQLite engine.

## Connection and directory ownership

An empty in-memory `node:sqlite` connection loads the binary through SQLite's public extension interface. Its `sqlite3_extension_init` entry receives the host engine's public API table. The N-API entry then opens the owned connection through that table. The bootstrap connection closes immediately afterward; it stores no session data and creates no database file. The extension is loaded from the operating system's physical path for the already-loaded native module, so Electron's logical ASAR path never reaches SQLite's system loader. This mechanism uses neither Node's private ABI nor process-wide interception of the default SQLite VFS.

Each persistent connection registers a private SQLite VFS. Database, journal, WAL and shared-memory files are opened relative to its retained directory handle. POSIX uses descriptor-relative operations and open-file-description locks; Windows uses handle-relative opens, byte-range locks and handle-backed mappings. The SQLite file format and cross-process lock protocol remain compatible with ordinary SQLite. Directory acquisition and database opening remain synchronous for existing host construction; generated-directory traversal runs asynchronously with its own duplicated directory handle. The owning Effect waits for that traversal before releasing the deletion claim.

Persistent sessions acquire their directory at database admission. Explicit in-memory sessions open no storage directory and create no storage files unless generated-file cleanup is requested. Their first cleanup acquires a directory handle retained by the same scoped owner for subsequent attempts. Local-filesystem admission belongs to persistent database opening; it does not prohibit explicit in-memory cleanup on an otherwise supported UNC share.

Multiple rooted connections in one process and ordinary SQLite connections in separate processes are supported. Do not mix rooted and ordinary filesystem-backed SQLite connections to the same database in one process. On POSIX, closing an unrelated descriptor can release that process's ordinary SQLite locks; ordinary SQLite's internal descriptor bookkeeping does not include the private VFS. All production session connections therefore use the rooted implementation. Sequential ordinary SQLite fixture access after rooted connections close remains valid.

## Supported artifacts

The Node floor is 22.13.0. `targets.mjs` defines the twelve binaries included in the universal extension, CLI and SDK bundles: macOS x64/arm64; Windows x64/arm64/ia32; GNU/Linux x64/arm64/arm/ppc64le/s390x; and musl Linux x64/arm64. The desktop distribution uses its existing macOS universal, Windows x64 and Linux x64 targets. GNU/Linux builds explicitly target glibc 2.28, macOS builds target macOS 11, and Windows builds use the Windows 10 API floor. Windows delay-loads N-API symbols from the running host so the same binary can load in Node and Electron.

Prebuilt binaries are included in each application artifact. Runtime installation never downloads or compiles native code. esbuild copies the native assets and preserves their relative locations when it creates shared JavaScript chunks. Desktop packages leave the binaries outside ASAR. Build checks compare all twelve bundled binaries with the corresponding prebuild bytes. The desktop `afterPack` hook repeats that check after copying and universal merging, before signing can change Mach-O bytes. Final desktop package checks require every target to remain present and unpacked; signature verification belongs to the signing checks.

## Building and checking

Prepare the fixed Node and SQLite extension headers, then build the development host's target:

```sh
node scripts/native-cleanup/prepare-headers.mjs /tmp/texra-node-headers
node scripts/native-cleanup/build.mjs --target darwin-arm64 --headers /tmp/texra-node-headers/node-v22.13.0/include/node
```

Header acquisition verifies Node's release checksums and the pinned SQLite header hashes from Node 22.13.0. It downloads headers only, not a SQLite engine. macOS uses Clang; Linux uses Zig 0.14.1 with the explicit compiler target in `targets.mjs`. Windows requires the matching MSVC architecture environment. Pass `x64`, `arm64` or `x86` as the header preparation script's second argument to obtain that architecture's `node.lib`, then supply `--node-lib <header-directory>/node.lib` to the build command.

The source Vitest runner loads the actual host binary. A host-only source test needs that binary; universal bundle builds require all twelve. Rebuild affected binaries whenever native sources or headers change. The `native-cleanup.yml` workflow builds the target matrix first, and downstream application jobs download the artifacts from that same workflow run. For a local universal build, obtain the complete artifacts for the source revision being built. Missing binaries fail the build.

Compilation and import-table inspection do not establish runtime correctness on another operating system. The workflow's Node and Electron smoke steps must load the public host SQLite interface, commit and read a rooted database, verify ordinary SQLite access, and open an explicit in-memory connection. The existing `sessionEvents.vitest.ts` suite exercises generated-file confinement, including actual Windows junctions, renamed storage and an SMB share supplied by the Windows job. Windows runtime success is a release gate; successful cross-compilation alone does not satisfy it. Broader SQLite verification must preserve concurrent rooted connections, ordinary SQLite writers in separate processes, shared-memory growth, and recovery after a writer process is terminated.
