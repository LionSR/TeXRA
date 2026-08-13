# Host-neutral settings catalog → unified `/config` (CLI) + extension settings

> **Status:** Open proposal (2026-07-04 status sweep). The settings-catalog
> unification remains a design/implementation plan; re-verify cited settings
> paths before implementation.

## Context

The user wants a `/config` panel in the `texra` CLI TUI to toggle settings, but flagged the deeper risk: a CLI-only settings surface would **overlap with and drift from** the VS Code extension's settings. Research confirms both the concern and an existing foundation to build on:

- `src/shared/schemas/coreSettings.ts` is already a host-neutral SSOT for **config-tree settings** (Zod v4 `CoreSettingsShape` + `DEFAULT_CORE_SETTINGS` + `CORE_SETTING_PATHS`, all via `.prefault()`). It already generates the VS Code `contributes.configuration` block in `packages/extension/package.json` through `texraSettings.ts` + `scripts/sync-settings-configuration.mjs`, guarded by an idempotency test (`settingsConfiguration.vitest.ts:151`).
- **Gap 1:** `description` / `enumDescriptions` / `scope` / `order` are hand-written in package.json only — no SSOT, so the CLI can't reuse them and they can drift from the schema.
- **Gap 2:** ~74 **state-backed** settings (WorkspaceState/GlobalState keys: streaming, endpoints, codex/claude, agents, git, workflow, latexdiff…) live entirely outside the schema, in `src/shared/state/stateKeys.ts` + scattered getters + the `src/controllers/settingsView/*` controllers.

Decision (already made by the user): **full unification** — one catalog as SSOT feeding package.json, the extension settingsView, and the new CLI `/config`, staged as independently-mergeable PRs.

### Two corrections this refinement makes to the draft

Exploration disproved two load-bearing assumptions in the draft. Both change the design:

1. **State-backed keys must NOT become `CoreSettingsShape` nodes.** Every node in `CoreSettingsShape` flows into `CORE_SETTING_PATHS` → `TEXRA_SETTING_PATHS` → the package.json generator → a VS Code _configuration_ contribution. But the extension reads the state-backed keys (e.g. `texra.git.markCommits`, `texra.workflow.*`, `texra.latexdiff.*`) from **worktree-shared WorkspaceState** (`WORKTREE_SHARED_KEYS` in `packages/extension/src/common/state/stateManager.ts`), not from config — they were deliberately migrated _out_ of config (`LATEX_SETTINGS_MIGRATED` marker). Adding them to `CoreSettingsShape` would emit phantom VS Code settings the extension never reads. → They live in a **separate** catalog (`stateSettings.ts`), not coreSettings.

2. **The CLI has three distinct stores, not a single shared one.** `packages/cli/src/runtime/initPlatform.ts:193-200` wires `config` = `JsonConfigProvider` (`.texra/config.json` + `~/.texra/.../config.json`), but `workspaceState` / `globalState` = **separate** `state.json` files (`cliStateStores.ts`). The git-author bridge (`gitAuthor.ts`) works only because it _explicitly_ passes `config` into `readGitAuthorSettingsFromState(stateStore)` — exploiting structural read-compat (`ConfigProvider` and `StateStore` both expose `.get(key, default)`), **not** because `workspaceState === config`. So the accessor must be **host-aware**, and the git-author keys need an explicit per-entry `cliStore` override, not an assumed slot identity.

## Catalog & store model

```
        SOURCES (SSOT)                         CONSUMERS
  ┌───────────────────────────┐
  │ coreSettings.ts           │   .meta()/    ┌─────────────────────────────┐
  │  CoreSettingsShape nodes  │──.describe()─▶│ package.json generator      │
  │  (genuine config settings)│               │ (texraSettings.ts allowlist)│
  └───────────────────────────┘               └─────────────────────────────┘
              │                                ┌─────────────────────────────┐
              │  paths                         │ knownKeys.ts (CLI)          │
              ├───────────────────────────────▶│  derive whitelist; delete   │
              │                                │  hand-listed GIT_* lines    │
  ┌───────────────────────────┐               └─────────────────────────────┘
  │ stateSettings.ts (NEW)    │  rows         ┌─────────────────────────────┐
  │  metadata-only catalog for│──────────────▶│ settingsAccess.ts (NEW)     │
  │  state-backed keys:       │               │  read/write(entry, stores)  │
  │   store, cliStore?, hosts,│               │  host-aware store dispatch  │
  │   cliConsumer?, openForm? │               └───────────┬─────────────────┘
  └───────────────────────────┘                           │
                                              ┌────────────┴───────────────┐
                                              ▼                            ▼
                                  ┌────────────────────────┐  ┌────────────────────────┐
                                  │ CLI /config ConfigForm │  │ extension settingsView │
                                  │ (PR3, hosts⊇['cli'])   │  │ tabs (PR4, re-point)   │
                                  └────────────────────────┘  └────────────────────────┘

  Store dispatch (per host) — entry.store is the canonical/extension store:
    config         → extension: ConfigProvider(settings.json) | CLI: platform().config(.texra/config.json)
    workspaceState → extension: Memento (worktree-shared)     | CLI: platform().workspaceState(state.json)
    globalState    → extension: Memento (global)              | CLI: platform().globalState(state.json)
  Exception captured explicitly: git-author keys → store:'workspaceState', cliStore:'config'
    (CLI consumer gitAuthor.ts reads them from .texra/config.json, as it does today).
```

