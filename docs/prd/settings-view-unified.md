# PRD: Unified Settings View

**Status:** Draft
**Author:** Claude
**Date:** 2026-01-25
**Related:** Model dropdown, Agent dropdown, Profile View, History View, ProgressView Modernization PRD

---

## Overview

Create a unified Settings View that consolidates model configuration, agent configuration, execution history, and profile/account management into a single tabbed interface. This replaces the scattered entry points with a cohesive settings experience.

**Architecture**: This implementation follows the **Lit + TypeScript + Zod** architecture established in the ProgressView Modernization PRD. Settings View will be implemented as part of Phase 3 webview migrations.

---

## Goals

1. **Single source of truth** - All configuration in one place
2. **Easy navigation** - Lit tabs with logical groupings
3. **No auth required** - Most tabs work without login (except account features in header)
4. **Type-safe IPC** - Zod schemas for all messages, validated at boundary
5. **Proper state management** - Reactive Lit store, global vs workspace state separation
6. **Backwards compatible** - Extend getConfig rather than replacing it; graceful migration
7. **Consistent with ProgressView** - Same patterns, shared components, shared schemas

---

## User Stories

1. As a user, I want to click a settings icon to configure which models appear in my dropdown
2. As a user, I want to configure different agents per workspace (research project vs thesis)
3. As a user, I want to browse execution history and restore previous sessions
4. As a user, I want to manage my account and API keys in the same interface
5. As a user, I want to easily switch between these configuration pages
6. As a user, I want to configure LaTeX formatter, latexdiff, and TikZ settings in one place

---

## Design Principles

The Settings View prioritizes simplicity and user-friendliness, inspired by Notion's philosophy of clean, uncluttered interfaces.

### Core Principles

1. **Simplicity first** - Use VS Code native components; avoid custom styling
2. **Clear grouping** - Logical sections with clear headers
3. **Progressive disclosure** - Hide advanced options in collapsibles
4. **Immediate feedback** - Settings save automatically or with clear feedback
5. **Familiar patterns** - Follow VS Code settings UI conventions

### Implementation Guidelines

- Use Lit components with VS Code theme CSS variables
- Use shared components from `src/shared/components/`
- Keep actions visible (no hover-to-reveal complexity)
- Follow patterns established in ProgressView modernization

---

## Design

### Entry Point

Single entry point from main webview:

```
┌─────────────────────────────────────────────┐
│  Model: [Claude Sonnet 4.5 ▼]               │
│  Agent: [chat ▼]               [⚙️ Settings]│
└─────────────────────────────────────────────┘
```

Clicking ⚙️ (codicon: `settings-gear`) opens the unified Settings View.

### Header Bar + Tabs Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  👤 user@example.com • Pro Plan                    [Manage] [Sign Out] [×]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Models]  Agents  LaTeX  Memory  History                                   │
│  ═══════                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Tab content rendered by Lit components                                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Tab Structure (5 tabs for v1):**

```
Tab 1: Models
├── Routing options (radio: direct/openrouter/proxy)
├── Recommended Models section
└── Provider accordions (collapsible per provider)
    └── Model checkboxes + [Configure] for API key

Tab 2: Agents
├── Built-in agents list
├── Custom agents list
├── Remote agents (if logged in)
├── Workflow Settings collapsible
└── Tool-Use Settings collapsible

Tab 3: LaTeX
├── Formatter collapsible
├── LaTeXdiff collapsible
├── TikZ Figures collapsible
└── Replacements collapsible (advanced)

Tab 4: Memory
└── Memory file browser with expandable content preview

Tab 5: History
└── Execution history browser (search, restore, rerun)
```

---

## Architecture

### Technology Stack

Settings View follows the **Lit + TypeScript + Zod** architecture:

| Layer | Technology | Notes |
|-------|------------|-------|
| **UI Framework** | Lit 3.x | Reactive components with decorators |
| **Language** | TypeScript | Full type safety, no JS modules |
| **State** | `@lit-labs/preact-signals` | Reactive store pattern |
| **Validation** | Zod | Schemas in `src/shared/schemas/` |
| **Styling** | Lit CSS + VS Code variables | Scoped styles per component |
| **Build** | Webpack | Bundled `bundle.js` per webview |

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Extension Host (TypeScript)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SettingsViewProvider (extends BaseWebviewProvider)                 │
│  ├── Lifecycle: resolveWebviewView(), createOrShowPanel()           │
│  ├── Loads bundled Lit app from dist/settingsView/bundle.js         │
│  └── Disposable management                                          │
│                                                                     │
│  SettingsViewContentProvider (extends BaseViewContentProvider)      │
│  ├── HTML shell with <settings-app> custom element                  │
│  ├── Script tag loading bundle.js                                   │
│  └── CSP nonce generation                                           │
│                                                                     │
│  SettingsViewMessageHandler (extends BaseViewMessageHandler)        │
│  ├── Command routing (createHandlers())                             │
│  ├── Zod validation (withValidatedMessage())                        │
│  └── Backend service calls                                          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        Webview (Lit + TypeScript)                    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  store.ts (Reactive state with @lit-labs/preact-signals)            │
│  ├── Single source of truth for UI state                            │
│  ├── Typed state interface                                          │
│  └── Derived state helpers                                          │
│                                                                     │
│  SettingsApp.ts (Root Lit component)                                │
│  ├── Message handler setup                                          │
│  ├── Dispatches to child components                                 │
│  └── Prompt overlay for confirmations                               │
│                                                                     │
│  Tab Components (Lit custom elements)                               │
│  ├── <models-tab>, <agents-tab>, <latex-tab>, etc.                  │
│  ├── Reactive @property decorators                                  │
│  └── Declarative event handlers                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
src/
├── shared/                          # From ProgressView modernization
│   ├── schemas/                     # SINGLE SOURCE OF TRUTH
│   │   ├── index.ts                 # Barrel export
│   │   ├── identifiers.ts           # StreamTabId, ExecutionId
│   │   ├── settings.ts              # Settings-specific schemas (NEW)
│   │   ├── commands.ts              # All command constants
│   │   └── ...                      # Other shared schemas
│   ├── components/                  # Shared Lit components
│   │   ├── Button.ts
│   │   ├── Tabs.ts
│   │   ├── Collapsible.ts
│   │   └── index.ts
│   ├── BaseWebviewApp.ts            # Base class for Lit apps
│   └── vscode.ts                    # VS Code API wrapper
│
├── settingsView/
│   ├── SettingsViewProvider.ts      # Extends BaseWebviewProvider
│   ├── SettingsViewMessageHandler.ts # Extends BaseViewMessageHandler
│   ├── SettingsViewContentProvider.ts # HTML shell generator
│   ├── schemas.ts                   # Re-export shared + settings-specific
│   ├── handlers/                    # Extracted domain handlers
│   │   ├── ModelHandlers.ts
│   │   ├── AgentHandlers.ts
│   │   ├── LatexHandlers.ts
│   │   ├── HistoryHandlers.ts
│   │   └── MemoryHandlers.ts
│   └── frontend/                    # Lit components (bundled)
│       ├── index.ts                 # Entry point, registers components
│       ├── store.ts                 # Reactive state
│       ├── SettingsApp.ts           # Root <settings-app> component
│       └── components/
│           ├── HeaderBar.ts
│           ├── ModelsTab.ts
│           ├── AgentsTab.ts
│           ├── LatexTab.ts
│           ├── MemoryTab.ts
│           ├── HistoryTab.ts
│           └── ConfirmDialog.ts
│
├── profileView/                     # DEPRECATED - merge into settingsView
├── historyView/                     # DEPRECATED - merge into settingsView
├── memoryView/                      # DEPRECATED - merge into settingsView
```

### Webpack Configuration

Add to `webpack.config.js`:

```javascript
const settingsViewConfig = {
  name: 'settingsView',
  entry: './src/settingsView/frontend/index.ts',
  output: {
    path: path.resolve(__dirname, 'dist/settingsView'),
    filename: 'bundle.js',
  },
  target: 'web',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@settingsView': path.resolve(__dirname, 'src/settingsView'),
      // ... other aliases
    },
  },
  module: {
    rules: [
      { test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ },
    ],
  },
};

module.exports = [extensionConfig, progressViewConfig, settingsViewConfig];
```

---

## Schemas (Single Source of Truth)

### Location: `src/shared/schemas/settings.ts`

All settings-related schemas in ONE file. No duplicates.

```typescript
import { z } from 'zod';

