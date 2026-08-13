---
created: 2026-02-06
updated: 2026-02-10
---

# PRD: Model Selection in Settings View

**Status:** Implemented
**Date:** 2026-02-06
**Related:** [Settings View PRD](./2026-01-11-settings-view-unified.md), llm-zoo package

---

## Overview

Replace `texra.models` (VS Code config array) and `texra.model.instructionPolishModel` (VS Code config string) with a visual model selection list and polish model dropdown in the Settings View Models tab. Storage moves from VS Code configuration to `globalSM` (extension global state). The llm-zoo package gains a `deprecated` field to categorize legacy models.

---

## Goals

1. **Visual model selection** — Checkbox list grouped by provider, replacing the VS Code Settings array editor
2. **Deprecation support** — Hide deprecated models behind per-provider collapsible toggles
3. **Model metadata** — Show context window and pricing alongside each model
4. **Clean storage** — Use `globalSM` instead of VS Code config (no Settings UI pollution)
5. **Provider consolidation** — Unify provider display name maps across the codebase

---

## Prerequisites

### llm-zoo package (handled separately)

Add `deprecated: boolean` (default `false`) to `ModelConfig` interface. Mark legacy models:

| Provider        | Current                                   | Deprecated                                                                                                                       |
| --------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic (21)  | opus46T/46, sonnet45T/45, haiku45T/45 (6) | opus45T/45, opus41T/41, opus4T/4, sonnet4T/4, sonnet37T/37, sonnet36/35/3, opus3, haiku35/3 (15)                                 |
| OpenAI (28)     | gpt52/52pro/52codex, gpt41/41- (5)        | gpt51, gpt5/5pro/5-/5--, gpt41--, gpt45, gpt4o/4o-/4ol/4t, o3pro/3/3-, o4-, o1pro/1/1preview/1-, o3-dr/o4-mini-dr, gptoss/- (23) |
| Google (6)      | gemini3p/3f (2)                           | gemini25p/25f/25f0617/25f- (4)                                                                                                   |
| DeepSeek (7)    | deepseek, deepseekT (2)                   | deepseekT+, dsv3, dsr1, dsv3o, dsr1o (5)                                                                                         |
| xAI (5)         | grok4 (1)                                 | grok3/3-, grok2/2v (4)                                                                                                           |
| Moonshot (8)    | kimi25, kimi25T (2)                       | kimi2/2+, kimi2T/2T+, kimi, kimiv, kimit (7)                                                                                     |
| DashScope (3)   | all 3 (0 deprecated)                      | —                                                                                                                                |
| **Copilot (1)** | **filtered out of model list**            | —                                                                                                                                |
| **Others (2)**  | —                                         | llama31, qvq-72b (2, **filtered out**)                                                                                           |

**Totals: 83 → 21 current shown + 61 deprecated (hidden by default) + 1 filtered out (copilot)**

As implemented in llm-zoo v1.0.5: only the latest generation per model line is current. All Claude 3.x/4.0-4.5, GPT-4.x/5.0-5.1, o-series, Gemini 2.5, Grok 2-3, etc. are deprecated.

---

## Storage

### Before (VS Code configuration)

```
texra.models → getConfig<string[]>('texra.models', [])
texra.model.instructionPolishModel → getConfig<string>('model.instructionPolishModel', 'sonnet45')
```

Stored in user `settings.json`, visible in VS Code Settings UI, registered in `package.json`.

### After (globalSM)

```
GlobalStateKey.ENABLED_MODELS → globalSM.get<string[]>('enabledModels', DEFAULT_MODELS)
GlobalStateKey.POLISH_MODEL → globalSM.get<string>('polishModel', 'sonnet45')
```

Stored in VS Code extension global state. Not visible in Settings UI. Not in `package.json`.

New `GlobalStateKey` entries:

```typescript
export enum GlobalStateKey {
  LAST_KNOWN_VERSION = 'lastKnownVersion',
  MODEL_LIST_VERSION = 'modelListVersion',
  MEMORY_ENABLED = 'texra.memory.enabled',
  ENABLED_MODELS = 'enabledModels', // NEW
  POLISH_MODEL = 'polishModel', // NEW
}
```

