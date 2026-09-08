# Confined generated-file cleanup

This private N-API 8 addon removes tombstone-recorded execution directories without following links outside the admitted storage directory. Database access is separate from this addon; it contains no SQLite engine, connection, extension or VFS.

The native operation acquires a storage-directory handle synchronously before returning its Promise, opens the generated directory and execution IDs relative to that handle, and awaits cleanup before releasing its existing deletion claim. POSIX uses directory-relative system calls; Windows uses relative native handle opens with reparse-point refusal. Link leaves are removed without traversing their targets. The operation owns this one handle through worker completion, then releases it; JavaScript never owns a separate handle. Missing directories succeed; other failures retain the tombstone for retry.

This implements the original C9 deletion confinement contract. It does not couple SQLite's filename admission to the cleanup handle or claim atomic database/cleanup identity under concurrent replacement between their independent admissions.

The twelve targets in `targets.mjs` are built before application CI jobs. Downstream jobs consume artifacts from that same workflow run. Build-time Node 22.13 headers target stable N-API 8; actual host checks use the approved Node 22.16.0 runtime floor. Headers are checksum-verified; no compiler or download runs in the installed application. The Windows delay-load hook resolves N-API symbols from the running Node or Electron host.

Desktop packaging unpacks every native asset. The afterPack hook checks exact bytes before signing, and the final verifier checks target presence and unpacked placement after signing. Node and Electron load the cleanup binary through ordinary module loading, including Electron's ASAR handling.

Cross-compilation and ABI inspection are not runtime evidence. The workflow executes cleanup on matching Darwin, Windows and Linux x64 GNU hosts, and runs the existing confinement suite, including Windows junction and UNC cases. Other Linux targets require their matching host for runtime proof.

## Local build and test setup

The native binaries are build artifacts, not tracked source files. A clean checkout needs all twelve artifacts before running the full test suite or packaging an application. The package tests compare real binary bytes and therefore require the same artifacts as the package build.

Choose a successful run of the native workflow, or its calling CI workflow, whose native implementation and build inputs match the checkout. Compare `scripts/native-cleanup/` and the compiler, header and target settings in `.github/workflows/native-cleanup.yml` against that run's source revision, including local uncommitted changes. The application commit may differ when those inputs are unchanged. Download every target from that one run; older binaries are not valid evidence for changed native code. With GitHub CLI authentication already configured, run the following from the repository root, replacing `RUN_ID` with the selected run number:

```sh
node --input-type=module - RUN_ID <<'JS'
import { execFileSync } from 'node:child_process';
import { nativeCleanupTargets } from './scripts/native-cleanup/targets.mjs';
const runId = process.argv[2];
for (const target of nativeCleanupTargets) {
  execFileSync('gh', [
    'run', 'download', runId,
    '--name', `native-cleanup-${target}`,
    '--dir', 'scripts/native-cleanup/prebuilds',
  ], { stdio: 'inherit' });
}
JS
```

After the download succeeds, run `npm test` or the required package build. When native implementation or build inputs change, rebuild the affected targets locally before validating them. For example, with the workflow's Clang toolchain on macOS:

```sh
node scripts/native-cleanup/prepare-headers.mjs /tmp/texra-native-headers
node scripts/native-cleanup/build.mjs --target darwin-arm64 --headers /tmp/texra-native-headers/node-v22.13.0/include/node
node scripts/native-cleanup/build.mjs --target darwin-x64 --headers /tmp/texra-native-headers/node-v22.13.0/include/node
```

For GNU/Linux targets, use Zig 0.14.1 and the corresponding target from `targets.mjs`, for example:

```sh
node scripts/native-cleanup/prepare-headers.mjs /tmp/texra-native-headers
node scripts/native-cleanup/build.mjs --target linux-x64-gnu --headers /tmp/texra-native-headers/node-v22.13.0/include/node
```

On Windows, use the matching MSVC developer environment and obtain the architecture's import library. For x64, run:

```powershell
node scripts/native-cleanup/prepare-headers.mjs "$env:TEMP/texra-native-headers" x64
node scripts/native-cleanup/build.mjs --target win32-x64 --headers "$env:TEMP/texra-native-headers/node-v22.13.0/include/node" --node-lib "$env:TEMP/texra-native-headers/node.lib"
```

Use the workflow's matching host toolchains for the remaining targets. A change to common native code requires all twelve binaries to be rebuilt; a platform-specific change requires each affected target. CI always rebuilds all twelve from its own source before downstream packaging and tests consume those artifacts. Installed applications never download or compile them.