// =============================================================================
// Settings Tab Types
// =============================================================================

export const SettingsTabSchema = z.enum([
  'models',
  'agents',
  'latex',
  'memory',
  'history',
]);
export type SettingsTab = z.infer<typeof SettingsTabSchema>;

// =============================================================================
// Provider Configuration
// =============================================================================

export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'openrouter',  // ✅ Consistent lowercase
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
]);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ProviderStatusSchema = z.object({
  hasKey: z.boolean(),
  keySource: z.enum(['secret', 'env', 'none']),
});

export const ProviderMetaSchema = z.object({
  name: z.string(),
  keyUrl: z.string().url(),
  envVar: z.string(),
  defaultEndpoint: z.string().url().optional(),
});

// =============================================================================
// Model Data
// =============================================================================

export const ModelDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: ProviderIdSchema,
  contextWindow: z.number(),
  inputCost: z.number(),
  outputCost: z.number(),
  capabilities: z.array(z.string()),
  enabled: z.boolean(),
});
export type ModelData = z.infer<typeof ModelDataSchema>;

// =============================================================================
// Agent Data
// =============================================================================

export const AgentSourceSchema = z.enum(['builtIn', 'builtInToolUse', 'custom', 'remote']);
export const AgentCategorySchema = z.enum(['workflow', 'toolUse']);
export const AgentTypeSchema = z.enum(['CoT', 'direct', 'toolUse', 'merge', 'reflect']);

export const AgentDataSchema = z.object({
  name: z.string(),
  source: AgentSourceSchema,
  category: AgentCategorySchema,
  agentType: AgentTypeSchema,
  description: z.string().optional(),
  enabled: z.boolean(),
});
export type AgentData = z.infer<typeof AgentDataSchema>;

// =============================================================================
// Memory File (Recursive)
// =============================================================================

export interface MemoryFile {
  name: string;
  path: string;
  size: number;
  modified: string;
  preview?: string;
  lineCount?: number;
  isDirectory?: boolean;
  children?: MemoryFile[];
}

export const MemoryFileSchema: z.ZodType<MemoryFile> = z.lazy(() =>
  z.object({
    name: z.string(),
    path: z.string(),
    size: z.number(),
    modified: z.string(),
    preview: z.string().optional(),
    lineCount: z.number().optional(),
    isDirectory: z.boolean().optional(),
    children: z.array(MemoryFileSchema).optional(),
  })
);

// =============================================================================
// Initial Data Payload
// =============================================================================

export const SettingsInitialDataSchema = z.object({
  selectedTab: SettingsTabSchema.optional(),
  account: z.object({
    authenticated: z.boolean(),
    email: z.string().optional(),
    userId: z.string().optional(),
    tier: z.enum(['free', 'Max', 'Ultra']).optional(),
    useIncludedAccess: z.boolean().optional(),
  }),
  models: z.array(ModelDataSchema),
  enabledModels: z.array(z.string()),
  providers: z.record(ProviderIdSchema, ProviderStatusSchema),
  providerMeta: z.record(ProviderIdSchema, ProviderMetaSchema),  // ✅ Sent from backend
  agents: z.array(AgentDataSchema),
  latexSettings: z.record(z.string(), z.unknown()),
  selectOptions: z.record(z.string(), z.array(z.object({
    value: z.string(),
    label: z.string(),
  }))),
  historyItems: z.array(z.unknown()),  // Uses HistoryItemSchema from shared
  memoryFiles: z.array(MemoryFileSchema),
  memoryEnabled: z.boolean(),
});
export type SettingsInitialData = z.infer<typeof SettingsInitialDataSchema>;
```

### Location: `src/shared/schemas/commands.ts`

Command constants - SINGLE definition, no duplicates:

```typescript
// =============================================================================
// Settings View Commands - SINGLE SOURCE OF TRUTH
// =============================================================================

export const SETTINGS_VIEW_COMMANDS = {
  // Extension → Webview
  SET_INITIAL_DATA: 'SET_INITIAL_DATA',
  SET_MODELS_DATA: 'SET_MODELS_DATA',
  SET_AGENTS_DATA: 'SET_AGENTS_DATA',
  SET_LATEX_DATA: 'SET_LATEX_DATA',
  SET_HISTORY_DATA: 'SET_HISTORY_DATA',
  SET_MEMORY_DATA: 'SET_MEMORY_DATA',
  SELECT_TAB: 'SELECT_TAB',

  // Webview → Extension
  GET_INITIAL_DATA: 'GET_INITIAL_DATA',
  TAB_CHANGED: 'TAB_CHANGED',
  SAVE_ENABLED_MODELS: 'SAVE_ENABLED_MODELS',
  SAVE_ENABLED_AGENTS: 'SAVE_ENABLED_AGENTS',
  SAVE_SETTING: 'SAVE_SETTING',
  SET_API_KEY: 'SET_API_KEY',
  DELETE_API_KEY: 'DELETE_API_KEY',
  SET_API_ACCESS_MODE: 'SET_API_ACCESS_MODE',
  SIGN_IN: 'SIGN_IN',
  SIGN_OUT: 'SIGN_OUT',

  // Agent operations
  OPEN_AGENT_SOURCE: 'OPEN_AGENT_SOURCE',
  DELETE_AGENT: 'DELETE_AGENT',
  BROWSE_AGENTS_DIRECTORY: 'BROWSE_AGENTS_DIRECTORY',
  OPEN_AGENTS_DIRECTORY: 'OPEN_AGENTS_DIRECTORY',

  // History operations
  RERUN_HISTORY: 'RERUN_HISTORY',
  RESTORE_HISTORY: 'RESTORE_HISTORY',
  DELETE_HISTORY: 'DELETE_HISTORY',
  CLEAR_HISTORY: 'CLEAR_HISTORY',

  // Memory operations
  OPEN_MEMORY_FILE: 'OPEN_MEMORY_FILE',
  DELETE_MEMORY_FILE: 'DELETE_MEMORY_FILE',
  CLEAR_ALL_MEMORY: 'CLEAR_ALL_MEMORY',
  GET_MEMORY_PREVIEW: 'GET_MEMORY_PREVIEW',

  // File browsing
  BROWSE_FILE: 'BROWSE_FILE',
} as const;

export type SettingsViewCommand = typeof SETTINGS_VIEW_COMMANDS[keyof typeof SETTINGS_VIEW_COMMANDS];
```

---

## Lit Component Patterns

### Root Component

```typescript
// src/settingsView/frontend/SettingsApp.ts
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { state as appState } from './store';
import { SETTINGS_VIEW_COMMANDS } from '@shared/schemas/commands';

// Import tab components
import './components/HeaderBar';
import './components/ModelsTab';
import './components/AgentsTab';
import './components/LatexTab';
import './components/MemoryTab';
import './components/HistoryTab';
import './components/ConfirmDialog';

@customElement('settings-app')
export class SettingsApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      height: 100vh;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: var(--spacing-large, 16px);
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('message', this._handleMessage);
    // Request initial data
    vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this._handleMessage);
  }

  private _handleMessage = (event: MessageEvent) => {
    const message = event.data;
    switch (message.command) {
      case SETTINGS_VIEW_COMMANDS.SET_INITIAL_DATA:
        appState.updateFromInitialData(message);
        break;
      // ... other handlers
    }
  };

  render() {
    return html`
      <div class="container">
        <header-bar
          .authenticated=${appState.account.authenticated}
          .email=${appState.account.email}
          .tier=${appState.account.tier}
        ></header-bar>

        <texra-tabs
          .tabs=${['models', 'agents', 'latex', 'memory', 'history']}
          .activeTab=${appState.activeTab}
          @tab-change=${this._onTabChange}
        >
          <models-tab slot="models" .state=${appState}></models-tab>
          <agents-tab slot="agents" .state=${appState}></agents-tab>
          <latex-tab slot="latex" .state=${appState}></latex-tab>
          <memory-tab slot="memory" .state=${appState}></memory-tab>
          <history-tab slot="history" .state=${appState}></history-tab>
        </texra-tabs>

        <confirm-dialog
          ?open=${appState.confirmDialog !== null}
          .config=${appState.confirmDialog}
          @confirm=${this._onConfirm}
          @cancel=${this._onCancel}
        ></confirm-dialog>
      </div>
    `;
  }

  private _onTabChange(e: CustomEvent<{ tab: string }>) {
    appState.activeTab = e.detail.tab;
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.TAB_CHANGED,
      tab: e.detail.tab,
    });
  }
}
```

### Tab Component Example

```typescript
// src/settingsView/frontend/components/ModelsTab.ts
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { classMap } from 'lit/directives/class-map.js';
import type { SettingsState } from '../store';
import { SETTINGS_VIEW_COMMANDS } from '@shared/schemas/commands';

