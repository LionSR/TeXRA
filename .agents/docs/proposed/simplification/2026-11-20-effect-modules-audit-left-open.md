# Hand-written code against Effect's modules: what the 2026-11-20 audit left

Date: 2026-11-20
Status: proposed

Origin: an audit of six areas against the modules of the installed Effect
(4.1.4): the MCP client and stream framing; the CLI's command framework; the
retry gate, stores, logging and the usage queue; third-party dependencies and
hand-written codecs; the harness runtime (tool dispatch, the run registry, the
model invoke loop, the run loop); and the app and host code (the service
client and session, the Lean server pool, the GitHub pollers, the chat
controller).

The areas are already on the Effect modules. These landed with this note:

- `--idle-timeout` and `history --limit` are `Flag.Int` with a lower bound,
  and `history show --export` is `Flag.Literals`, so shell completion offers
  `html` and `md`. A bad value is now effect/cli's own usage error. `Flag.Int`
  accepts any integer spelling (`1e3`), where the old pattern took digits
  only.
- `drain` in `packages/harness/src/utils/system/execUtils.ts` decodes through
  `Stream.decodeText`.
- `FollowUpReader` reads its closed state from its latch
  (`Latch.isOpen`) and keeps no second flag.
- The service's busy hold in `packages/texra/src/controllers/server/serve.ts`
  is a scoped `Stream.switchMap` over the session's view: the busy case
  acquires the count and the project's lease, and the switch closes them
  before the next state starts. The `let hold` scope and its two-state
  `follow` are gone.
- `texra --version` at the root is `texra version`, as `-v` already was, so
  both print the same and both honor `--output-format`.

- The stdio MCP client is effect/ai's `McpClient` on MCP 2025-11-25
  (`packages/harness/src/tools/mcp/mcpServer.ts`), and the JSON-RPC
  connection keeps only the Content-Length framing. A server on an older
  revision no longer starts; its failure says to update it. The official
  TypeScript SDK has answered 2025-11-25 since 1.25 (December 2025). The
  refusal `EFF-ADOPT-mcp-client` is deleted.

## Open

1. **Lean's stderr tail is cut by hand.**
   `packages/texra/src/tools/lean/direct/leanServer.ts` writes
   `(tail + chunk).slice(-LIMIT)`; the MCP server uses the harness's
   `appendTail`, which is not on a public entry. An export for one more
   caller is not a gain; it becomes one when a third appears.

## Checked and declined

### MCP, RPC and stream framing

- **`packages/harness/src/tools/jsonRpc.ts` onto `RpcClient` and
  `RpcSerialization`.** Effect has no Content-Length framing, which the Lean
  server speaks. `RpcClient` needs a static `RpcGroup`; MCP tool names and
  LSP methods are open strings, and the connection also answers the peer's
  requests and sends each protocol's cancel notification.
- **The service wire protocol and child-output line splitting** are already
  `RpcServer` / `RpcClient` over a socket with NDJSON, and
  `Stream.splitLines`.

### The CLI's command framework

- **Shell completions onto `Completions.generate`.** Effect's generators are
  static. Ours complete agent and model names by asking `texra`, and paths
  for flags that stay strings.
- **`TerminalCapabilities`.** One `canColor` from stdout; `resolveStreamColor`
  answers per stream, and stderr's answer is used by doctor and the progress
  renderer.
- **effect/cli's `Prompt` for `askCliQuestion`.** Its terminal writes to
  stdout. Ours asks on stderr so stdout stays parseable, and reads piped
  stdin.
- **`expandRootShortcuts`, the `--no-color` pre-scan, the chat's `/login`
  argument parse, and the scripts' `parseArgs`.** effect/cli has no rewrite
  from a flag to a subcommand; the presenter must exist before the parse that
  reads `--no-color`; the other two would gain a dependency or a help
  printer for no fewer lines.

### Retry gate, stores, logging, the usage queue

- **`JsonStore` onto `KeyValueStore.layerFileSystem`.** Effect's store is one
  file per key, written without a rename. `JsonStore` is one hand-edited JSON
  object with a synchronous read that follows the file, an atomic write and a
  read-modify-write under the file's lane.
- **`FileSecrets` onto the same.** It would lose owner-only modes, the
  staged rename and its Windows retry, the uninterruptible commit that
  announces the change, and the watch.
- **`AppState` onto `KeyValueStore`.** It needs a transactional update over
  several keys and a stream of changes.
- **`UserDirectories` for the home directory.** It reads `HOME` or
  `USERPROFILE` only; `os.homedir()` falls back to the passwd entry. TeXRA
  stores under `~/.texra`, not the XDG directories.
- **`UsageLogService` onto `Stream.groupedWithin` or `PersistedQueue`.** The
  sender keeps one failed batch with its id for the retry, reads consent at
  send time, and sends what is left exactly once on close. It is already
  `Queue`, `Schedule` and a finalizer.
