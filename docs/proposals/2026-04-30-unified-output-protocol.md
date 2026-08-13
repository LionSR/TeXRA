# Unified Output Protocol

> **Status:** Partially landed proposal (2026-07-07 status sweep). Bundled agents
> and templates have converged on the `<documents><document ...>` protocol, and
> `documentTag`/`endTag` are now fixed protocol constants
> (`@shared/constants/outputProtocol`) rather than per-agent settings — old
> YAML that still sets them is ignored with a warning (#7094). The rest of the
> schema/registry deletion plan (`isMultipleOutput`, `MULTIPLE_SUFFIX`,
> `groupByBaseName`, the paired-YAML/`_multiple` fork) is not complete.

## Problem

Today, agents that produce multiple output documents are a structural fork of agents that produce one. The fork shows up at every layer:

- **Definition**: paired YAML files (`polish.yaml` + `polish_multiple.yaml`), three pairs locally and nine more under `prompts/agents/remote/`.
- **Schema**: `settings.isMultipleOutput`, `settings.documentTag`, `settings.endTag`; `prompts.userRequest` is `string | string[]`; `AgentConfig.useMultipleOutputs`.
- **Registry**: `MULTIPLE_SUFFIX`, `multiplePath`, `groupByBaseName`, `resolveAgent(_, preferMultiple)`, sibling-name promotion.
- **Prompts**: singular vs plural prose, `<latex_document>` vs `<latex_documents><document name=...>` output containers.
- **Model handlers**: extraction logic forks on `documentTag`.
- **UI**: `hasMultiplePath`, dual save/delete paths in `settingsView/handlers/agentHandlers.ts`, `_multiple` icon hint.
- **Remote**: each agent has two rows in `remote_agents`, two storage objects,
  and two entries in `docs/supabase/remote-agents.config.json`.

Cardinality (1 vs N outputs) is currently a **type axis**: it changes the shape of code paths. It should be a **value axis**: a number the runtime sees, with N=1 a degenerate case.

The c831a59 refactor (#3181) cut ~430 lines by trimming scratchpad scaffolding, but it left the fork intact. Every new agent that supports multi-output still doubles its surface area, and prompt drift between paired files is visible in the current source (e.g. `correct.yaml` says "research paper" while `correct_multiple.yaml` says "research papers", diverging beyond the necessary plural inflection).

## Proposal

Collapse all six layers onto one protocol:

### 1. One output container

```
<documents>
  <document name="...">…</document>
  …
</documents>
```

Always. N=1 produces one `<document>` child. `documentTag`/`endTag` become protocol constants and are removed from per-agent settings.

### 2. One input shape

Inputs are always a list of `{name, content}`. `INPUT_FILES` is always set; for N=1 it's a one-element array.

### 3. One prompt body

Prompts are written plural-by-default. Cardinality leaks into prose only via a Liquid block where singular reads materially better:

```liquid
{% if N == 1 %}the document{% else %}the documents{% endif %}
```

A single `{% if N == 1 %}You are revising one document.{% endif %}` line in the system prompt anchors the model.

### 4. One agent definition

Drop from the schema:

- `settings.isMultipleOutput`
- `settings.documentTag`, `settings.endTag`
- `multiple:` overlay (never introduced)
- `useMultipleOutputs` from `AgentConfig`

Drop from the registry:

- `MULTIPLE_SUFFIX`, `multiplePath`, `isMultiple`
- `groupByBaseName` `_multiple` promotion
- `getBaseName` / `getMultipleName`
- `preferMultiple` parameter on `resolveAgent`

Each agent is a single YAML. Each remote agent is one storage object and one row.

### 5. One UI

The file-selection control is multi-select with a default of 1. Remove the "supports multiple outputs" badge — every agent supports N≥1 because the protocol does. Remove `hasMultiplePath` from `settingsView` messages and the dual save/delete paths.

### 6. One model-handler parser

Always parse the list-form container. N=1 yields a one-element result. No `if (isMultipleOutput)` branches in any `modelHandler*.ts`.

## Migration

### Phase 0: Eval baseline

Before any code change, run a side-by-side eval of current single-output agents (`correct`, `polish`, `merge` and equivalents under `prompts/agents/remote/`) against draft unified prompts, on 10–20 representative inputs each. Score by author rubric:

- Output adheres to format
- Output preserves authorial intent
- Output applies requested edits
- Output is free of regressions vs current prompts

Gate the rollout on **no statistically meaningful regression** on the N=1 path. This phase produces a timestamped artifact at `docs/proposals/YYYY-MM-DD-unified-output-eval.md` with the side-by-side. If the gate fails, the proposal is paused and the prompt language is iterated until it passes.

### Phase 1: Protocol constants and parser

Land the unified container parser as the _only_ parser path. Existing single-output agents temporarily emit the old container; the parser reads both. This is a non-breaking shim that lives for one release.

### Phase 2: Migrate prompts and YAML

Per agent (one commit each, in order: `correct`, `polish`, `merge`, then the reference agents in a second pass):

1. Rewrite the YAML as a single file with plural-by-default prompts and the unified output container.
2. Delete the `_multiple` sibling.
3. Update `docs/supabase/remote-agents.config.json` to drop the `_multiple`
   entry (reference agents only).
4. Run the eval harness from Phase 0 against the migrated agent; commit only if it passes.

### Phase 3: Drop the fork from code

After all built-in agents are migrated:

- Drop `isMultipleOutput`, `documentTag`, `endTag` from `AgentSettingSchema`.
- Drop `useMultipleOutputs` from `AgentConfig`.
- Drop `MULTIPLE_SUFFIX`, `multiplePath`, `groupByBaseName` pairing logic, `preferMultiple` parameter from `agentRegistry.ts` and `agentLoad.ts`.
- Drop the dual code paths in model handlers, `RemoteAgentLoader.ts`, `agentHandlers.ts`, `register.ts`.
- Drop `hasMultiplePath` from `shared/schemas/settingsViewMessages.ts`.
- Update `src/agent/index/AgentDirectorySync.ts` `LEGACY_AGENT_FILES` to clean stale `_multiple` files from GlobalStorage.

### Phase 4: Legacy custom agents

User custom agents at `<customDir>/foo_multiple.yaml` keep working via a one-release loader shim that detects the `_multiple` suffix, merges with the base, and logs a deprecation. The shim is removed in the release after that.

### Phase 5: Remote storage cleanup

`scripts/sync-remote-agents.mjs` stops emitting `_multiple` rows. A separate SQL
migration deletes the `*_multiple` rows from `remote_agents` and the matching
storage objects. This is a flag day; client support for the unified protocol is
required first.

## Risks

- **Prompt-quality regression for N=1.** Mitigated by the Phase 0 eval gate. Not optional.
- **Touch surface is large.** Phase 1 isolates the risky parser change behind a shim; later phases are mechanical.
- **Custom user agents in the wild.** Phase 4 shim covers them. Window is two releases.
- **Remote storage and table consistency.** Phase 5 is gated on client rollout. Until then, the sync script keeps emitting paired rows even though the in-repo source is unified.

## Open questions

1. Should the system prompt expose `N` directly to the model, or only inflect prose? (Recommend: inflect prose; `N` is a runtime fact, not a prompt parameter.)
2. Does removing `documentTag` from settings break any custom user agent that overrides it for a non-LaTeX use case? (Investigation needed before Phase 1.)
3. Should agents with truly fixed output cardinality (e.g. `merge`, which always produces one merged document) carry an `expectedN: 1` constraint, or should the protocol stay unconstrained? (Recommend: unconstrained; the prompt asserts cardinality, the runtime doesn't enforce.)

## Non-goals

- Changing how multi-input agents read multiple files. That already works uniformly.
- Changing tool-use or workflow agents. They don't fork on output cardinality today.
- Changing the underlying agent execution flow. Only the protocol surface changes.