@customElement('models-tab')
export class ModelsTab extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .provider-section {
      margin-bottom: 16px;
    }

    .provider-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .status-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    .status-badge.has-key {
      background: var(--vscode-testing-iconPassed);
    }

    .status-badge.no-key {
      background: var(--vscode-testing-iconFailed);
    }

    .model-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
    }
  `;

  @property({ type: Object }) state!: SettingsState;

  render() {
    const providers = this._groupModelsByProvider();

    return html`
      <section class="recommended-section">
        <h3>Recommended Models</h3>
        ${this._renderModelList(this.state.recommendedModels)}
      </section>

      ${repeat(
        Object.entries(providers),
        ([id]) => id,
        ([providerId, models]) => this._renderProviderSection(providerId, models)
      )}
    `;
  }

  private _renderProviderSection(providerId: string, models: ModelData[]) {
    const meta = this.state.providerMeta[providerId];
    const status = this.state.providers[providerId];

    return html`
      <texra-collapsible title="${meta?.name ?? providerId} (${models.length})">
        <div class="provider-header" slot="header-extra">
          <span class=${classMap({
            'status-badge': true,
            'has-key': status?.hasKey ?? false,
            'no-key': !status?.hasKey,
          })}>
            ${status?.hasKey ? '✓ API Key' : '✗ No Key'}
          </span>
          <button @click=${() => this._configureProvider(providerId)}>
            Configure
          </button>
        </div>
        ${this._renderModelList(models)}
      </texra-collapsible>
    `;
  }

  private _renderModelList(models: ModelData[]) {
    return html`
      ${repeat(
        models,
        (m) => m.id,
        (model) => html`
          <div class="model-item">
            <input
              type="checkbox"
              id="model-${model.id}"
              ?checked=${model.enabled}
              @change=${() => this._toggleModel(model.id)}
            />
            <label for="model-${model.id}">
              ${model.name}
              <span class="model-meta">
                ${model.contextWindow}K • $${model.inputCost}/$${model.outputCost}
              </span>
            </label>
          </div>
        `
      )}
    `;
  }

  private _toggleModel(modelId: string) {
    // Update local state optimistically
    const enabled = this.state.enabledModels.includes(modelId);
    if (enabled) {
      this.state.enabledModels = this.state.enabledModels.filter(id => id !== modelId);
    } else {
      this.state.enabledModels = [...this.state.enabledModels, modelId];
    }

    // Send to backend (debounced in store)
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_MODELS,
      models: this.state.enabledModels,
    });
  }
}
```

### Reactive Store

```typescript
// src/settingsView/frontend/store.ts
import { reactive } from '@lit-labs/preact-signals';
import type {
  SettingsTab,
  ModelData,
  AgentData,
  MemoryFile,
  ProviderMeta,
  ProviderStatus,
} from '@shared/schemas/settings';

export interface ConfirmDialogConfig {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface SettingsState {
  // Tab state
  activeTab: SettingsTab;

  // Account
  account: {
    authenticated: boolean;
    email?: string;
    userId?: string;
    tier?: 'free' | 'Max' | 'Ultra';
    useIncludedAccess?: boolean;
  };

  // Models
  models: ModelData[];
  enabledModels: string[];
  recommendedModels: ModelData[];
  providers: Record<string, ProviderStatus>;
  providerMeta: Record<string, ProviderMeta>;  // ✅ From backend, not hardcoded

  // Agents
  agents: AgentData[];

  // LaTeX
  latexSettings: Record<string, unknown>;
  selectOptions: Record<string, Array<{ value: string; label: string }>>;

  // Memory
  memoryFiles: MemoryFile[];
  memoryEnabled: boolean;

  // History
  historyItems: unknown[];

  // UI
  confirmDialog: ConfirmDialogConfig | null;
}

export const state = reactive<SettingsState>({
  activeTab: 'models',
  account: { authenticated: false },
  models: [],
  enabledModels: [],
  recommendedModels: [],
  providers: {},
  providerMeta: {},
  agents: [],
  latexSettings: {},
  selectOptions: {},
  memoryFiles: [],
  memoryEnabled: true,
  historyItems: [],
  confirmDialog: null,
});

// Update from initial data
export function updateFromInitialData(data: SettingsInitialData) {
  if (data.selectedTab) {
    state.activeTab = data.selectedTab;
  }
  state.account = data.account;
  state.models = data.models;
  state.enabledModels = data.enabledModels;
  state.providers = data.providers;
  state.providerMeta = data.providerMeta;  // ✅ From backend
  state.agents = data.agents;
  state.latexSettings = data.latexSettings;
  state.selectOptions = data.selectOptions;
  state.historyItems = data.historyItems;  // ✅ Don't forget
  state.memoryFiles = data.memoryFiles;    // ✅ Don't forget
  state.memoryEnabled = data.memoryEnabled;

  // Derive recommended models
  state.recommendedModels = state.models.filter(m =>
    RECOMMENDED_MODEL_IDS.includes(m.id)
  );
}

// Show confirmation dialog
export function showConfirmDialog(config: ConfirmDialogConfig) {
  state.confirmDialog = config;
}

export function hideConfirmDialog() {
  state.confirmDialog = null;
}
```

---

## Tab Specifications

### Models Tab

**Purpose:** Combined model selection and API provider configuration.

**Storage:** `globalState.enabledModels: string[]`, `globalState.providerConfig`

### Agents Tab

**Purpose:** View and enable/disable agents, plus agent-specific settings.

**Storage:** `workspaceState.enabledAgents: string[]`, VS Code configuration

### LaTeX Tab

**Purpose:** Configure LaTeX formatting, latexdiff, and TikZ settings.

**Settings Groups:**

| Group | Settings |
|-------|----------|
| **Formatter** | `texra.latex.formatter`, `latexindentConfig`, `texfmtConfig`, `showLatexindentWarning` |
| **LaTeXdiff** | `texra.latexdiff.mathMarkup`, `timeoutMs`, `pictureEnvironments`, `generateBetweenRoundDiffs` |
| **TikZ Figures** | `texra.latex.tikzInputDirectory`, `includeWorkspaceInTexinputs`, `tikzTemplate` |
| **Replacements** | `texra.latex.wrapCritiqueInAlign`, `enabledReplacements`, `enabledReplacementsRegex` |

### Memory Tab

**Purpose:** Browse and manage memory files created by tool-use agents.

**Features:**
- Memory file browser with lazy-loaded content preview
- Click to expand and show content (fetched on demand)
- [View Full] opens file in editor
- [Delete] removes file with confirmation

### History Tab

**Purpose:** Browse and restore previous agent executions.

**Features:**
- Search with highlighting
- Delete, Restore, Rerun actions
- Collapsible details per item

---

## State Management

### VS Code Configuration (Primary)

Settings View reads/writes directly to VS Code configuration:

```typescript
const config = vscode.workspace.getConfiguration('texra');

// Global settings (user-level)
await config.update('models', enabledModels, ConfigurationTarget.Global);

// Workspace settings (.vscode/settings.json)
await config.update('agents', enabledAgents, ConfigurationTarget.Workspace);
```

### Secret Storage

API keys use VS Code SecretStorage:

```typescript
// Access via SecretManager
SecretManager.getApiKey('anthropic');
SecretManager.setApiKey('anthropic', 'sk-...');
```

---

## Implementation Phases

Settings View is implemented as part of **Phase 4** of the ProgressView modernization, consolidating three existing webviews (HistoryView, ProfileView, MemoryView) into a unified interface.

### ProgressView Modernization Status

| Phase       | Scope                                        | Status         |
| ----------- | -------------------------------------------- | -------------- |
| **Phase 1** | Schema relocation to `src/shared/schemas/`   | ✅ Complete    |
| **Phase 2** | Extract shared infrastructure                | ✅ Complete    |
| **Phase 3** | ProgressView stabilization + native Lit      | 🟡 In Progress |
| **Phase 4** | Migrate other webviews (including Settings)  | ⬜ Not Started |