### Migration

**Breaking change** — existing `texra.models` and `texra.model.instructionPolishModel` config values are not migrated. Fresh defaults apply. This is acceptable because:

- Most users use the defaults anyway
- The new UI makes re-selecting easy
- Avoids migration complexity

### Default models

```typescript
export const DEFAULT_MODELS = [
  'gemini3p',
  'gemini3f',
  'sonnet45T',
  'sonnet45',
  'opus46T',
  'opus46',
  'gpt52',
  'gpt52pro',
  'gpt41',
  'deepseekT',
  'kimi25T',
  'kimi25',
  'qwen3max',
  'grok4',
];
```

All non-deprecated. Stored in `computeModelOptions.ts` as exported constant. Note: `sonnet45` (non-thinking) is included because it is the default polish model.

---

## UI Design

### Layout in Models Tab

```
┌──────────────────────────────────────────────────────────────────┐
│ [API Access Section - existing, authenticated only]              │
│─────────────────────────────────────────────────────────────────│
│ Model Selection                                                  │
│ Select which models appear in the dropdown.                      │
│                                                                  │
│ Polish model: [ sonnet45                                    ▼ ]  │
│                                                                  │
│ ▸ Anthropic                                        4/6  enabled   │
│ ▾ OpenAI                                           3/5  enabled   │
│ ┌────────────────────────────────────────────────────────────┐   │
│ │ ☑ gpt41          128K     $2.00/$8.00                      │   │
│ │ ☐ gpt41-         128K     $0.40/$1.60                      │   │
│ │ ☑ gpt52          256K     $2.50/$10.00                     │   │
│ │ ☐ gpt52codex     256K     $2.50/$10.00                     │   │
│ │ ☑ gpt52pro       256K     $5.00/$25.00                     │   │
│ │                                                            │   │
│ │ ▸ 23 deprecated                                            │   │
│ │ ┌──────────────────────────────────────────────────────┐   │   │
│ │ │ ☐ gpt41--       128K     $0.10/$0.40                 │   │   │
│ │ │ ☐ gpt45         128K     $10.00/$30.00               │   │   │
│ │ │ ☐ gpt4o         128K     $2.50/$10.00                │   │   │
│ │ │ ☐ o3            200K     $10.00/$40.00               │   │   │
│ │ │ ...                                                  │   │   │
│ │ └──────────────────────────────────────────────────────┘   │   │
│ └────────────────────────────────────────────────────────────┘   │
│ ▸ Google                                           2/2  enabled   │
│ ▸ DeepSeek                                         1/2  enabled   │
│ ▸ xAI                                              1/1  enabled   │
│ ▸ Moonshot                                         2/2  enabled   │
│ ▸ DashScope                                        1/3  enabled   │
│─────────────────────────────────────────────────────────────────│
│ [Provider Key List - existing, all users]                        │
└──────────────────────────────────────────────────────────────────┘
```

### Design Rules

- **Provider order:** Matches provider key list order (OpenAI, Anthropic, Google, xAI, DeepSeek, Moonshot, DashScope). Copilot and Others are filtered out.
- **Model sort:** Alphabetical by short name within each provider.
- **Count format:** `"N/M enabled"` where N = enabled current models, M = total current (non-deprecated) models for this provider. Enabled deprecated models are not reflected in the count (they appear in the collapsed deprecated section).
- **Deprecated toggle:** Per-provider `"▸ N deprecated"` collapsible at the bottom of each provider's model list. Only shown if provider has deprecated models.
- **Metadata columns:** Context window (formatted: "128K", "200K", "1.0M") and cost (formatted: "$input/$output" per 1M tokens). Both from llm-zoo `ModelConfig`.
- **No Select All / Deselect All buttons.**
- **Polish model dropdown:** Shows only enabled (checked) models. Native `<select>` element.
- **Expand behavior:** One provider expanded at a time (same as provider key list pattern).

### Interaction with Relay

The model selection list does **not** show relay availability. It only controls **visibility** (which models appear in the dropdown). Availability is determined at runtime by `computeModelOptionsData()` and displayed in the main view dropdown (disabled state + key icon).

This separation is intentional:

- Visibility = user preference (Settings View)
- Availability = access mode + API keys + relay tier (main dropdown)

---

## Message Protocol

### New Commands

Add to `SETTINGS_VIEW_CMD` (inbound, schema-validated):

```typescript
GET_MODEL_SELECTION: 'getModelSelection',
SET_MODEL_ENABLED: 'setModelEnabled',
SET_POLISH_MODEL: 'setPolishModel',
```

Add to `SETTINGS_VIEW_COMMANDS` (outbound-only):

```typescript
UPDATE_MODEL_SELECTION: 'updateModelSelection',
```

### Schemas

```typescript
// Model item sent from backend to frontend
const ModelSelectionItemSchema = z.object({
  name: z.string(), // Short name: "sonnet45T"
  provider: z.string(), // Provider: "anthropic"
  enabled: z.boolean(), // In enabled models list
  deprecated: z.boolean(), // From llm-zoo
  contextWindow: z.string().optional(), // Formatted: "200K"
  cost: z.string().optional(), // Formatted: "$3.00/$15.00"
});

// Outbound: backend → frontend
const UpdateModelSelectionMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION),
  models: z.array(ModelSelectionItemSchema),
  polishModel: z.string(),
});

// Inbound: get model selection data
const GetModelSelectionMessageSchema = z.object({
  command: z.literal(CMD.GET_MODEL_SELECTION),
});

// Inbound: toggle a single model
const SetModelEnabledMessageSchema = z.object({
  command: z.literal(CMD.SET_MODEL_ENABLED),
  modelName: z.string().min(1),
  enabled: z.boolean(),
});

// Inbound: set polish model
const SetPolishModelMessageSchema = z.object({
  command: z.literal(CMD.SET_POLISH_MODEL),
  modelName: z.string().min(1),
});
```

### Data Flow

```
Frontend                          Backend
   │                                 │
   │── GET_MODEL_SELECTION ─────────▶│ reads globalSM + llm-zoo
   │                                 │
   │◀── UPDATE_MODEL_SELECTION ──────│ sends ModelSelectionItem[] + polishModel
   │                                 │
   │── SET_MODEL_ENABLED ───────────▶│ updates globalSM('enabledModels')
   │                                 │ fires texra.refreshAllOptions
   │◀── UPDATE_MODEL_SELECTION ──────│ sends updated list
   │                                 │
   │── SET_POLISH_MODEL ────────────▶│ updates globalSM('polishModel')
   │◀── UPDATE_MODEL_SELECTION ──────│ sends updated list
```

---

## Provider Consolidation

Currently, provider display names are duplicated:

| Location                        | Map                                | Providers        |
| ------------------------------- | ---------------------------------- | ---------------- |
| `SettingsViewMessageHandler.ts` | `PROVIDER_DISPLAY_NAMES`           | 9 ApiProviders   |
| `ProviderKeyList.ts` (implicit) | Uses `displayName` from backend    | —                |
| Model selection (new)           | Needs ModelProvider → display name | 7 ModelProviders |

Consolidate into a single shared constant:

```typescript
// src/shared/constants/providers.ts (new file)
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openRouter: 'OpenRouter',
  google: 'Google',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot',
  dashscope: 'DashScope',
  wolframllmapp: 'Wolfram',
  copilot: 'Copilot',
  others: 'Others',
};

/** Providers that have models in the model selection list. */
export const MODEL_PROVIDERS_ORDER = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;
```

This is used by:

- `SettingsViewMessageHandler` (existing provider key statuses + new model selection)
- `ModelSelectionList` component (provider group headers)
- Any future provider-aware UI

---

## Implementation

### Files to Modify