### Metadata centralization (what moves into the schema)

Promote only the fields with real cross-host SSOT value into `.describe()` / `.meta()`:

- **`description`** → owned by `.describe()` on every config leaf. Feeds both package.json and `/config`.
- **`enumDescriptions`** → `.meta({ enumDescriptions: [...] })` on the handful of enum config leaves; feeds the inner value picker's per-option text.
- **Keep hand-maintained in package.json (NOT allowlisted, so they survive untouched):** `scope`, `order`, `markdownDescription`, `editPresentation`. These are VS-Code-presentation-only (the CLI doesn't use them), so centralizing them adds churn/risk for no CLI benefit. Leaving them non-allowlisted also gives the "preserve non-generated field" test a real field to assert.
- `default` stays derived from `.prefault()` (never re-typed). Abstract project/global scope for `/config` write-target derives from `entry.store` (config/workspaceState→project-ish; globalState→global); config writes default to the `'workspace'` target (today's `config.update` default), matching the existing CLI git-author behavior.

### `SettingMeta` (the `.meta()` payload + `stateSettings.ts` row shape)

- Generator-facing (only on coreSettings/vscodeSettings nodes): `enumDescriptions?`.
- Catalog-facing (on `stateSettings.ts` rows; `description` via `.describe()` there too): `store: 'config'|'workspaceState'|'globalState'`, `cliStore?: same` (override when the CLI consumer reads a different slot — git-author only), `category`, `hosts: ('vscode'|'cli'|'desktop')[]`, `cliConsumer?` (**required when `hosts` includes `'cli'`**), `openForm?` (delegates to an existing list form instead of the scalar accessor).

## PR sequence

### PR 1 — Generator carries `description` + `enumDescriptions` (no behavior change)

- `texraSettings.ts:97` — extend `GENERATED_PACKAGE_SCHEMA_FIELDS` with `'description'`, `'enumDescriptions'` only. (`z.toJSONSchema()` already passes `.describe()` → `description` and merges `.meta()` keys; `pickPackageSchemaFields` is allowlist-driven so other meta stays out of package.json.)
- `coreSettings.ts` + `vscodeSettings.ts` — add `.describe('…')` to every config leaf and `.meta({ enumDescriptions: [...] })` to enum leaves, **back-filled verbatim from the current package.json strings** so the first generator run is zero-diff.
- `settingsConfiguration.vitest.ts` — **rewrite the `removes stale generated package schema fields` test (lines 157-180)**: it currently injects `description: 'Preserved description'` and asserts it survives. Once `description` is generated, that assertion is wrong — pivot it to a still-hand-kept field (`order` or `editPresentation`). Add an invariant: every enum leaf's `enumDescriptions.length === enum.length`.
- Regenerate package.json via `npm run sync:settings-configuration`.
- **Verify:** `sync:settings-configuration --check` is zero-diff; `npm test` (idempotency `assert.deepEqual(build(sections), sections)`) green; `npm run typecheck`.

### PR 2 — `stateSettings.ts` catalog + `settingsAccess.ts` accessor + knownKeys derivation

- New `src/shared/schemas/stateSettings.ts` — metadata-only rows for the state-backed keys, starting with the four git-author keys (`store:'workspaceState'`, `cliStore:'config'`, `hosts:['vscode','cli','desktop']`, `cliConsumer:'packages/cli/src/runtime/gitAuthor.ts'`) and the `workflow.*` / `latexdiff.*` / `latex.formatter` scalars (`store:'workspaceState'`, `hosts:['vscode','desktop']` for now). Export the key list.
- New `src/shared/config/settingsAccess.ts` — `readSetting(entry, stores)` / `writeSetting(entry, value, stores)` where `stores = { config, workspaceState, globalState }`. Dispatch on `entry.store` (or `entry.cliStore` when the caller is the CLI); validate writes via the entry's Zod schema where one exists; **reset writes `undefined`** (deletes the key per `jsonConfigProvider.ts:57` → `.prefault()` reappears), never the literal default. `openForm` entries bypass the accessor.
- `packages/cli/src/schemas/knownKeys.ts` — add `...STATE_SETTING_KEYS` from the catalog; **delete** the four hand-listed `WorkspaceStateKey.GIT_*` lines (31-34). The `WorkspaceStateKey` enum entries stay (the extension still uses them).
- **Guardrail Vitest suite:** every `hosts:['cli']` entry has an existing `cliConsumer` file; `KNOWN_TEXRA_KEYS ⊇` catalog CLI keys; no `globalState`+project-scope incoherence; Class-D markers (`*_MIGRATED`/`*_VERSION`/onboarding/history/cache) absent from the catalog; each entry's `.prefault()` default equals the real getter default (import the shared default consts — `DEFAULT_GIT_MARK_COMMITS`, etc.).
- **Verify:** `npm test` (guardrails) + `npm run typecheck`; `gitAuthor.ts` still applies marking (route it through the accessor or leave as-is — both read the same keys from `config`).

### PR 3 — CLI `/config` panel (USER-VISIBLE; lands in CHANGELOG under Features)

- New `packages/cli/src/chat/tui/forms/ConfigForm.tsx`. **Not a single-Select clone of `ApprovalPolicyForm`** — it is a list + drill-in:
  - Outer `Select` lists catalog entries where `hosts.includes('cli')` (label = setting name, `description` = current resolved value + its store, so cross-host state is visible — risk #1 mitigation).
  - Selecting a **boolean** toggles inline; an **enum** opens an inner `Select` of values (per-option text from `enumDescriptions`); an **`openForm`** entry delegates to the existing `ModelListForm`/`AgentListForm`/`MemoryListForm`/etc.
  - **MVP scope:** booleans + enums + `openForm` delegations. Defer free-text string/number editing (show read-only for now). Reuse `ui/Select.tsx`, `forms/_shared/{FormFrame,selectWindow}.ts`, and the `MemoryListForm` outer-list shape.
- Read/write through `settingsAccess.ts` with CLI-resolved stores (`platform().config` / `platform().workspaceState` / `platform().globalState`), honoring `cliStore`.
- Register in `commands/registerBuiltins.tsx` (add a `ConfigFormAdapter` + a `getConfigStores`/read-write option, mirroring the `getApprovalPolicy`/`onApprovalPolicySelect` pattern and `runFormSelection`) and `commands/slashRegistry.ts`. Wire the option at the `runChatTui.tsx:516` call site; the harness call site (`tui-harness.tsx:1566`) too.
- **Initial roster:** genuine config scalars with a verified CLI consumer + the git-author keys (`cliStore:'config'`). Exclude everything in "Exclusions" below.
- **Verify:** roster test = exactly the consumer-verified entries; `SlashRegistry.vitest` covers the new command; manual PTY run via `packages/cli/scripts/tui-harness.tsx` — open `/config`, flip a boolean + an enum, confirm persistence to `.texra/config.json` (project) and that `Esc` closes; confirm the headless `texra run` / `--print` path is byte-unchanged.

### PR 4 — Extension settingsView re-point (zero message/port/dispatch change)

- Delete the hardcoded enum/label arrays and read labels/descriptions from the catalog: `AIAgentsTab.ts` (SANDBOX/REASONING/APPROVAL/CLAUDE option arrays, ~lines 40-98), `LaTeXTab.ts` (mathMarkup + formatter options, ~lines 590-616), plus inline labels in `ModelSelectionList.ts` (reasoning-level labels) and `ApiAccessSection.ts`/`ModelsTab.ts`. Splittable per-tab. (Note: the codex/claude option arrays are state-backed complex domains — promoting them to catalog rows is fine for _labels_; their read/write stays in the existing controllers.)
- **Verify:** webview renders identical labels; no port/schema diff; `npm run typecheck` + `npm test`.

### PR 5+ — Promote complex/state-backed domains incrementally (one per PR)

- Add the CLI consumer code path for a domain (e.g. workflow/latexdiff scalars read in CLI from `platform().workspaceState`), flip its catalog `hosts` to include `'cli'`; the entry auto-appears in `/config`, and the PR2 guardrail enforces the consumer exists. Complex domains (streaming/endpoints/models/agents/tools/presets) come in as `openForm` delegations, not scalars.

## Critical files

- `src/shared/schemas/coreSettings.ts` — `.describe()`/`.meta({enumDescriptions})` back-fill (PR1).
- `packages/extension/src/schemas/{texraSettings.ts,vscodeSettings.ts}` — allowlist +`description`/`enumDescriptions`; describe the 3 vscode leaves (PR1).
- `src/test-kernel/shared/settingsConfiguration.vitest.ts` — rewrite preserve-field test + enum-length invariant (PR1).
- New `src/shared/schemas/stateSettings.ts`, `src/shared/config/settingsAccess.ts` (PR2).
- `packages/cli/src/schemas/knownKeys.ts` — derive from catalog, delete GIT\_\* lines 31-34 (PR2).
- New `packages/cli/src/chat/tui/forms/ConfigForm.tsx`; `packages/cli/src/chat/tui/commands/{registerBuiltins.tsx,slashRegistry.ts}`; `packages/cli/src/chat/tui/runChatTui.tsx:516` (PR3).
- Extension tabs: `packages/extension/src/settingsView/frontend/tabs/{AIAgentsTab.ts,LaTeXTab.ts,ModelsTab.ts}` + `components/profile/{ModelSelectionList.ts,ApiAccessSection.ts}` (PR4).
- Reused untouched: `ui/Select.tsx`, `forms/_shared/{FormFrame,selectWindow}.ts`, `src/controllers/settingsView/*`, `scripts/sync-settings-configuration.mjs`, `src/utils/system/gitAuthorSettings.ts`.

## Verification (every PR)

- `npm run typecheck` and `npm test`.
- PR1: `npm run sync:settings-configuration --check` zero-diff (proves `.describe()`/`.meta()`+`.prefault()` compose through `z.toJSONSchema()`); enum-length invariant green.
- PR2: guardrail suite (consumer-exists, knownKeys-derivation, store/scope coherence, Class-D exclusion, default round-trip).
- PR3: PTY harness round-trip — boolean + enum flip persists to `.texra/config.json`; `Esc` closes; headless `--print`/`run` path byte-identical (CLAUDE.md "headless parity is sacred").
- PR4: identical webview labels; no port/schema diff.

## Risk register

1. **Cross-host store divergence** (a key set in extension WorkspaceState reads as default in the CLI). Mitigate: store/cliStore coherence guardrail; `/config` shows the resolved value **and its store**; no silent auto-bridge beyond the declared `cliStore` override.
2. **`description` promotion breaks the existing preserve-field test** (`settingsConfiguration.vitest.ts:157-180` asserts a hand-injected description survives). Mitigate: rewrite that test in PR1 to assert a still-hand-kept field (`order`/`editPresentation`).
3. **Incomplete `.describe()` back-fill deletes package.json descriptions** (allowlisted + absent in `.meta`/`.describe` ⇒ generator deletes the field). Mitigate: back-fill every config leaf; the idempotency `--check` fails CI on any miss.
4. **`update(key, undefined)` deletes the key** (`jsonConfigProvider.ts:57`) ⇒ reset == default-by-`.prefault()`. Mitigate: reset writes `undefined`; assert every entry has a Zod default; keep one-shot `*_MIGRATED`/`*_VERSION` markers out of the catalog.
5. **knownKeys drift** → "unknown key" warnings. Mitigate: derive from catalog, delete the hand-list, derivation test fails CI.
6. **ConfigForm complexity** (it's a list + drill-in, not one Select). Mitigate: MVP = booleans + enums + `openForm` only; defer free-text editing; reuse `MemoryListForm` list shape + `Select`.

## Explicit exclusions (omit `'cli'` from `hosts`; never surfaced in `/config`)

- `texra.memory.enabled`, `texra.goal.enabled` — gated by `registerAgentFeatures()`, confirmed **never called in the CLI** (`initPlatform.ts` has no call; only `extension.ts:219` / desktop `index.ts:154`). Toggling them in the CLI does nothing.
- `SUPER_YOLO_ENABLED`, `ALLOW_ORCHESTRATOR_KILL`, `DETACH_SUBAGENTS_ON_STOP`, `NESTED_DELEGATION_MAX_DEPTH` — display-only / no CLI orchestrator consumer.
- Complex global-state domains (streaming/endpoints/models/agents/tools/presets/codex/claude) — `openForm` delegation only, never `/config` scalars.
- Class-D internal state (`AGENT_HISTORY`, caches, `*_MIGRATED`/`*_VERSION`, onboarding flags, `DESKTOP_CRASH_REPORTING_ENABLED`) — not user settings; excluded entirely, enforced by the PR2 guardrail.

## Process

Grounded on fresh `origin/main`; re-sync before starting (`git rev-list --count main...origin/main`). Shared-repo concurrency: expect a format-bot commit — adopt via `reset --hard`, don't force-push. Each PR carries its own tests and is independently reviewable; CHANGELOG entry (Features) lands with PR3.