### Phase 3 Sub-Status (Prerequisites for Settings View)

| Sub-Phase | Scope                      | Status                         |
| --------- | -------------------------- | ------------------------------ |
| 3a        | JS → TS shared utilities   | ✅ Complete                    |
| 3b-1      | UI parity/stabilization    | ✅ Complete                    |
| 3b-1.5/6  | CSS Shadow DOM migration   | ✅ Complete (11/13 components) |
| 3b-2      | Utility conversion         | ⬜ Not Started                 |
| 3b-3      | Formatter → TemplateResult | ⬜ Not Started                 |

**Settings View can begin once Phase 3b-1 is complete** (current status: ready).

### Anti-Patterns to Avoid

The legacy codebase has accumulated band-aid workarounds. **These must not be replicated in Settings View:**

| Pattern                 | Example                        | Problem                               |
| ----------------------- | ------------------------------ | ------------------------------------- |
| Render-state comparison | `lastRenderedStream`           | Duplicates state for change detection |
| Pending ID buffers      | `_pendingActiveId`             | Two sources of truth, race conditions |
| Global mutable maps     | `pendingLogUpdates`            | Memory leaks, race conditions         |
| Scattered conditionals  | 18× `isToolUse` checks         | Logic spread across 1000+ lines       |
| Manual state wipes      | `_clearAgentCategoryState()`   | Shotgun surgery on mode switch        |

**See [Phase 2 Anti-Patterns](../prd-progressview-phase2.md#anti-patterns-to-avoid) for detailed analysis and Lit solutions.**

### Zod-First Architecture Benefits

The migration to Zod schemas as single source of truth eliminates normalizer layers:

```
BEFORE (5 layers):
  message → normalize() → NormalizedPayload → buildRender() → HTML

AFTER (2 layers):
  message.data → Schema.safeParse() → buildRender() → HTML
```

**Key insight:** Zod schemas eliminate the need for separate "normalizer" layers:
- Validation returns typed data directly
- `.prefault()` / `.default()` handle missing fields
- `.transform()` handles computed fields when needed
- Formatters receive validated, typed data - no intermediate types needed

### Settings View Implementation Steps

#### Step 1: Schema Setup
- Add settings-specific schemas to `src/shared/schemas/settings.ts`
- Add commands to `src/shared/schemas/commands.ts`
- No duplicate definitions - leverage existing 60+ Zod schemas

#### Step 2: Backend Handlers
- Create `SettingsViewMessageHandler.ts` with domain-specific handler classes
- Use registry pattern (`Record<string, Handler>`) instead of switch statements
- Validate all messages with Zod schemas using `safeParse()`

#### Step 3: Lit Frontend
- Create `src/settingsView/frontend/` with Lit components
- Follow native Lit patterns (Shadow DOM, static styles array, arrow handlers)
- Implement reactive store with `@lit-labs/preact-signals`
- Build all 5 tab components

#### Step 4: Delete Legacy Views
- Remove `src/profileView/` (636 lines JS)
- Remove `src/historyView/` (610 lines JS)
- Remove `src/memoryView/` (305 lines JS)
- Update command redirects to Settings View
- Delete legacy `constants.js` files (102 lines total)

---

## Lessons Learned (PR #2206 Review)

Based on code review feedback from the initial vanilla JS implementation attempt, the following issues were identified. **The Lit+TypeScript architecture solves many of these automatically.**

### Critical: Single Source of Truth Violations

#### Command Constants Duplication

**Problem:** Commands defined in multiple files (schemas.ts, constants.js, commands.ts).

**Lit Architecture Solution:**
- Commands defined ONCE in `src/shared/schemas/commands.ts`
- TypeScript imports everywhere - no JavaScript constants.js needed
- Webpack bundles ensure single definition

#### Provider Metadata Duplication

**Problem:** `PROVIDER_META` defined in both TypeScript and JavaScript.

**Lit Architecture Solution:**
- Define ONCE in backend (`SettingsViewMessageHandler.ts`)
- Send to frontend via `InitialData.providerMeta`
- Store in reactive state: `state.providerMeta`
- Components access from state, not hardcoded constants

---

### Security Issues

#### XSS Vulnerability in HTML Rendering

**Problem:** Template literals directly interpolate user data.

**Lit Architecture Solution:**
- Lit automatically escapes interpolated values in templates
- `html\`<span>${userInput}</span>\`` is safe by default
- No manual `escapeHtml()` needed for standard cases

```typescript
// ✅ SAFE in Lit - automatic escaping
render() {
  return html`<span class="file-name">${this.file.name}</span>`;
}
```

#### Path Traversal in Memory Operations

**Problem:** File paths from webview used directly without validation.

**Solution (still required):** Validate paths in backend handlers:
```typescript
import { resolveMemoryStoragePath } from '@tools/memory/memoryStorage';

async ({ path: storagePath }) => {
  const resolvedPath = resolveMemoryStoragePath(storagePath);
  if (!resolvedPath) {
    this.logger.warn('Invalid memory path attempted:', storagePath);
    return;
  }
  // Proceed with validated path
}
```

#### Unvalidated Setting Keys

**Problem:** `settingKey` parameter accepted any string.

**Solution:** Whitelist allowed keys in Zod schema:
```typescript
export const SaveSettingActionSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SAVE_SETTING),
  key: z.enum([
    'texra.latex.formatter',
    'texra.latexdiff.mathMarkup',
    // ... explicit whitelist
  ]),
  value: z.unknown(),
});
```

---

### Missing Functionality

#### Missing Command Handlers

**Problem:** Commands defined but handlers not implemented.

**Lit Architecture Solution:**
- TypeScript ensures type safety
- Create handler interface that requires all commands:
```typescript
type SettingsHandlers = {
  [K in SettingsViewCommand]: MessageHandler;
};

// TypeScript error if any command missing
const handlers: SettingsHandlers = {
  [SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA]: this.handleGetInitialData,
  [SETTINGS_VIEW_COMMANDS.BROWSE_AGENTS_DIRECTORY]: this.handleBrowseAgentsDir,
  // ... must implement ALL commands
};
```

#### Memory/History Data Not in Initial Load

**Problem:** Tabs empty on first load because data wasn't included.

**Solution:** Schema enforces required fields:
```typescript
export const SettingsInitialDataSchema = z.object({
  // ...
  historyItems: z.array(z.unknown()),  // Required, not optional
  memoryFiles: z.array(MemoryFileSchema),  // Required, not optional
});
```

#### Tab Selection Not Applied

**Problem:** Requested tab ignored when opening Settings View.

**Solution:** Handle in `updateFromInitialData()`:
```typescript
export function updateFromInitialData(data: SettingsInitialData) {
  if (data.selectedTab) {
    state.activeTab = data.selectedTab;  // ✅ Apply tab
  }
  // ... rest of state updates
}
```

---

### UX Issues

#### Missing Confirmation Dialogs

**Problem:** Destructive actions executed without user confirmation.

**Lit Architecture Solution:** Centralized confirm dialog component:
```typescript
// In store
export function showConfirmDialog(config: ConfirmDialogConfig) {
  state.confirmDialog = config;
}

// In component
private _clearAllMemory() {
  showConfirmDialog({
    title: 'Delete All Memory Files',
    message: 'This cannot be undone. Are you sure?',
    confirmLabel: 'Delete All',
    onConfirm: () => {
      vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.CLEAR_ALL_MEMORY });
    },
  });
}
```

---

### Data Consistency Issues

#### Inconsistent Default Values

**Problem:** Defaults differed between UI and execution code.

**Solution:** Define defaults in schemas using `.default()`:
```typescript
// src/shared/schemas/settings.ts
export const MathMarkupSchema = z.enum(['off', 'whole', 'coarse', 'fine']).default('coarse');

// Usage everywhere
const mathMarkup = MathMarkupSchema.parse(rawValue);  // Gets default if undefined
```

#### Provider ID Case Mismatch

**Problem:** `openRouter` vs `openrouter` causing lookup failures.

**Solution:** Zod schema enforces consistent casing:
```typescript
export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'openrouter',  // ✅ Lowercase only
  // ...
]);
```

---

### Architecture Improvements

#### Large MessageHandler Class

**Problem:** 1000+ line handler file.

**Solution:** Extract domain-specific handler classes:
```
src/settingsView/
├── SettingsViewMessageHandler.ts  # ~200 lines, orchestrates
├── handlers/
│   ├── ModelHandlers.ts           # Model/provider operations
│   ├── AgentHandlers.ts           # Agent CRUD
│   ├── LatexHandlers.ts           # LaTeX settings
│   ├── HistoryHandlers.ts         # History operations
│   └── MemoryHandlers.ts          # Memory file operations
```

#### Performance: Lazy Loading

**Problem:** Loading all memory file previews could be slow.

**Solution:** Lazy load on expand:
```typescript
// Initial load: metadata only (no preview)
// On expand: fetch preview via GET_MEMORY_PREVIEW command
@customElement('memory-item')
class MemoryItem extends LitElement {
  @property() file!: MemoryFile;
  @state() private _expanded = false;
  @state() private _preview?: string;

  private async _expand() {
    this._expanded = true;
    if (!this._preview) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
        path: this.file.path,
      });
    }
  }
}
```

---

## Detailed Component Specifications

This section provides comprehensive Lit component specifications for each part of the Settings View. Components are organized hierarchically with clear props, state, events, and patterns derived from existing views.

### Component Hierarchy Overview

```
<settings-app>                          # Root orchestrator
├── <header-bar>                        # Account status + actions
├── <texra-tabs>                        # Shared tab container
│   ├── <models-tab>
│   │   ├── <routing-options>           # Direct/OpenRouter/Proxy radio
│   │   ├── <recommended-section>       # Curated model list
│   │   └── <provider-accordion>*       # Per-provider collapsible
│   │       ├── <provider-header>       # Status badge + Configure
│   │       └── <model-checkbox>*       # Individual model toggle
│   │
│   ├── <agents-tab>
│   │   ├── <agent-list section="builtIn">
│   │   ├── <agent-list section="toolUse">
│   │   ├── <agent-list section="custom">
│   │   ├── <agent-settings-group title="Workflow">
│   │   └── <agent-settings-group title="Tool-Use">
│   │
│   ├── <latex-tab>
│   │   ├── <settings-group title="Formatter">
│   │   ├── <settings-group title="LaTeXdiff">
│   │   ├── <settings-group title="TikZ Figures">
│   │   └── <settings-group title="Replacements">
│   │
│   ├── <memory-tab>
│   │   ├── <memory-toolbar>            # Search + Clear All
│   │   └── <memory-tree>               # Recursive file tree
│   │       └── <memory-item>*          # Individual file/folder
│   │
│   └── <history-tab>
│       ├── <history-toolbar>           # Search + Clear All
│       └── <history-list>
│           └── <history-item>*         # Individual execution
│
└── <confirm-dialog>                    # Modal overlay
```

### Shared Components (from `src/shared/components/`)

These components are reusable across all webviews, extracted during Phase 2 of ProgressView modernization.

#### `<texra-tabs>`

Tab container with VS Code styling.

```typescript
@customElement('texra-tabs')
export class TexraTabs extends LitElement {
  @property({ type: Array }) tabs: string[] = [];
  @property() activeTab: string = '';

  // Events
  @event() 'tab-change': CustomEvent<{ tab: string }>;

  render() {
    return html`
      <div class="tab-bar" role="tablist">
        ${this.tabs.map(tab => html`
          <button
            role="tab"
            class=${classMap({ active: tab === this.activeTab })}
            @click=${() => this._selectTab(tab)}
          >
            ${this._formatTabLabel(tab)}
          </button>
        `)}
      </div>
      <div class="tab-content">
        <slot name=${this.activeTab}></slot>
      </div>
    `;
  }
}
```

#### `<texra-collapsible>`

Accordion section with header and expandable content.

```typescript
@customElement('texra-collapsible')
export class TexraCollapsible extends LitElement {
  @property() title: string = '';
  @property({ type: Boolean }) open: boolean = false;

  render() {
    return html`
      <div class="collapsible ${this.open ? 'open' : ''}">
        <button class="header" @click=${this._toggle}>
          <span class="chevron">${this.open ? '▼' : '▶'}</span>
          <span class="title">${this.title}</span>
          <slot name="header-extra"></slot>
        </button>
        ${this.open ? html`<div class="content"><slot></slot></div>` : ''}
      </div>
    `;
  }
}
```

#### `<texra-confirm-dialog>`

Modal confirmation dialog.

```typescript
@customElement('texra-confirm-dialog')
export class TexraConfirmDialog extends LitElement {
  @property({ type: Boolean }) open: boolean = false;
  @property() title: string = '';
  @property() message: string = '';
  @property() confirmLabel: string = 'Confirm';
  @property() cancelLabel: string = 'Cancel';
  @property({ type: Boolean }) destructive: boolean = false;

  // Events
  @event() 'confirm': CustomEvent<void>;
  @event() 'cancel': CustomEvent<void>;
}
```

### `<header-bar>` Component

Account status and actions, migrated from Profile View.

```typescript
// src/settingsView/frontend/components/HeaderBar.ts
@customElement('header-bar')
export class HeaderBar extends LitElement {
  static styles = css`
    :host {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }

    .account-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tier-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }

    .actions {
      display: flex;
      gap: 8px;
    }
  `;

  // Props from parent
  @property({ type: Boolean }) authenticated = false;
  @property() email?: string;
  @property() tier?: 'free' | 'Max' | 'Ultra';
  @property({ type: Boolean }) useIncludedAccess = false;

  render() {
    if (!this.authenticated) {
      return html`
        <div class="account-info">
          <span>Not signed in</span>
        </div>
        <div class="actions">
          <vscode-button @click=${this._signIn}>Sign In</vscode-button>
        </div>
      `;
    }

    return html`
      <div class="account-info">
        <span class="codicon codicon-account"></span>
        <span>${this.email}</span>
        ${this.tier ? html`<span class="tier-badge">${this.tier}</span>` : ''}
      </div>
      <div class="actions">
        ${this._renderAccessToggle()}
        <vscode-button appearance="secondary" @click=${this._manage}>
          Manage
        </vscode-button>
        <vscode-button appearance="secondary" @click=${this._signOut}>
          Sign Out
        </vscode-button>
      </div>
    `;
  }

  private _renderAccessToggle() {
    // Only show for paid tiers
    if (this.tier === 'free') return '';

    return html`
      <label class="access-toggle">
        <input
          type="checkbox"
          ?checked=${this.useIncludedAccess}
          @change=${this._toggleAccess}
        />
        Use included API access
      </label>
    `;
  }

  private _signIn() {
    vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN });
  }

  private _signOut() {
    vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT });
  }

  private _manage() {
    vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.OPEN_ACCOUNT_PORTAL });
  }

  private _toggleAccess(e: Event) {
    const checked = (e.target as HTMLInputElement).checked;
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      useIncludedAccess: checked,
    });
  }
}
```

