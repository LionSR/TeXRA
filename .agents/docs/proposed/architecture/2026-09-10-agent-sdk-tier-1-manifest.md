# Agent SDK: the Tier-1 public manifest

Status: proposed

> **What this is.** The Tier-1 manifest that
> [`2026-09-05-agent-sdk-architecture.md`](./2026-09-05-agent-sdk-architecture.md)
> §4 names as a deliverable — the exact public surface of the SDK package and
> the ratification of what Tier-1 keeps, seals, or sheds. It is the
> enumeration-and-ratification half of the boundary work `AGENTS.md` names
> ("the Tier-1 public manifest and shrinking the frozen deep-import lists"); the
> frozen-list shrink rides the deep-import baseline. Still `proposed`: the
> ratification below is open, awaiting an owner.
>
> **2026-10-12 rework.** Two things invalidated the hand-maintained export
> inventory this note used to carry, and this rework removes it rather than
> re-pin it a fourth time:
>
> 1. **The package was renamed.** `@texra-ai/agent` / `packages/agent` is gone;
>    the SDK surface is now `@texra-ai/harness` / `packages/harness`, resolving
>    the open package-name question in
>    [`2026-10-02-durable-harness.md`](./2026-10-02-durable-harness.md) (Q5,
>    status: **accepted**). Every path, package name, and entry count in the
>    earlier revisions of this note was stale on its face.
> 2. **The deliverable pivoted.** Per that accepted note, the deliverable is a
>    general, Effect-native _durable harness_ whose SDK is its **extend**
>    surface (`Plugin`, `Sessions.layer({ plugins })`, `Plugins.contribute` in a
>    `Scope`, `Session.resume`) — not a frozen static-export list. The standing
>    readiness re-verification
>    ([`2026-10-17-agent-sdk-readiness-reverify.md`](./2026-10-17-agent-sdk-readiness-reverify.md),
>    §Carried.3) is the standing re-verification of that surface; this rework
>    re-scopes the manifest around the harness SDK rather than ratifying the old
>    static enumeration — which would pin deleted names (`ToolHost`,
>    `PlatformConflict`) and omit the extend surface (`Plugin`, `Composition`)
>    the pivot is built on.
>
> The earlier revisions re-enumerated the surface by hand four times
> (`cf88d2d`, then `697663eff1`, then the 2026-09-21 flip, then the
> 2026-09-23 `defineTool` change) and drifted each time. Hand-maintaining a
> list that `config/api-reports/` already regenerates is the exact
> "hand-written version of what the tooling provides" the design guardrails
> warn against, so §3 below no longer carries it: **the authoritative,
> non-drifting enumeration is the committed api-report snapshots**, and this
> note carries only the entries, what keeps the surface honest, and the open
> ratification questions.

## 1. The entries

`packages/harness/package.json` declares **four** subpath entries, all pure
Effect — no top-level Promise/AsyncIterable rendering and no `Effect.run*`
outside the carved runtime entries (the one internal `runFork` is
`processRuntime`'s fork-failure reporter, re-exported as
`withForkFailureReporting`):

