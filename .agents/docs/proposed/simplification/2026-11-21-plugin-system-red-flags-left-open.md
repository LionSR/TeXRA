# The plugin system: what the 2026-11-21 red-flag pass left open

Date: 2026-11-21
Status: proposed (re-verified 2026-11-23: 3, 4, 5, 7, 8 and half of 10
landed; 9 declined; 1, 2, 6, 11 and 12 wait on a decision)

Origin: a pass over the plugin table, the native loader, the install and
trust modules, hooks and MCP servers for design red flags and
simplifications, after the fix that imports each native revision from its
own copy of the plugin. These landed on the branch that adds this note:

- a step's pin and the catalog layer take no option only a suite left out
  (`installed`, the absent reader, change stream, switch stream, server
  loader and copies directory, and `ProcessCatalog.listed`);
- one table for what a native entry may contribute (`NAMED_KINDS`,
  `SINGLE_KINDS`, `packages/harness/src/common/plugins/nativeEntry.ts`),
  read by the pattern, the refusal, the review, the loader and the
  `plugin_manager` description;
- `InstalledPlugins.unloadedComponents`, the plain `Error` in `install`'s
  type, two unused exports and two unused defaults in
  `packages/harness/src/common/plugins/pluginPrograms.ts`, `hookDenied`'s
  unread parameter, the unreachable `/bin/sh` fallback, and five comments
  that said what the code does not.

Each item below was read in the code; where a consequence is inferred and
not reproduced, it says so.

## Open