### `<models-tab>` Component

Model selection and provider configuration.

**Data Flow:**
```
MODEL_CONFIGS (backend)          →  InitialData.models
SecretManager.hasKey(provider)   →  InitialData.providers[id].hasKey
getModelMetadata(provider)       →  InitialData.providerMeta[id]
globalState.enabledModels        →  InitialData.enabledModels
```

```typescript
// src/settingsView/frontend/components/ModelsTab.ts
@customElement('models-tab')
export class ModelsTab extends LitElement {
  @property({ type: Object }) state!: SettingsState;

  // Derived state - computed when state changes
  private get _modelsByProvider(): Map<ProviderId, ModelData[]> {
    const map = new Map<ProviderId, ModelData[]>();
    for (const model of this.state.models) {
      const list = map.get(model.provider) || [];
      list.push(model);
      map.set(model.provider, list);
    }
    return map;
  }

  render() {
    return html`
      <section class="routing-section">
        <h3>API Routing</h3>
        <routing-options
          .mode=${this.state.routingMode}
          @mode-change=${this._onRoutingChange}
        ></routing-options>
      </section>

      <section class="recommended-section">
        <h3>Recommended Models</h3>
        <p class="hint">These models are known to work well with TeXRA.</p>
        ${this._renderModelList(this.state.recommendedModels)}
      </section>

      <section class="all-providers">
        <h3>All Providers</h3>
        ${Array.from(this._modelsByProvider.entries()).map(
          ([providerId, models]) => html`
            <provider-accordion
              .providerId=${providerId}
              .models=${models}
              .meta=${this.state.providerMeta[providerId]}
              .status=${this.state.providers[providerId]}
              .enabledModels=${this.state.enabledModels}
              @model-toggle=${this._onModelToggle}
              @configure=${this._onConfigureProvider}
            ></provider-accordion>
          `
        )}
      </section>
    `;
  }

  private _onModelToggle(e: CustomEvent<{ modelId: string; enabled: boolean }>) {
    const { modelId, enabled } = e.detail;
    const newEnabled = enabled
      ? [...this.state.enabledModels, modelId]
      : this.state.enabledModels.filter(id => id !== modelId);

    // Optimistic update
    this.state.enabledModels = newEnabled;

    // Persist
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_ENABLED_MODELS,
      models: newEnabled,
    });
  }

  private _onConfigureProvider(e: CustomEvent<{ providerId: ProviderId }>) {
    const { providerId } = e.detail;
    const meta = this.state.providerMeta[providerId];

    // Show API key input dialog
    showApiKeyDialog({
      provider: providerId,
      providerName: meta.name,
      keyUrl: meta.keyUrl,
      envVar: meta.envVar,
      onSubmit: (key) => {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.SET_API_KEY,
          provider: providerId,
          key,
        });
      },
    });
  }
}
```

