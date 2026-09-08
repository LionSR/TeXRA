# Confined generated-file cleanup

This private N-API 8 addon removes tombstone-recorded execution directories without following links outside the admitted storage directory. SQL uses the official Effect SQLite client; this addon contains no SQLite engine, connection, extension or VFS.

The deletion worker acquires a storage-directory handle for each operation, opens the generated directory and execution IDs relative to that handle, and awaits cleanup before releasing its existing deletion claim. POSIX uses directory-relative system calls; Windows uses relative native handle opens with reparse-point refusal. Link leaves are removed without traversing their targets. The asynchronous worker owns a duplicated handle, so closing the JavaScript handle cannot invalidate an active worker. Missing directories succeed; other failures retain the tombstone for retry.

This implements the original C9 deletion confinement contract. It does not couple SQLite's filename admission to the cleanup handle or claim atomic database/cleanup identity under concurrent replacement between their independent admissions.

The twelve targets in `targets.mjs` are built before application CI jobs. Downstream jobs consume artifacts from that same workflow run. Build-time Node 22.13 headers target stable N-API 8; actual host checks use the approved Node 22.16.0 runtime floor. Headers are checksum-verified; no compiler or download runs in the installed application. The Windows delay-load hook resolves N-API symbols from the running Node or Electron host.

Desktop packaging unpacks every native asset. The afterPack hook checks exact bytes before signing, and the final verifier checks target presence and unpacked placement after signing. Node and Electron load the cleanup binary through ordinary module loading, including Electron's ASAR handling.

Cross-compilation and ABI inspection are not runtime evidence. The workflow executes cleanup on matching Darwin, Windows and Linux x64 GNU hosts, and runs the existing confinement suite, including Windows junction and UNC cases. Other Linux targets require their matching host for runtime proof.
