# `@texra-ai/agent`: the Step-3 npm package, measured

> **Status:** Proposal. Written 2026-07-27 from two studies at `origin/main` `b47c82afcc`:
> an **empirical package cut** (the candidate subset copied into a scratch tree and
> typechecked in isolation — every `TS2307` is a real boundary escape) and a
> **consumer-side spec** (entries, `package.json`, minimal program, API questions),
> grounded in the shipped `.d.ts` of `@anthropic-ai/claude-agent-sdk` and
> `@openai/codex-sdk`. Companion to
> [`2026-07-26-agent-sdk-foundation-gap.md`](./2026-07-26-agent-sdk-foundation-gap.md)
> and the plan of record
> [`2026-07-09-agent-sdk-north-star.md`](./2026-07-09-agent-sdk-north-star.md).
>
> **Gate status.** Step 3 was gated on "a real external consumer existing." The maintainer
> has posited that consumer (2026-07-27). The old "no `@texra/core` barrel" trap was
> explicitly conditioned on the import fence not yet enforcing; the fence has been enforcing
> since #7914 (three ratchet baselines live). The packaging question is **open**.

## 1. The empirical result: the cut succeeds, the layering work is done

The candidate set — `src/agent` minus reflection/agentCreator/6 product modules, plus
`platform`, `logger`, `model`, `transcript`, `utils`, `common`, the schema subset of
`shared`, and the generic tool subset — was copied into a scratch tree preserving layout
and typechecked in isolation (`types: ["node"]`, no `vscode`). Each round's selection
criteria:

- **Round 1 — prescribed seed only:** the exact candidate modules listed above, with no
  attempt to resolve import gaps. The 492 escapes represent the raw import surface.
- **Round 2 — absorb support, refuse latex+auth:** Round 1 plus any support files that
  resolve transitive import gaps (bridge modules, utility helpers, type re-exports),
  while intentionally excluding `@latex`, TeXRA-hosted credential-plane `@auth` modules,
  and their dependents as product-domain exclusions. The documented user-owned provider OAuth
  exceptions `@auth/codex/**` and `@auth/xai/**` are not TeXRA-hosted credential-plane modules. This is the "how big is the real graph" measurement.
- **Round 3** was an intermediate measurement that merged bridge files differently; it was
  superseded by Round 4 and is omitted.
- **Round 4 — SDK-shaped floor:** applies **principled exclusions** of product-domain
  modules (latex, TeXRA-hosted auth, replacement engine, reflection, controllers, telemetry)
  that an SDK consumer would not need. Fewer files than Round 2, but **more escapes** — Round 2
  pulled in bridge/support files to close import gaps, while Round 4 intentionally
  excludes those adapters and marks each product-domain dependency as a deliberate escape
  site that needs an architectural decision, not a transitive resolution. The 53 escapes
  are the honest floor: they are the set of places where product logic crosses into the
  core.

| Round                                 |   Files |         LoC | Escape sites |
| ------------------------------------- | ------: | ----------: | -----------: |
| 1 — prescribed seed only              |     267 |      61,023 |          492 |
| 2 — absorb support, refuse latex+auth |     719 |     138,942 |       **38** |
| 4 — SDK-shaped floor                  | **556** | **110,913** |       **53** |

Round 2 is the finding: **the entire 719-file set typechecks with 38 escapes. There is no
hidden web of breakage.** The years of layering work paid. What remains is not untangling;
it is **deciding where the product line falls** (§9 of the foundation-gap doc, confirmed).

**`vscode` imports across all 556 files: zero.** The repo's highest-signal rule holds
perfectly at package scale.

Judgment from the cut: **weeks** to an internal package a friendly consumer could use;
**months** to a credible public `npm publish` — and the months are _deciding_, not
_untangling_. The 38 escape sites in Round 2 are not 38 independent fixes; they cluster
into the **5 categories** listed in §2 (tool registry cycle, credential plane, replacement
engine, library build, and ~32 small product edges). Each category is one behavioral ruling
plus mechanical follow-through — the blockers are few, and none require deep refactoring.
The "weeks → internal" path needs only B4 (build toolchain) plus enough of B1-B3 to run
under a friendly consumer's own key; the "months → public" path needs all five blockers
resolved plus declaration-emit hardening, and the months are consumed by _deciding_ the
product-line rulings in §8, not by writing code.