### `<agents-tab>` Component

Agent management and settings, consolidating agent dropdown and settings.

**Data Flow:**
```
agentRegistry.getAllAgents()     →  InitialData.agents
workspaceState.enabledAgents     →  (filter which are enabled)
Custom YAML files                →  source: 'custom'
```

```typescript
// src/settingsView/frontend/components/AgentsTab.ts
@customElement('agents-tab')
export class AgentsTab extends LitElement {
  @property({ type: Object }) state!: SettingsState;

  // Group agents by source
  private get _builtInAgents() {
    return this.state.agents.filter(a => a.source === 'builtIn');
  }

  private get _toolUseAgents() {
    return this.state.agents.filter(a => a.source === 'builtInToolUse');
  }

  private get _customAgents() {
    return this.state.agents.filter(a => a.source === 'custom');
  }

  render() {
    return html`
      <section class="agent-section">
        <h3>Built-in Agents</h3>
        <p class="hint">Standard agents for common tasks.</p>
        <agent-list
          .agents=${this._builtInAgents}
          @toggle=${this._onAgentToggle}
          @view-source=${this._onViewSource}
        ></agent-list>
      </section>

      <section class="agent-section">
        <h3>Tool-Use Agents</h3>
        <p class="hint">Agents with autonomous tool execution.</p>
        <agent-list
          .agents=${this._toolUseAgents}
          @toggle=${this._onAgentToggle}
          @view-source=${this._onViewSource}
        ></agent-list>
      </section>

      <section class="agent-section">
        <h3>Custom Agents</h3>
        <p class="hint">User-defined agents from YAML files.</p>
        <div class="custom-actions">
          <vscode-button @click=${this._browseAgentsDir}>
            Browse Directory
          </vscode-button>
          <vscode-button appearance="secondary" @click=${this._openAgentsDir}>
            Open in Explorer
          </vscode-button>
        </div>
        <agent-list
          .agents=${this._customAgents}
          ?showDelete=${true}
          @toggle=${this._onAgentToggle}
          @view-source=${this._onViewSource}
          @delete=${this._onDeleteAgent}
        ></agent-list>
      </section>

      <texra-collapsible title="Workflow Settings">
        <settings-group
          .settings=${WORKFLOW_SETTINGS}
          .values=${this.state.latexSettings}
          @change=${this._onSettingChange}
        ></settings-group>
      </texra-collapsible>

      <texra-collapsible title="Tool-Use Settings">
        <settings-group
          .settings=${TOOL_USE_SETTINGS}
          .values=${this.state.latexSettings}
          @change=${this._onSettingChange}
        ></settings-group>
      </texra-collapsible>
    `;
  }

  private _onDeleteAgent(e: CustomEvent<{ agent: AgentData }>) {
    const { agent } = e.detail;
    showConfirmDialog({
      title: 'Delete Agent',
      message: `Delete custom agent "${agent.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        vscode.postMessage({
          command: SETTINGS_VIEW_COMMANDS.DELETE_AGENT,
          name: agent.name,
        });
      },
    });
  }
}
```

### `<memory-tab>` Component

Memory file browser, migrated from Memory View.

**Data Flow:**
```
memoryStorage.getFiles()         →  InitialData.memoryFiles (tree structure)
globalState.memoryEnabled        →  InitialData.memoryEnabled
```

**Key Pattern:** Lazy-load file previews on expand.

```typescript
// src/settingsView/frontend/components/MemoryTab.ts
@customElement('memory-tab')
export class MemoryTab extends LitElement {
  @property({ type: Object }) state!: SettingsState;
  @state() private _searchQuery = '';
  @state() private _expandedPaths = new Set<string>();
  @state() private _loadedPreviews = new Map<string, string>();

  render() {
    return html`
      <div class="toolbar">
        <vscode-text-field
          placeholder="Search memory files..."
          .value=${this._searchQuery}
          @input=${this._onSearchInput}
        >
          <span slot="start" class="codicon codicon-search"></span>
        </vscode-text-field>

        <vscode-button
          appearance="secondary"
          ?disabled=${this.state.memoryFiles.length === 0}
          @click=${this._clearAll}
        >
          Clear All
        </vscode-button>
      </div>

      ${this.state.memoryFiles.length === 0
        ? html`<div class="empty-state">No memory files yet.</div>`
        : html`
            <div class="memory-tree">
              ${this._renderTree(this._filteredFiles)}
            </div>
          `}
    `;
  }

  private get _filteredFiles(): MemoryFile[] {
    if (!this._searchQuery) return this.state.memoryFiles;
    const query = this._searchQuery.toLowerCase();
    return this._filterTree(this.state.memoryFiles, query);
  }

  private _renderTree(files: MemoryFile[]): TemplateResult {
    return html`
      ${repeat(
        files,
        (f) => f.path,
        (file) => html`
          <memory-item
            .file=${file}
            .expanded=${this._expandedPaths.has(file.path)}
            .preview=${this._loadedPreviews.get(file.path)}
            @expand=${() => this._expand(file)}
            @collapse=${() => this._collapse(file)}
            @open=${() => this._openFile(file)}
            @delete=${() => this._deleteFile(file)}
          >
            ${file.children && this._expandedPaths.has(file.path)
              ? this._renderTree(file.children)
              : ''}
          </memory-item>
        `
      )}
    `;
  }

  private async _expand(file: MemoryFile) {
    this._expandedPaths = new Set([...this._expandedPaths, file.path]);

    // Lazy load preview if not already loaded
    if (!file.isDirectory && !this._loadedPreviews.has(file.path)) {
      vscode.postMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
        path: file.path,
      });
    }
  }

  private _clearAll() {
    showConfirmDialog({
      title: 'Clear All Memory Files',
      message: 'This will delete all memory files. This action cannot be undone.',
      confirmLabel: 'Delete All',
      destructive: true,
      onConfirm: () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.CLEAR_ALL_MEMORY });
      },
    });
  }
}
```

### `<history-tab>` Component

Execution history browser, migrated from History View.

**Data Flow:**
```
stateTracker.getHistory()        →  InitialData.historyItems
```

**Key Patterns:**
- Search with highlighting
- Collapsible details per item
- Actions: Rerun, Restore, Delete

```typescript
// src/settingsView/frontend/components/HistoryTab.ts
@customElement('history-tab')
export class HistoryTab extends LitElement {
  @property({ type: Object }) state!: SettingsState;
  @state() private _searchQuery = '';
  @state() private _expandedIds = new Set<string>();

  render() {
    return html`
      <div class="toolbar">
        <vscode-text-field
          placeholder="Search history..."
          .value=${this._searchQuery}
          @input=${(e: Event) => {
            this._searchQuery = (e.target as HTMLInputElement).value;
          }}
        >
          <span slot="start" class="codicon codicon-search"></span>
        </vscode-text-field>

        <vscode-button
          appearance="secondary"
          ?disabled=${this.state.historyItems.length === 0}
          @click=${this._clearAll}
        >
          Clear All
        </vscode-button>
      </div>

      ${this.state.historyItems.length === 0
        ? html`<div class="empty-state">No execution history yet.</div>`
        : html`
            <div class="history-list">
              ${repeat(
                this._filteredItems,
                (item: any) => item.id,
                (item) => this._renderItem(item)
              )}
            </div>
          `}
    `;
  }