| #   | File                                                                          | Change                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | `package.json`                                                                | Remove `texra.models` (~80 lines) and `texra.model.instructionPolishModel` (~60 lines)                                  |
| 2   | `src/common/state/stateManager.ts`                                            | Add `ENABLED_MODELS` and `POLISH_MODEL` to `GlobalStateKey`                                                             |
| 3   | `src/model/computeModelOptions.ts`                                            | Export `DEFAULT_MODELS`; rewrite `getVisibleModels()` to use `globalSM`                                                 |
| 4   | `src/utils/text/textEnhancementUtils.ts`                                      | Read polish model from `globalSM` instead of `getConfig`                                                                |
| 5   | `src/frontend/setup.ts`                                                       | Simplify `refreshModelListIfNeeded()` for globalSM; import `DEFAULT_MODELS`; remove `instructionPolishModel` from reset |
| 6   | `src/MainViewProvider.ts`                                                     | Remove `texra.models` from config watcher (refresh now triggered by Settings View handler)                              |
| 7   | **New:** `src/shared/constants/providers.ts`                                  | Consolidated `PROVIDER_DISPLAY_NAMES` and `MODEL_PROVIDERS_ORDER`                                                       |
| 8   | `src/common/webview/commands.ts`                                              | Add 3 inbound + 1 outbound command constants                                                                            |
| 9   | `src/shared/schemas/settingsViewMessages.ts`                                  | Add `ModelSelectionItemSchema`, outbound + 3 inbound message schemas                                                    |
| 10  | `src/settingsView/SettingsViewMessageHandler.ts`                              | Add `buildModelSelectionItems()`, `sendModelSelectionData()`, 3 handlers; import from shared providers                  |
| 11  | **New:** `src/settingsView/frontend/components/profile/ModelSelectionList.ts` | Checkbox list component with provider groups + deprecated toggles                                                       |
| 12  | `src/settingsView/frontend/components/profile/events.ts`                      | Add `ModelSelectionEvents` (2 events)                                                                                   |
| 13  | `src/settingsView/frontend/components/profile/styles.ts`                      | Add model list CSS                                                                                                      |
| 14  | `src/settingsView/frontend/SettingsApp.ts`                                    | Wire state + event handlers + message handler                                                                           |
| 15  | `src/settingsView/frontend/tabs/ModelsTab.ts`                                 | Add properties, render `<model-selection-list>` + polish model dropdown                                                 |
| 16  | `docs/prds/2026-01-11-settings-view-unified.md`                               | Update implementation status                                                                                            |

### Backend: `buildModelSelectionItems()`

```typescript
import { MODELS, MODEL_CONFIGS } from 'llm-zoo';
import { MODEL_PROVIDERS_ORDER } from '@shared/constants/providers';

function buildModelSelectionItems(): ModelSelectionItem[] {
  const enabledSet = new Set(
    globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS),
  );

  return MODELS.filter((name) => {
    const config = MODEL_CONFIGS[name];
    // Filter out copilot and others
    return config && MODEL_PROVIDERS_ORDER.includes(config.provider);
  })
    .map((name) => {
      const config = MODEL_CONFIGS[name];
      return {
        name,
        provider: config.provider,
        enabled: enabledSet.has(name),
        deprecated: config.deprecated ?? false,
        contextWindow: formatContext(config.contextWindow),
        cost: formatCost(config.inputPrice, config.outputPrice),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

### Backend: handlers

```typescript
private async handleSetModelEnabled(
  data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_MODEL_ENABLED>,
): Promise<void> {
  const current = globalSM.get<string[]>(
    GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS,
  );
  const updated = data.enabled
    ? [...new Set([...current, data.modelName])]
    : current.filter(m => m !== data.modelName);

  await globalSM.update(GlobalStateKey.ENABLED_MODELS, updated);

  // Auto-reset polish model if it was just disabled
  if (!data.enabled) {
    const polishModel = globalSM.get<string>(GlobalStateKey.POLISH_MODEL, DEFAULT_POLISH_MODEL);
    if (polishModel === data.modelName) {
      const newPolish = updated[0] ?? DEFAULT_POLISH_MODEL;
      await globalSM.update(GlobalStateKey.POLISH_MODEL, newPolish);
    }
  }

  void vscode.commands.executeCommand('texra.refreshAllOptions');

  const view = this.getActiveView();
  if (view) await this.sendModelSelectionData(view.webview);
}

private async handleSetPolishModel(
  data: MessageFor<typeof SETTINGS_VIEW_CMD.SET_POLISH_MODEL>,
): Promise<void> {
  await globalSM.update(GlobalStateKey.POLISH_MODEL, data.modelName);

  const view = this.getActiveView();
  if (view) await this.sendModelSelectionData(view.webview);
}
```

### Frontend: `ModelSelectionList` component

```
Properties:
  @property({ attribute: false }) models: ModelSelectionItem[] = []