## 2. Five blockers, ranked (the compiler's list, not an estimate)

### B1. The tool registry is closed _and_ cyclic — one problem, not two

> **Corrected 2026-07-27 (issue-filing re-census at `ee08bb9c24`).** The cut experiment's
> "byte-identical for all 54 tools: 654 files" does **not** reproduce. Measured over all 50
> `defineTool()` modules: **19 share one identical 630-file closure** (these include `bash`
> and the delegation tools — the ones an embedder wants most); the other **31 cap at ~150
> files with zero LaTeX/Lean/arxiv/Zotero** (`ReadTool` 122, `grep` 120, `glob` 119). The
> problem is real but narrower and more tractable than first stated. Cycle line numbers
> below are each off by one at HEAD (`bash.ts:68`, …); the corrected table lives in #9327.

The cycle:
`bash.ts → childStream.ts → AgentRunLifecycle.ts → AgentLaunchContext.ts →
agentLoad.ts → @tools/registry → ArxivDownloadTool.ts → @latex/arxivProcessor` —
already documented in-code at `subagentExecution.ts:41-46` and worked around with lazy
imports. **Every consumer of `bash` still installs LaTeX, Lean, Zotero and arxiv** (bash is
in the 19). Opening the registry (§5b) without severing the cycle changes nothing about the
install.

The split itself is clean: **20 generic tools (18,649 LoC) vs 34 domain tools
(14,834 LoC)**, connected only through `registry.ts`, `externalToolDefs.ts` (5 edges), and
`PlanTool.ts:46 → @tools/goal`.

### B2. The TeXRA-hosted credential plane — historical `@auth` × 13 census, including the `ModelHandler` base class

The historical census used `@auth` as shorthand for the credential-plane problem; it was not
a broad zero-`@auth` policy. `@auth/codex/**` and `@auth/xai/**` are explicitly permitted
because their current provider trees are user-owned OAuth backed by `platform().secrets`, with no
TeXRA-hosted relay or Supabase dependency. The root-aware model/runtime test enforces only their
consumer roots; retain that provider-tree property by review. All other `@auth/*` roots in the
model/runtime boundary are forbidden unless policy and the architecture-test allowlist are
deliberately updated.

`serverKeys` ×6, `codex` ×4, `SupabaseClient` ×2 — one of them in `ModelHandler.ts:59-61`.
TeXRA's subscription relay is welded into the model layer; **an external consumer has no
seam to supply their own key.** Related ruling (§8): with a state store present, included
relay access defaults **on** (`ServerSideKeyService.ts:106-108`), so an SDK run would
silently `fetch` remote.texra.ai. v0 must be BYOK-by-default.

### B3. `@replacement/engine` × 14 — a correction to this program's own premise

> _Counts corrected 2026-07-27: 14 sites repo-wide (12 in-candidate), in 7 model handlers
> plus 2 support modules under `modelHandlers/` — not "all 9 handlers" as first stated. The
> hot-path call is confirmed at `modelHandlerAnthropic.ts:1224` inside `extractResponse`
> (`:1194`)._

The model handlers import the replacement engine inside `extractResponse`
(`modelHandlerAnthropic.ts:46`, `modelHandlerGoogleGenAI.ts:39`, `modelHandlerOpenAI.ts:36`, …),
plus `TextEditorTool` and `WriteTool`. And `ResponseCycleFlow.ts:25` imports
`bestConnectionMethod` from `@agent/runtime/textConnection` — core's response cycle calls a
helper LLM whose prompt asks which string is "more english and latex grammatically
correct."

**The tool-use runtime is `@latex`-_import_-free but not LaTeX-_behavior_-free.** The
foundation-gap doc's boundary claim was about imports and holds; the behavior rides a
different alias (`@replacement`), on the hot path of every provider response. Making it
conditional (or host-injected) is a **behavior ruling**, not a move.

### B4. No library build exists

`declaration`/`emitDeclarationOnly` appear **0 times across all 11 tsconfigs**; no
tsup/api-extractor/dts tooling anywhere; every artifact is an app bundle. Required: per
entry, an esbuild ESM bundle with deps external **plus** `tsc --emitDeclarationOnly` under
a new `tsconfig.build.json` (`module: nodenext`; drop `"vscode"` from `types` so a leak is
a compile error) plus a post-emit alias rewrite (below).