  private _renderItem(item: HistoryItem) {
    const expanded = this._expandedIds.has(item.id);

    return html`
      <div class="history-item ${expanded ? 'expanded' : ''}">
        <div class="item-header" @click=${() => this._toggleExpand(item.id)}>
          <span class="chevron">${expanded ? '▼' : '▶'}</span>
          <span class="agent-name">${item.agentName}</span>
          <span class="timestamp">${this._formatTime(item.timestamp)}</span>
          <span class="model">${item.modelId}</span>
        </div>

        ${expanded ? html`
          <div class="item-details">
            <div class="input-preview">
              <strong>Input:</strong>
              ${this._highlightSearch(item.inputPreview)}
            </div>
            <div class="output-preview">
              <strong>Output:</strong>
              ${this._highlightSearch(item.outputPreview)}
            </div>
            <div class="actions">
              <vscode-button @click=${() => this._rerun(item)}>
                <span class="codicon codicon-debug-restart"></span> Rerun
              </vscode-button>
              <vscode-button @click=${() => this._restore(item)}>
                <span class="codicon codicon-history"></span> Restore
              </vscode-button>
              <vscode-button appearance="secondary" @click=${() => this._delete(item)}>
                <span class="codicon codicon-trash"></span>
              </vscode-button>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  private _highlightSearch(text: string): TemplateResult {
    if (!this._searchQuery) return html`${text}`;

    const parts = text.split(new RegExp(`(${this._escapeRegex(this._searchQuery)})`, 'gi'));
    return html`${parts.map(part =>
      part.toLowerCase() === this._searchQuery.toLowerCase()
        ? html`<mark>${part}</mark>`
        : part
    )}`;
  }

  private _clearAll() {
    showConfirmDialog({
      title: 'Clear All History',
      message: 'This will delete all execution history. This action cannot be undone.',
      confirmLabel: 'Clear History',
      destructive: true,
      onConfirm: () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.CLEAR_HISTORY });
      },
    });
  }
}
```

### `<latex-tab>` Component

LaTeX settings organized in collapsible groups.

**Data Flow:**
```
vscode.workspace.getConfiguration('texra.latex')     →  InitialData.latexSettings
generateDropdownOptions()                            →  InitialData.selectOptions
```

```typescript
// src/settingsView/frontend/components/LatexTab.ts

// Setting definitions - single source of truth for UI
const FORMATTER_SETTINGS: SettingDef[] = [
  {
    key: 'texra.latex.formatter',
    label: 'Formatter',
    type: 'select',
    options: 'formatter',  // References selectOptions.formatter
    description: 'LaTeX code formatter to use',
  },
  {
    key: 'texra.latex.latexindentConfig',
    label: 'latexindent Config',
    type: 'file',
    filter: { yaml: ['yml', 'yaml'] },
    description: 'Custom latexindent configuration file',
  },
  // ... more settings
];

const LATEXDIFF_SETTINGS: SettingDef[] = [
  {
    key: 'texra.latexdiff.mathMarkup',
    label: 'Math Markup',
    type: 'select',
    options: 'mathMarkup',
    default: 'coarse',
  },
  {
    key: 'texra.latexdiff.timeoutMs',
    label: 'Timeout (ms)',
    type: 'number',
    min: 1000,
    max: 60000,
    default: 10000,
  },
  // ... more settings
];

@customElement('latex-tab')
export class LatexTab extends LitElement {
  @property({ type: Object }) state!: SettingsState;

  render() {
    return html`
      <texra-collapsible title="Formatter" open>
        <settings-group
          .settings=${FORMATTER_SETTINGS}
          .values=${this.state.latexSettings}
          .selectOptions=${this.state.selectOptions}
          @change=${this._onSettingChange}
          @browse=${this._onBrowseFile}
        ></settings-group>
      </texra-collapsible>

      <texra-collapsible title="LaTeXdiff">
        <settings-group
          .settings=${LATEXDIFF_SETTINGS}
          .values=${this.state.latexSettings}
          .selectOptions=${this.state.selectOptions}
          @change=${this._onSettingChange}
        ></settings-group>
      </texra-collapsible>

      <texra-collapsible title="TikZ Figures">
        <settings-group
          .settings=${TIKZ_SETTINGS}
          .values=${this.state.latexSettings}
          .selectOptions=${this.state.selectOptions}
          @change=${this._onSettingChange}
          @browse=${this._onBrowseFile}
        ></settings-group>
      </texra-collapsible>

      <texra-collapsible title="Replacements (Advanced)">
        <settings-group
          .settings=${REPLACEMENT_SETTINGS}
          .values=${this.state.latexSettings}
          .selectOptions=${this.state.selectOptions}
          @change=${this._onSettingChange}
        ></settings-group>
      </texra-collapsible>
    `;
  }

  private _onSettingChange(e: CustomEvent<{ key: string; value: unknown }>) {
    const { key, value } = e.detail;

    // Optimistic update
    this.state.latexSettings = {
      ...this.state.latexSettings,
      [key]: value,
    };

    // Persist
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.SAVE_SETTING,
      key,
      value,
    });
  }

  private _onBrowseFile(e: CustomEvent<{ key: string; filter: object }>) {
    const { key, filter } = e.detail;
    vscode.postMessage({
      command: SETTINGS_VIEW_COMMANDS.BROWSE_FILE,
      settingKey: key,
      filter,
    });
  }
}
```

### `<settings-group>` Reusable Component

Generic settings renderer that handles different input types.

```typescript
// src/settingsView/frontend/components/SettingsGroup.ts
interface SettingDef {
  key: string;
  label: string;
  type: 'select' | 'checkbox' | 'text' | 'number' | 'file';
  options?: string;  // Key in selectOptions
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
  filter?: Record<string, string[]>;
}

@customElement('settings-group')
export class SettingsGroup extends LitElement {
  @property({ type: Array }) settings: SettingDef[] = [];
  @property({ type: Object }) values: Record<string, unknown> = {};
  @property({ type: Object }) selectOptions: Record<string, SelectOption[]> = {};

  render() {
    return html`
      <div class="settings-list">
        ${this.settings.map(setting => this._renderSetting(setting))}
      </div>
    `;
  }

  private _renderSetting(setting: SettingDef) {
    const value = this.values[setting.key] ?? setting.default;

    return html`
      <div class="setting-row">
        <label for=${setting.key}>${setting.label}</label>
        ${setting.description
          ? html`<p class="description">${setting.description}</p>`
          : ''}
        ${this._renderInput(setting, value)}
      </div>
    `;
  }

  private _renderInput(setting: SettingDef, value: unknown) {
    switch (setting.type) {
      case 'select':
        const options = this.selectOptions[setting.options!] || [];
        return html`
          <vscode-dropdown
            id=${setting.key}
            .value=${String(value ?? '')}
            @change=${(e: Event) => this._onChange(setting.key, (e.target as any).value)}
          >
            ${options.map(opt => html`
              <vscode-option value=${opt.value}>${opt.label}</vscode-option>
            `)}
          </vscode-dropdown>
        `;

      case 'checkbox':
        return html`
          <vscode-checkbox
            id=${setting.key}
            ?checked=${Boolean(value)}
            @change=${(e: Event) => this._onChange(setting.key, (e.target as any).checked)}
          ></vscode-checkbox>
        `;

      case 'number':
        return html`
          <vscode-text-field
            id=${setting.key}
            type="number"
            .value=${String(value ?? '')}
            min=${setting.min}
            max=${setting.max}
            @change=${(e: Event) => this._onChange(setting.key, Number((e.target as any).value))}
          ></vscode-text-field>
        `;

      case 'file':
        return html`
          <div class="file-input">
            <vscode-text-field
              id=${setting.key}
              .value=${String(value ?? '')}
              readonly
            ></vscode-text-field>
            <vscode-button @click=${() => this._onBrowse(setting)}>
              Browse
            </vscode-button>
          </div>
        `;

      default:
        return html`
          <vscode-text-field
            id=${setting.key}
            .value=${String(value ?? '')}
            @change=${(e: Event) => this._onChange(setting.key, (e.target as any).value)}
          ></vscode-text-field>
        `;
    }
  }

  private _onChange(key: string, value: unknown) {
    this.dispatchEvent(new CustomEvent('change', {
      detail: { key, value },
      bubbles: true,
      composed: true,
    }));
  }