| Entry                       | Subpath     | Shape                                                                                                                                                                   |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/harness`         | `.`         | The Effect services where the decisions are stated (`Sessions`/`Session`/`Run`), the tagged failures, the payloads, the platform ports, and the tool-definition helpers |
| `@texra-ai/harness/schemas` | `./schemas` | Zod schemas and their inferred types                                                                                                                                    |
| `@texra-ai/harness/plugins` | `./plugins` | The built-in plugins (`harnessBuiltins`) and the plugin-tool run services                                                                                               |
| `@texra-ai/harness/node`    | `./node`    | The ready-made Node platform (`nodePlatform`)                                                                                                                           |

The root entry **is** the Effect surface: the Promise/AsyncIterable rendering
and the `/effect` subpath were deleted in the 2026-09-21 flip (rulings ledger's
supersession of R1 boundary kind (c)); the scope owns each composition
(`Sessions.layer`), and `RunFailure` reaches the embedder as the typed error it
is. The **root entry** carries the extend contracts (`Plugin`, `Sessions.layer`)
the durable-harness pivot makes central; the `/plugins` entry provides the
built-in plugins (`harnessBuiltins`) and plugin-tool run services to compose
with them.

## 2. The enumeration lives in the api-reports, not here

The exact, current public surface of each entry is the committed snapshot under
`config/api-reports/`:

- `harness.api.md` (root), `harness.schemas.api.md`, `harness.plugins.api.md`,
  `harness.node.api.md`.

These are regenerated by the core-quality `--update` (CLAUDE.md "Core
quality"), so a surface change shows as a diff in review and the enumeration can
never silently drift from the code. Read those files for the live list of
exported names; do not re-transcribe them here.

## 3. What already keeps this surface honest

Enforced today at build time by `packages/harness/scripts/validate-artifacts.mjs`
(run by `npm run typecheck:harness`, i.e. `pnpm --filter @texra-ai/harness
build`). These are cited, not added — per CLAUDE.md the open work is this
manifest's ratification, "not another lint rule":

- **No provider-SDK type leak, per entry.** Each declared entry's `.d.ts`
  reachability graph is walked and rejected if it reaches `@anthropic-ai/sdk`,
  `@google/genai`, `@openrouter/sdk`, or `openai`. This is why
  `packages/harness/src/index.ts` sources `RunEndResult` from its own module
  rather than the `@agent/runtime` barrel.
- **No `vscode`, no extension-host paths** in any declaration.
- **No unresolved internal path alias** leaking into declarations.
- **No source or declaration maps** emitted; NodeNext relative specifiers must
  carry `.js`; ESM only; no undeclared bare-package imports.

The dead-export ratchet (`npm run check:dead-code-ratchet`, green) guarantees no
_internal_ dead export. It does not prove every public binding has a consumer:
the four entries are knip entry points (`knip.json`), so a public re-export with
no package-name importer still passes — `MapToolRegistry`, for instance, has no
`@texra-ai/harness` consumer yet satisfies the ratchet through its internal use.
Closing that gap is exactly what the shed audit in §5.2 is for.

The frozen deep-import list (`config/ratchets/harness-deep-import-baseline.json`,
renamed from `host-agent-import-baseline.json`) is the complementary artifact:
it freezes the internal-coupling width the hosts still reach around the public
surface. Shrinking it — by promoting a heavily-shared internal specifier to a
documented public re-export with its existing consumer, then deleting the stale
rows — is the "shrink the frozen lists" half of the boundary work, paired with
each ratification decision below. It only ever shrinks; never widen it.

## 4. Actual consumers

- **External (npm) consumers: none.** Publication is deliberately held until a
  named external consumer exists (CLAUDE.md "Layout"), so there is no installed
  base — exactly when the surface is cheapest to change.
- **In-repo consumers by package name: the hosts, extensively.** Since the
  rename and the harness-package-split, `extension`, `desktop`, `cli`, and
  `texra` import `@texra-ai/harness` (and `/schemas`, `/node`) directly by
  package name across dozens of files each at this pin — not only through the
  repo-root path aliases. They are the real dependency set a keep/shed decision
  must weigh. What they still reach _around_ the public surface by deep import
  (`@agent/*`, `@shared/*`, …) is the separate, frozen coupling in
  `harness-deep-import-baseline.json` (§3).
- **Consumer-shaped example: one.** `packages/harness/example/effectSession.ts`,
  installed from a packed tarball (the only code that installs the package as an
  external consumer would), exercises the root entry (`Sessions`,
  `session.start`, the tagged refusal), `/node` (`nodePlatform`), and `/plugins`.
- **Coverage note:** `/schemas` and `/plugins` are exercised — by the hosts and,
  for `/plugins`, by the example — so no entry is wholly unexercised.

## 5. Open ratification questions (owner-gated)

Each is design-gated and named by its owning doc, not settled by this inventory.
Re-scoped around the harness SDK per the pivot:

1. **The extend surface is the Tier-1 center.** `Plugin`, `Composition`,
   `Sessions.layer({ plugins })`, `Plugins.contribute`, `Session.resume`
   (durable-harness H4). Ratification should confirm these as the committed
   public contract and settle their shapes, rather than ratify the old
   static-export list.
2. **Shed candidates on the root entry.** `SettingHost` (TeXRA's internal host
   enum reaching the public tool-definition contract via `unavailableHosts`) and
   the `MapToolRegistry` / `IToolRegistry` registry plumbing that an embedder on
   the documented `StartInput.tools` / `defineTool` path never constructs. Both
   are candidates to seal or remove; trimming narrows the surface, never widens.
3. **The durable-storage failure plane.** `DatabaseOpenFailed`,
   `DatabaseReadFailed`, and the `SessionOpenError` union (from
   `@shared/session/database`) reach embedders typed. Whether SQLite-store
   open/read failures belong on Tier-1 is a ratification question.
4. **The approval / interaction channel — built; ratify its defaults.** The
   channel already exists: the root entry exports `ApprovalHandler`,
   `SessionHost`, `PendingRequest`, and `RequestDecision`, and an embedder
   installs its handler with `session.attach({ approve })` for a scope
   (`effect/sessions.ts`) — `OpenOptions` on `Sessions.open` carries only
   `persistent`, not the handler. Approval-gated tools are refused only when no
   attached host answers — which is why the headless Node default keeps the
   subagent boundary open. What is open is whether the headless default and that
   refusal behavior are the ratified contract, not whether the channel exists.
5. **The `AgentPlatform` roots coupling** (`effect/sessions.ts`; the interface
   now directly carries `roots` rather than `extends Platform`) that
   `2026-09-05` §4 proposes removing as consumers move to explicit sessions —
   carried, to re-evaluate against that current shape at ratification.
6. **The result-shape contract** as `packages/harness/README.md` writes it —
   `RunEndResult` with `usage` and one `output` shape
   `{ response, files, structured?, documents? }` (no `category` to switch on;
   `documents` only on a document task's run), plus an optional `error?` (a
   provider/runtime failure — a domain-`FAILED` outcome such as rejected
   document output can carry none). The declared shape moved since the
   2026-09-04 closure without this manifest's intent being re-stated;
   ratification should confirm or trim it.

Resolved by deletion, recorded for the audit trail only: `IModelHandler` /
`ModelHandler` (the god-base and port, deleted in #12320, no re-export shim) and
`AgentFinalResult` (type deleted) — both were once manifest-design notes and are
now moot.