- **The thread and upload caches in `packages/llm/src/api/` onto `Cache`.**
  One looks up by prefix and removes on read; the other takes its expiry
  from the provider's reply, is read synchronously, and deletes every upload
  under one deadline at close.
- **The update check's daily stamp onto `PersistedCache`.** It is a row in
  the SQLite store beside the last notified version; a second backing for
  one timestamp is a loss.
- **Host log sinks onto `Logger.toFile`.** Callers with no fiber write to the
  sink, and the desktop's file sink appends synchronously and rotates.
- **`packages/harness/src/logger/redaction.ts` onto `Redacted`.** `Redacted`
  wraps a value known to be secret; redaction scrubs free text for key
  shapes.
- **Timers in the terminal and web UI.** Signal, Lit and React state with no
  fiber.

### Third-party dependencies

A dependency goes only when every import site converts. None does.

- **`yaml`**: `effect/encoding` `Yaml` parses only. No `stringify`, no
  document API, and its header lists syntax it does not read.
- **`glob`**: `effect/Glob` matches a string; every site here walks a
  directory.
- **`tar`**: `effect/encoding` `Tar` neither touches the file system nor
  decompresses. The arXiv extraction needs both, with path checks on an
  untrusted archive.
- **`lru-cache`**: `Cache` is built and read in Effect, bounded by entry
  count. Six of eight sites are synchronous, one needs a size bound, the
  pollers copy the cache by value, and the two in Effect code are
  `Context.Reference` defaults.
- **`undici`**: Effect has no proxy policy; the model transport needs
  `EnvHttpProxyAgent`, header and body timeouts, and a `fetch` for the
  provider SDKs.
- **`ws`**: already wrapped in `Socket.fromWebSocket`. It stays for the
  failed handshake's status and request id, `ping` and `terminate`.
- **`diff`**: `TextDiff` has lines and a unified string, no structured hunks,
  no word diff and no timeout.
- **`mime-types`**: `effect/http` `Mime` knows standard types only. 799 of
  1239 extensions differ, the office formats among them.
- **`http-status-codes`**: `HttpStatus` maps a name to a code and has no
  reason phrase.
- **`ipaddr.js`**: `effect/net` has single predicates, no total range
  classification. The fetch tool's address check denies by default.
- **`pathe`, `write-file-atomic`, `which`, `content-disposition`**: `Path` is
  a service with no synchronous functions; `FileSystem` has no atomic write;
  Effect has no `PATH` lookup and no `Content-Disposition` parser.
- **`safe-stable-stringify`**: `Formatter.formatJson` does not sort keys, and
  `idHash.ts` hashes the output.
- **`pretty-ms`**: `Duration.format` has no unit count (`1h 1m` against
  `1h 1m 1s`).
- **`pretty-bytes`**: `ByteSize.format` converts the one import site, with
  two decimals where there were three significant digits (`953.67 MiB` for
  `954 MiB`), and it throws on a fraction. A changed wording for one
  dependency line.
- **Hand-written codecs**: none found. Base64 and hex are `Buffer` calls, the
  browser site already uses `effect/encoding`, and `SemVer` is adopted.

### The harness runtime

- **The run registry's entries as `FiberMap`.** The fibers already live in
  the session's `FiberMap`. The registry's map holds four entry kinds, three
  with no fiber. `awaitDrained` waits for one run id, which `awaitEmpty`
  cannot.
- **The `Deferred` on an ending or busy entry as a `Latch` or `Semaphore`.**
  A waiter reads the entry again afterwards; a semaphore would hand it the
  run.
- **`enter`'s fiber observer.** `leave` must run once the fiber has exited;
  `Effect.onExit` runs before.
- **The once-per-key memo and the fork-then-join in
  `packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`.** Each key
  brings its own effect with its own types, and `Fiber.join` does not
  interrupt what it joins.
- **`ModelInvoker`'s accumulator as `Stream.runFold`.** The failure path
  reads the partial text after the stream fails; a fold loses it.
- **`withPerKeyLane` as `PartitionedSemaphore`.** That shares one pool of
  permits across its partitions.
- **The inbox's observers as `PubSub`.** `onClosed` is a synchronous callback
  a plugin relies on for order.

### App and host code

- **The service client, service session, window calls and the session
  bridge** are already `RpcClient`, `RpcServer`, `Schedule`,
  `SubscriptionRef`, `Stream.switchMap`, `FiberHandle` and `RcMap`.
- **`Stream.paginate` for the check-run and annotation walks.** Each page
  carries an ETag cache, a re-read total and a budget claim; the walk is a
  fold over pages, not a cursor.
- **`effect/http` `Etag` for the pollers.** It generates tags for a server.
- **`Pool` or `ScopedCache` for the Lean servers.** The pool is keyed and
  held by run scope, with no idle timeout on purpose.
- **The connection scope in `linkService.connect`.** It outlives the call and
  is closed on loss; no handle carries the loss signal beside it.
