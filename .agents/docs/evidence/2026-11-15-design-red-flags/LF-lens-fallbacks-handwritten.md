Read at `cb22acd`. Lens over `packages/*/src`, plus `src/test-kernel` and `scripts/` for code that exists for tests: silent degradation, hand-written infrastructure, compatibility code, shared mutable state, unknown error channels.

# LF: fallbacks, hand-written infrastructure, compatibility code

How the lens was run: every bare `catch {`, `.catch(() =>`, `Effect.catch*` / `orElseSucceed` / `Effect.ignore` / `Effect.option` / `decodeUnknownOption` / `catchDecoding` site in `packages/*/src` was listed and each handler that succeeds with a default and has no log near it was read, minus the files round 7 already names; every module-level `let` and `new Map/Set/WeakMap`; every `setTimeout` / `setInterval` / `new Promise` / `.then(` outside the browser frontends; every line saying legacy, compat, deprecated, migrate, older build, alias; and an identifier index of every `export const|function|class` against production and test files.

### LF-1: A memory file with a broken header reads as a file with no header, and a pin then writes a second header above it

- **Package:** harness
- **Flags:** silent degradation; a comment that is false; repetition (absence and failure in one branch)
- **Evidence:**
  - `packages/harness/src/agent/memory/memoryMeta.ts:50-71`: `parseFrontmatter` returns `{ meta: null, content: raw }` for three different facts: no opening fence, an opening fence with no closing one (`split.kind !== 'ok'`, line 55), and a fenced block whose YAML or schema decode failed (`Result.isFailure(parsed)`, line 63). Its doc comment calls this "backward-compatible" (line 48).
  - `packages/harness/src/tools/memory/memoryFileSystem.ts:178-183`: `readMemoryMeta` wraps the call in `Effect.try({ try: () => parseFrontmatter(text).meta, catch: ensureError })`, and the comment above (lines 170-173) says "a head that does not parse ... warns with the cause". `parseFrontmatter` cannot throw, so that warning is never written for an unparseable head; the entry lists as unattributed with nothing logged.
  - `memoryFileSystem.ts:393-404,412-415`: `pinMemory` reads the file through `readMemoryFile` (`parseFrontmatter`), then `writePinned` calls `writeMemoryFile(storagePath, file.content, setPinnedMeta(file.meta, …))`. For a file whose header failed to decode, `file.content` is the whole raw text, header included, so the write puts a new header above the damaged one. This is the "defaulted read feeding a whole-file write" case of the review checklist §15.
  - `packages/harness/src/agent/prompt/templateInputs.ts:358`: the prompt builder injects `parseFrontmatter(raw).content`, so the damaged header text is sent to the model as memory content.
  - Consumers of `parseFrontmatter`: 5 production call sites in 2 files (`memoryFileSystem.ts:89,181,211`, `templateInputs.ts:358`, plus the `ReturnType` at `:396`). `memoryMeta.ts` is in open PR #14953; its version of `parseFrontmatter` is unchanged (checked with `git show origin/claude/optimistic-cori-q0n270:…`).
- **Better design:** `parseFrontmatter` returns a `Result`: `{ meta: null, content }` only for `no-opening-fence`; `no-closing-fence` and a failed decode are a failure carrying the rendered issue. `readMemoryMeta` logs that failure at `warn` (its comment becomes true and the `Effect.try` goes); `pinMemory` / `unpinMemory` fail with it instead of rewriting; the prompt builder and the preview keep the body and warn once.
- **Deleted:** the `Effect.try` wrapper around code that cannot throw; the "backward-compatible" branch that makes failure read as absence; the false sentence in the `readMemoryMeta` comment.
- **Size:** ~40 lines, 3 files.
- **Risk / owner decision:** owner decision on one point: whether a pin on a file with a damaged header is refused (proposed) or repairs the header by dropping it.