> **Corrected 2026-07-27 — the declaration-emit spike ran, and B4 is confirmed the
> cheapest blocker, with two changes to the prescription:**
>
> - **The feared TS4023/TS2742 class does not exist.** A control emit over all of real
>   `src/` produced exactly two declaration-specific classes: **TS4094 × 55** (one root
>   cause — `defineTool` returns an _anonymous_ abstract class whose `execute` is
>   `protected abstract`, which a `.d.ts` cannot express; fix is either
>   `protected` → public across 33 files or annotating `defineTool`'s return type) and
>   **TS2883 × 1** (the FontAwesome leak already slated for deletion). Two mechanical fix
>   rounds (~57 lines / ~41 files) return emit to the `--noEmit` baseline: **declaration
>   emit adds zero residual errors.**
> - **Strike "flat d.ts rollup" — it is neither necessary nor currently possible.** Both
>   candidate tools fail on TypeScript 6.0.3 (`dts-bundle-generator` crashes;
>   `api-extractor` bundles TS 5.9 and internal-errors). The working replacement is a
>   **~40-line post-emit alias→relative rewrite** — 716 alias specifiers survive verbatim
>   across 308 emitted files, the rewrite resolves 734/735, and a consumer `tsc` compiles
>   exit 0. Gotcha: it must handle `import('@alias/x')` _type_ syntax, not just
>   `from '@alias/x'`.
> - **Prerequisite:** 23 dynamic-`import()` specifiers across 7 files need `.js`
>   extensions under `nodenext` (this is the whole nodenext delta; includes
>   `ModelFactory`'s 16-handler switch and the documented B1 lazy import).
> - Survival verified with negative controls: zod v4 generics, the provider-SDK type
>   re-exports, and all 20 `AgentEvent` union members emit intact. New trap:
>   `@openrouter/sdk/models` resolves only via a repo `paths` alias pointing _into_
>   `node_modules` — a consumer has no such mapping; needs a fix before publish. Full
>   emit: **~4 s** — fits existing CI shards, no separate job.

**Two latent production bugs found here:** `nunjucks` and `semver` are `devDependencies`
imported by production code (`agentTemplateRenderer.ts:1`, `utils/prompt.ts:3`,
`semverUpdateCheck.ts:1`) — masked today because apps bundle; fatal for a published
library. And two `import type { TeXRAIconName }` lines (`agentPresets.ts:12`,
`todoDisplay.ts:1`) are the sole reason **Lit + ~200 FontAwesome modules** sit in the
schema layer's type graph.

### B5. The product line — 32 individually-small edges

The remaining product-into-core escapes: `@tools/goal` ×4 (incl. `ToolUseWaitNode.ts:15`
and `features.ts:4`), `nodeHost.ts:24-26` (the **platform default host** registers a Lean
language server and skills), reflection at `executeAgent.ts:11`, helper-model product on
`runAgent.ts:14`, `@agent/remote` ×2, `@telemetry` ×2, `externalToolDefs.ts` ×5. Each is
small; collectively they are the decision surface.

## 3. The package

**Name: `@texra-ai/agent`** — the scope is owned and published (`@texra-ai/cli`);
`@texra/*` is the private-workspace convention; `core` is burned (CLAUDE.md disclaims it,
and `packages/core/` existed as a stale directory from a prior attempt — it was removed
before this proposal was written). Version lockstep with the workspace.

**Three entries, no more:**

| Entry             | Consumer imports                                                                | Why it cannot fold                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/agent` | `runAgent`, run handle, `AgentEvent`, `HostInteractions`, `defineTool`, `ITool` | the run surface; must stay `node:`-free (currently `RunContext.ts` imports `node:async_hooks`, and `executeAgent.ts`/`AgentLaunchContext.ts` import `node:path` — these must move behind platform ports or into `/node` before publish) |
| `/schemas`        | `AgentConfigSchema`, `AgentDefinitionSchema`, ids, result schemas               | **Zod values** consumers `.parse()`/`.extend()`; the only browser-safe entry. Must be a **named subset** — the in-repo barrel re-exports webview wire contracts that are not SDK API                                                    |
| `/node`           | `nodePlatform({...})`                                                           | node defaults would drag `node:fs`/`proper-lockfile` into every consumer if folded                                                                                                                                                      |

**Dependency ruling:** `zod` is a **peerDependency** — Zod values cross the boundary in
three places (`AgentConfigSchema`, `AgentDefinitionSchema`, `defineTool`), and two zod
realizations break `.extend()` and the `instanceof` in `toToolParameters`
(`define.ts:14-19`). Provider SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`,
`@openrouter/sdk`) are regular **dependencies** — `ModelFactory` dynamic-imports them from
a hardcoded switch (missing peer = crash, not degradation), and their types are already on
the public surface via `ResponseUsage.ts:2,6-9`. MCP SDK, claude-agent-sdk, codex-sdk:
omitted from v0. Measured bill for the floor set: **65 npm packages** — including
surprises (`pdf2pic`, `postal-mime`, a QuickJS wasm sandbox) that argue for further
trimming. Unlike `@texra-ai/cli` (an app that bundles everything and ships 2 deps), a
**library must external its entire dep set** or consumers get two zods and two openai
clients.

## 4. The consumer program

**Before** (against today's main, re-measured): 13 imports · 7 statements before
`runAgent` · 3 hand-authored port literals · **3 ordered globals** (down from 6 — #9228,
#9234, #9273 landed the reductions) · ~40 lines.

**After:**

```ts
import { runAgent } from '@texra-ai/agent';
import { nodePlatform } from '@texra-ai/agent/node';

const run = runAgent({
  platform: nodePlatform({ agentsDir: '/abs/agents' }),
  agent: 'my-agent',
  instruction: 'Hello',
  interactions: { cancel: () => {} },
});
for await (const event of run) console.log(event.type);
console.log((await run.result).lastResponse);
```

`run` is `AgentRunHandle` (`ExecutionHandle.ts:328-342`), which already exists with the 12
members needed. **No `Session` class, no `on()`/`emit()`** — Anthropic built
`unstable_v2_createSession`/`SDKSession`, shipped it, and deleted it in 0.3.142; that
experiment has been run. The `for await` adapter over `AgentTraceSubscriber` is ~60 LoC
yielding `AgentEvent` verbatim — zero new vocabulary.

**How the adapter resolves the async gap.** Today `runAgent` returns
`Promise<AgentFlowResult>`, but the sample above calls it synchronously. The adapter
constructs an `AgentRunHandle` (a deferred facade exposing the 12 existing members) before
the underlying `runFlowWithLifecycle` completes; the `for await` loop pulls from the
trace subscriber's event stream, and `await run.result` resolves when the run finishes.
This pattern is standard for SDK surfaces (both Claude Agent SDK and Codex SDK return an
iterable handle, not a bare promise) and does not require refactoring the internal
lifecycle — only a thin entry-point wrapper.

Of the 13-item backlog between before and after, **only two are blocking**: the
unattached-interaction ruling (#9256's recommendation stands — reuse the CLI's
non-interactive policy shape, `approvalPolicyAvailability.ts:8-14`) and the `runtimeHost`
deletion (§7.1 migration step 5; re-priced 2026-07-27 to 531 refs / 120 files total —
#9251, #9272 and #9140 already shaved it). Everything else is
mechanical or already landed.

## 5. The three API rulings

**5a. Definitions-as-values: add an `'inline'` `AgentSource`; do not build an options
API.** The value-injection seam already ships in production — the Supabase remote catalog
fabricates `AgentEntry` with `path: ''` (`remoteAgentMeta.ts:57-66`) and skips the YAML
load in the `agentLoad.ts:118-126` source switch. Add an `'inline'` arm to `AGENT_SOURCE`
and a packaged `agents?: Record<string, Omit<AgentDefinition,'name'>>` normalized once at
the entry into the same two parts. New ports: 0. New schemas: 0. Trap: do **not** hang a
definitions bag off `RunAgentOptions` — the registry is process-global and resolution is a
sync read; a per-run bag forks the lookup. Ruling needed: `AgentSource` is persisted, so
the enum widening needs a read-compat check.

**5b. Tools: grow the existing overlay from 1 to N; do not add `register()`.**
`runToolUseFlow(input, toolRegistry?, …)` already has an unused per-run registry seam
(both production callers pass `undefined`), and `buildTerminalToolRegistry`
(`structuredOutput.ts:227-236`) already composes one runtime-constructed tool onto the
default registry per-run without mutation, applied at `runToolUseFlow.ts:216-224`.
Generalize that block to `tools?: readonly ITool[]` on `ExecuteAgentOptions`: **≈ +40
LoC**. `defineTool` (1 Zod schema + 1 method) is already the authoring surface. Two
rulings: SDK tools append unconditionally (like `submit_output`), and v0 injection is
tool-use-only (reflection hardcodes the default registry). This does not by itself fix B1
— the cycle severing is separate and prior.

**5c. Model handlers: v0 exports nothing, and packaging does not force the split.**
`IModelHandler` is 44 members (`src/agent/types/IModelHandler.ts:35-112`) and **42 of 43
picked members are called from core or the flows** — the "10-12-member invocation
contract" does not exist to be split out; reaching it means redesigning the flow↔provider
boundary, the measured net-add class. Neither reference SDK exports a model abstraction;
both take `model?: string`. So does v0. The narrowing pattern for later exists
(`followUpMessages.ts:16-19` narrows to 3 members per-boundary). One forced decision:
`ProviderUsage` reaches public types and drags 5 provider-SDK type imports — keep the SDKs
as dependencies (recommended) or narrow to `RunUsageTotals` (cleaner; type-surface change).

## 6. What v0 does not include

Reflection/workflow flow (v0 is `toolUse` only — `WorkflowFlowResult.compileFailures` is a
LaTeX field on the result, and reflection hardcodes the registry) · LaTeX tools and the
`toolConfig` booleans (schema accepted, never mentioned) · `packages/extension/resources`
(consumers pass `agentsDir` or inline agents; empty-`builtIn()` is already legal) ·
Supabase remote catalog (its _mechanism_ is reused by 5a; its network path is not shipped)
· `src/controllers/` (reached **zero** times from the candidate set) · relay/included
access and usage logging · `preferHelperModel`.

## 7. Sequenced plan

1. **Now, independent of any ruling:** fix the two devDep bugs (`nunjucks`, `semver` →
   dependencies); replace the two `TeXRAIconName` type imports with a local union (drops
   Lit + FontAwesome from the schema graph).
2. **The two blocking rulings:** unattached-interaction policy (#9256 shape) and the
   `runtimeHost` deletion (§7.1 step 5).
3. **B1:** sever the registry cycle (lazy edges already prototyped in-code), then 5b.
4. **B2:** seam the credential plane out of `ModelHandler` (BYOK default per §8).
5. **B3 ruling:** make replacement-engine processing conditional/host-supplied.
6. **B4:** `tsconfig.build.json` + declaration emit + flat rollup; the three entry files
   in `packages/agent/` (imported by nothing in-repo — hosts keep deep imports; ratchet
   baselines unchanged).
7. Internal consumer (the CLI or a scratch harness) installs the tarball; the embedder
   smoke test becomes real.

## 8. Decisions for the maintainer

| #   | Decision                                                                                                      | Recommendation                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | BYOK-by-default for the package (included relay access currently defaults on with a state store)              | yes — off unless explicitly enabled                                                       |
| 2   | `zod` peer / provider SDKs dependencies                                                                       | as specified in §3                                                                        |
| 3   | Replacement-engine processing on provider responses (B3) — always-on TeXRA behavior, or host-supplied?        | host-supplied post-processor defaulting to identity in the package, TeXRA injects its own |
| 4   | The product line for the 32 §B5 edges (goal tools in core flows, Lean in nodeHost, telemetry in UsageMonitor) | resolve per-edge during step 3-5; none is architecturally hard                            |
| 5   | `AgentSource` enum widening (persisted)                                                                       | proceed with read-compat check                                                            |

**Honest ceiling, restated:** v0 is _teachable and installable_, not _decoupled_ — B3 and
the `updateCompileFailures` trace arm mean LaTeX behavior still ships inside the package
until their rulings land. The compiler says the distance is weeks-to-internal,
months-to-public, and the months are decisions, not code.