State:
  @state() private expandedProvider: string | null = null
  @state() private expandedDeprecated: Set<string> = new Set()

Render structure:
  <div class="model-selection-section">
    <h2>Model Selection</h2>
    <p>Select which models appear in the dropdown.</p>
    [polish model dropdown]
    [provider groups]
  </div>

Each provider group:
  <button class="provider-group-header">
    <chevron> <name> <count>
  </button>
  [if expanded:]
    [current models as checkbox rows with metadata]
    [if has deprecated:]
      <button class="deprecated-toggle">▸ N deprecated</button>
      [if deprecated expanded:]
        [deprecated models as checkbox rows with metadata]
```

### Frontend: events

```typescript
export const ModelSelectionEvents = {
  setModelEnabled: (detail: { modelName: string; enabled: boolean }) =>
    createEvent('model-enabled-set', detail),
  setPolishModel: (detail: { modelName: string }) =>
    createEvent('polish-model-set', detail),
} as const;
```

### Consumer changes

**`getVisibleModels()` (computeModelOptions.ts):**

```typescript
export function getVisibleModels(): string[] {
  return globalSM.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS);
}
```

No other consumer changes needed — `computeModelOptionsData()`, `resolveVisibleModel()`, and `WorkflowTool.ts` all call `getVisibleModels()`.

**`textEnhancementUtils.ts`:**

```typescript
const polishModel = globalSM.get<string>(
  GlobalStateKey.POLISH_MODEL,
  DEFAULT_POLISH_MODEL,
);
```

**`setup.ts` simplification:**

`refreshModelListIfNeeded()` continues to use `MODEL_LIST_VERSION` for merging new defaults into existing user lists. Reads/writes `globalSM.get(GlobalStateKey.ENABLED_MODELS)` instead of `getConfig('texra.models')`. Remove `instructionPolishModel` from `resetModelConfigsToDefaults()`.

**`MainViewProvider.ts`:**

Remove `'texra.models'` from `watchConfig()` array. The Settings View handler calls `texra.refreshAllOptions` after every model change, which is the same command the config watcher would have triggered.

---

## Edge Cases

1. **Fresh install** — `globalSM.get(ENABLED_MODELS)` returns `undefined` → uses `DEFAULT_MODELS`. All 14 defaults are non-deprecated current models (verified against llm-zoo v1.0.5).

2. **User enables deprecated model** — Works normally. Model appears in dropdown. No special treatment at runtime.

3. **Polish model gets unchecked** — When `SET_MODEL_ENABLED` disables the current polish model, the handler auto-resets polish model to the first remaining enabled model (or `DEFAULT_POLISH_MODEL` if none). The updated polish model is sent back to the frontend in the same `UPDATE_MODEL_SELECTION` response.

4. **llm-zoo adds new models** — New models appear in the model list as unchecked. `refreshModelListIfNeeded()` can merge new defaults via `MODEL_LIST_VERSION` bump.

5. **llm-zoo marks model as deprecated** — Model moves from current section to deprecated toggle in the UI. If it was enabled, it stays enabled (no data loss). User can uncheck it manually.

6. **Provider with 0 current models** — Provider group still shows but with `"0/0 enabled"`. All models are in the deprecated toggle. (Unlikely in practice.)

7. **Provider with 0 deprecated models** — No deprecated toggle shown for that provider (Google, DashScope currently).

---

## Verification

1. `npm run compile` — builds without errors
2. `npm run typecheck` — no type errors
3. Open Settings View → Models tab → model list below provider keys
4. Expand a provider → check/uncheck models → main view dropdown updates
5. Expand deprecated toggle → enable a deprecated model → appears in dropdown
6. Change polish model dropdown → verify it persists across reload
7. Fresh install (no globalSM data) → DEFAULT_MODELS shown as enabled
8. VS Code Settings UI → `texra.models` and `instructionPolishModel` no longer appear
9. Run an agent with a model → streaming/routing still works (zero runtime changes)