  private _onBrowse(setting: SettingDef) {
    this.dispatchEvent(new CustomEvent('browse', {
      detail: { key: setting.key, filter: setting.filter },
      bubbles: true,
      composed: true,
    }));
  }
}
```

---

## How Lit + Zod + TypeScript Simplifies Development

This section explains concrete benefits of the Lit architecture for Settings View.

### 1. Type-Safe Message Passing

**Problem with vanilla JS:** Runtime errors when message shapes don't match.

**Lit + Zod solution:**

```typescript
// Shared schema (both sides import)
export const SaveSettingMessageSchema = z.object({
  command: z.literal(SETTINGS_VIEW_COMMANDS.SAVE_SETTING),
  key: AllowedSettingKeySchema,  // Whitelist
  value: z.unknown(),
});

// Backend handler with validation
this.withValidatedMessage(SaveSettingMessageSchema, message, async (data) => {
  // data.key is typed as AllowedSettingKey
  await vscode.workspace.getConfiguration().update(data.key, data.value);
});

// Frontend - TypeScript ensures shape matches
vscode.postMessage({
  command: SETTINGS_VIEW_COMMANDS.SAVE_SETTING,  // TS error if wrong command
  key: 'texra.latex.formatter',  // TS error if not in whitelist
  value: 'latexindent',
});
```

### 2. Automatic XSS Protection

**Problem with vanilla JS:** Must manually escape all user data.

**Lit solution:** Auto-escaping by default.

```typescript
// ✅ SAFE - Lit escapes automatically
render() {
  return html`
    <span class="filename">${this.file.name}</span>
    <pre class="preview">${this.preview}</pre>
  `;
}

// Only use unsafeHTML for trusted content (markdown rendering)
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
render() {
  return html`${unsafeHTML(this.trustedMarkdownHtml)}`;
}
```

### 3. Reactive Updates Without Manual DOM

**Problem with vanilla JS:** Manual `querySelector`, `innerHTML`, event rebinding.

**Lit solution:** Declarative templates with automatic updates.

```typescript
@customElement('model-item')
class ModelItem extends LitElement {
  @property({ type: Boolean }) enabled = false;
  @property() name = '';

  // Template re-renders automatically when props change
  render() {
    return html`
      <input
        type="checkbox"
        ?checked=${this.enabled}
        @change=${this._toggle}
      />
      <span>${this.name}</span>
    `;
  }

  private _toggle() {
    // Dispatch event - parent handles state
    this.dispatchEvent(new CustomEvent('toggle', {
      detail: { enabled: !this.enabled },
    }));
  }
}
```

### 4. Single Source of Truth for Data

**Problem with vanilla JS:** State scattered across DOM, JS variables, backend.

**Lit + signals solution:** Centralized reactive store.

```typescript
// store.ts - single source of truth
export const state = reactive<SettingsState>({
  models: [],
  enabledModels: [],
  // ...
});

// Any component can access
@customElement('models-count')
class ModelsCount extends LitElement {
  render() {
    return html`${state.enabledModels.length} models enabled`;
  }
}

// Updates propagate automatically
state.enabledModels = [...state.enabledModels, 'new-model'];
// All components using state.enabledModels re-render
```

### 5. Component Composition

**Problem with vanilla JS:** Copy-paste HTML strings, inconsistent behavior.

**Lit solution:** Reusable components with typed props.

```typescript
// Define once
@customElement('texra-collapsible')
class Collapsible extends LitElement {
  @property() title = '';
  @property({ type: Boolean }) open = false;
  // ...
}

// Use everywhere with consistent behavior
html`
  <texra-collapsible title="Formatter" open>
    ${formatterContent}
  </texra-collapsible>

  <texra-collapsible title="LaTeXdiff">
    ${latexdiffContent}
  </texra-collapsible>
`;
```

---

## Native Lit Patterns Checklist

These patterns were established in ProgressView Phase 2-3. Settings View **MUST** follow them.

### Component Patterns

| Pattern | Requirement |
| ------- | ----------- |
| Shadow DOM | No `createRenderRoot()` override — use Lit default |
| Static styles | Use `static styles = [codiconStyles, animationStyles, css\`...\`]` array composition |
| Arrow functions | Use arrow functions for event handlers to preserve `this` binding |
| @property vs @state | `@property` for parent inputs, `@state` for internal state |
| @query | Use for imperative DOM access only; await `updateComplete` first |
| Reflected properties | Use `reflect: true` for CSS `:host([attr])` targeting |

### Message Handling Patterns

| Pattern | Requirement |
| ------- | ----------- |
| Registry pattern | Use `Record<string, Handler>` instead of switch statements |
| Zod validation | Validate at entry point with `safeParse()`, silent fail on error |
| Context interface | Pass `getState()`/`setState()` accessors, not direct state |

### Rendering Patterns

| Pattern | When to Use |
| ------- | ----------- |
| `nothing` | Element should be absent from DOM entirely |
| `?hidden` | Element stays in DOM but visually hidden |
| `repeat()` | Lists with stable keys (sorted/reordered) |
| `classMap()` | Dynamic CSS class bindings |
| `live()` | Textarea/input to preserve cursor position |
| `when()` | Conditional template blocks |
| `ifDefined()` | Optional attributes |

### Event Patterns

| Pattern | Requirement |
| ------- | ----------- |
| Custom events factory | Centralized event creation with typed details |
| bubbles + composed | All custom events must use `bubbles: true, composed: true` |
| Event naming | Use kebab-case: `item-select`, `filter-change` |

**Example:**

```typescript
// events.ts
function createEvent<T>(type: string, detail: T): CustomEvent<T> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}

export const SettingsEvents = {
  tabChange: (detail: { tab: SettingsTab }) => createEvent('tab-change', detail),
  modelToggle: (detail: { id: string; enabled: boolean }) => createEvent('model-toggle', detail),
  settingChange: (detail: { key: string; value: unknown }) => createEvent('setting-change', detail),
};
```

### CSS Patterns

| Pattern | Requirement |
| ------- | ----------- |
| Design tokens | Access via CSS custom properties (`var(--spacing-medium)`) |
| Shared styles | Import from `@shared/styles/litStyles.ts` |
| Codicon styles | Import `codiconStyles` for icon fonts |
| No external CSS | All component styles in `static styles` array |

---

## Implementation Checklist

Before merging Settings View implementation, verify:

### Single Source of Truth
- [ ] Commands defined ONLY in `src/shared/schemas/commands.ts`
- [ ] Provider metadata sent from backend via InitialData
- [ ] Default values defined in Zod schemas with `.default()`
- [ ] Provider IDs use consistent lowercase

### Security
- [ ] Memory file paths validated against storage root
- [ ] Setting keys whitelisted in Zod schema
- [ ] API keys use SecretManager (never in state/config)
- [ ] Lit handles XSS automatically (verify no `unsafeHTML` misuse)

### Completeness
- [ ] Every command in schema has a handler
- [ ] All tabs receive data in InitialData
- [ ] Tab selection from parameters applied
- [ ] API access mode toggle included (for paid users)
- [ ] All handlers call `withValidatedMessage()` with schema

### UX Safety
- [ ] Destructive actions use confirm dialog
- [ ] Error messages shown for failed operations
- [ ] Loading states for async operations

---

## References

### ProgressView Modernization PRDs
- **Overview:** `docs/prd-progressview-modernization.md`
- **Phase 1 (Schema relocation):** `docs/prd-progressview-phase1.md`
- **Phase 2 (Shared infrastructure):** `docs/prd-progressview-phase2.md` — includes anti-patterns analysis
- **Phase 3 (Native Lit patterns):** `docs/prd-progressview-phase3.md`
- **Phase 4 (Other webviews):** `docs/prd-progressview-phase4.md` — includes migration order and patterns checklist

### External Documentation
- **Lit Documentation:** https://lit.dev/
- **Lit Reactive Controllers:** https://lit.dev/docs/composition/controllers/
- **Zod Documentation:** https://zod.dev/
- **VS Code Webview API:** https://code.visualstudio.com/api/extension-guides/webview
- **GitLens (reference):** Production Lit webviews in VS Code

### Codebase References
- **Shared Schemas:** `src/shared/schemas/`
- **Shared Components:** `src/shared/components/`
- **Shared Styles:** `src/shared/styles/litStyles.ts`
- **Base Classes:** `src/common/webview/Base*.ts`
- **PR Review:** #2206 - Initial implementation attempt with review feedback