1. **Whether a native revision loads is decided in three places that feed
   each other.** The loader imports and checks it
   (`packages/harness/src/tools/nativePlugins.ts`), the table accepts or
   withholds it (`withNatives`, `packages/harness/src/tools/toolTable.ts`),
   and a step brings its layers up
   (`pinStep`, `packages/harness/src/tools/sessionTools.ts`). A failure in
   the third is reported back to the first (`layerFailed`, which writes a second
   record of failed revisions, the loader's `rejected` map, beside its cache), the step reads the
   installed plugins again in a loop until no layer fails, and the catalog
   keeps `previous` beside the revision in use so that a revision already
   published can be stepped back from
   (`packages/harness/src/tools/liveTools.ts`). The shape that would remove
   the loop, `previous` and the second record: a revision is published only
   once its process layer is up. A session layer is per session, so it
   cannot be part of that; this needs a design pass, not a sweep.

2. **The copies of native code carry hand-written process tracking.**
   `processCopies` (`packages/harness/src/tools/nativePlugins.ts`) names a
   process's directory by its id and removes the directories of processes
   that no longer run. The alternative is Effect's scoped temp directory
   under the system's temp folder, which needs none of it, but macOS and
   systemd remove temp files left unread for days, and a window open that
   long would lose the files its plugin reads later. Also open: every
   process copies every revision it loads (a one-shot `texra run` pays the
   copy each time), a revision's copy stays until the process ends, and the
   copy is not digested, so a write between the read that found the plugin
   trusted and the copy runs under the trusted revision (the same window
   the import had before). Each is an owner decision.

3. **An MCP server's identity is derived three ways.** `McpServerPlugin`
   (`packages/harness/src/tools/mcp/mcpConfig.ts`) carries `spec` and
   `revision` beside `config`; both are read only to be hashed, once for
   the server's key and once for the revision an offered tool records, and
   `HeldServer.revision` is a different value under the same name. The
   field's comment says the env digest is never recorded; the recorded
   revision hashes it. Compute the recorded revision once where the plugin
   is made and drop `spec`. The hash input must stay the same bytes, or
   every MCP tool's recorded identity changes once.
   **Landed 2026-11-23** (d293861ce9): `mcpPlugin` computes the recorded
   revision once over the same bytes; `spec` is gone, and the server key
   and `holdServer` read the revision.

4. **A hook's identity is a string built in one place and cut by position
   in two.** `packages/harness/src/agent/runtime/loop/hooks.ts` builds it,
   then splits on `#`, on the last `@`, and on `/` counted from the end;
   each cut depends on the id format of
   `packages/harness/src/common/plugins/hookConfig.ts`, whose source part
   is a file path the plugin chose. Inferred, not reproduced: a hooks file
   with `#` in its name records a cut-off name, and one that starts with
   `#` an empty one, which `packages/harness/src/shared/schemas/hookOutcome.ts`
   refuses. One reader beside the builder.
   **Landed 2026-11-23** (2feecfb4f2): `readIdentity` beside `identityOf`
   cuts at the first `#` and reads the event from the end of the hook id;
   no regression test (the cut is a pure function behind a full run).

5. **Hook output is decoded twice, and the path runs with no hooks.**
   `packages/harness/src/common/plugins/hookProtocol.ts` decodes a hook's
   output against its event's schema and then decodes the same value again
   in each branch only to narrow its type; `encodeHookInput` decodes a value
   the harness built. The pre-tool-use path builds its input, with a walk
   up the run's parents, before it checks that any hook matched. Decode once
   in the switch and return early when nothing matched.
   **Landed 2026-11-23** (f9ab9c5539): `effectOf` decodes once in its
   switch; `encodeHookInput` is gone; `hooksAt` takes a builder over the
   common fields and reads them only when a hook runs, which covers every
   point, not only `PreToolUse`.

6. **A hook outcome row stores fields nothing reads.** Its `status`
   (six values), `exitCode`, `durationMs`, `ignored` and `stderr` have no
   reader in any package's source; the run state reads the row by its
   point and the guard reads its decision. Either a view shows them or they
   go. A stored row changes, so a row version does too. Still open
   2026-11-23: which of the two is the owner's decision.

7. **`PluginRequestError` says one thing and three sites do another.** Its
   doc (`packages/harness/src/common/plugins/pluginManifest.ts`) covers a
   marketplace that needs the plugin named; the three such failures in
   `packages/harness/src/common/plugins/marketplace.ts` raise `PluginError`.
   The one branch on the kind is the CLI's exit code
   (`packages/cli/src/commands/plugin.ts`), so these exit 1 where a usage
   mistake exits 2. Changing them changes an exit code.
   **Landed 2026-11-23** (b29c9b9db9): the three raise
   `PluginRequestError`, whose doc now covers them; they exit 2.

8. **A local install reads any failure of its path as "not a directory".**
   `installOrigin` (`packages/harness/src/common/plugins/installedPlugins.ts`)
   maps every `realPath` failure to the request error and drops the cause,
   so a folder the process may not read is reported as a mistyped source.
   Absence is the request error; anything else is the read's own failure.
   **Landed 2026-11-23** (1d1e1e7ae1): only `meansAbsent` is the request
   error.

9. **`InstalledPluginLoad.envKey` is optional for a case its reader cannot
   meet.** It is absent only when nothing loads
   (`packages/harness/src/common/plugins/pluginTrust.ts`), and its one
   reader, `packages/harness/src/tools/pluginCatalog.ts`, branches on its
   absence per plugin; that layer also holds the key as a cached read of
   its own.
   **Declined 2026-11-23.** The key is the one the same read digested the
   trust under, so a plugin's trust and its servers' revisions share one
   read. Reading it in the catalog instead adds a failure branch to a reader
   that never fails; reading it with nothing enabled would create the key,
   and turn a store fault into a warning, for a user with no plugin.

10. **Where a managed plugin lives, and whether a plugin is local, are
    worked out again in each function.** The directory is joined three times
    in `installedPlugins.ts`, and "no `commit` means local" is tested five
    times across it, `pluginTrust.ts` and the CLI's listing; the rule is
    stated once, in
    `packages/harness/src/shared/schemas/installedPlugin.ts`.
    **Directory half landed 2026-11-23** (9f1518d420): `managedDir`. The
    local half is declined: each site reads the `commit` field the schema
    documents and uses the narrowed commit; a predicate would not narrow
    it.

11. **The enabled plugins are read and digested from six places.**
    `readInstalledPluginLoad` is called by the catalog, the plugin agents
    (twice), a program's launch, the runtime skills and the facade.
    **Established 2026-11-23: two reads disagree within one model request.**
    A CLI run on `main` (`6b29e26c7f`) disabled one installed plugin between
    the step's pin and the delegation listing. The offer kept the plugin's
    program (`openStep` lists the contributions it accepted), while
    `stepFor` then called `readDelegationTargets`, which scans the install
    records again and found the plugin's agent gone. So the same request
    told the model "Agents no longer available: alfalfa:companion" and still
    declared `alfalfa:summary` in the `script` tool
    (`packages/harness/src/agent/runtime/loop/step.ts`,
    `packages/harness/src/agent/runtime/delegation/pluginAgents.ts`).
    Proposed fix: keep the model-facing agent metadata with the installed
    revision the step pinned, and build the delegation section from that
    value, deleting its own install scan. Keep the live authorization check
    for when the model actually launches a child. Acceptance: disable a data
    plugin between those two reads, and check that its agent and program
    move together in the saved request.

12. **Names on the plugin authoring entry with no importer.**
    `buildFileAttachment` with its options type has none anywhere;
    `makeJsonRpcConnection` and `GlobalStorageFs` are imported only by
    suites (`packages/harness/src/tools/pluginSurface.ts`). The entry is the
    published surface and the value a native plugin is handed, so removal
    is the owner's call.

## Checked and declined

- **`InstalledPlugins.describeNative` as a second name for
  `describeProvides`.** It is how the CLI reaches it: a host imports no
  harness internal.
- **`ToolCatalog` and `ToolCatalogOwner`, one object under two tags.** The
  narrow tag is what a host and a plugin layer may read; the wide one adds
  the shutdown step and the session catalog.
- **`SessionTools.table` beside `published`.** A root launch reads the
  installed plugins; a child takes the table its parent's step read.
- **The git source checked twice, and a name claimed twice, in an
  install.** The second of each is the check at the boundary: a
  marketplace's own sources, and a concurrent install.
- **`copyPlugin` on `fs.copy`.** Node's copy takes `.git` and points a link
  inside the plugin at the original, not at the copy.
- **The digest's `LRUCache` on Effect's `Cache`.** It is a synchronous
  bounded map; Effect's is effectful.
- **The third-party gate as a mark on the tool**, an agent's own programs
  joining the table, and their per-step hashing: recorded in
  `2026-11-20-self-operation-left-open.md`, unchanged. There are still two
  loaders, both gated.
- **The MCP client on Effect's, the failed-start set on `RcMap`, one owner
  for a child's environment.** Already refused in
  `.agents/docs/refuted-candidates.json`; no new evidence.
