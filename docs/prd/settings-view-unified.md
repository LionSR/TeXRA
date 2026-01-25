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

Settings View is implemented as part of **Phase 3** of the ProgressView modernization.

### Prerequisites (From ProgressView PRD)

- Phase 1 complete: Shared schemas in `src/shared/schemas/`
- Phase 2 complete: Shared components in `src/shared/components/`
- Webpack configuration for webview bundling

### Settings View Implementation

#### Step 1: Schema Setup
- Add settings-specific schemas to `src/shared/schemas/settings.ts`
- Add commands to `src/shared/schemas/commands.ts`
- No duplicate definitions

#### Step 2: Backend Handlers
- Create `SettingsViewMessageHandler.ts` with domain-specific handler classes
- Implement all command handlers
- Validate all messages with Zod schemas

#### Step 3: Lit Frontend
- Create `src/settingsView/frontend/` with Lit components
- Implement reactive store
- Build all 5 tab components

#### Step 4: Delete Legacy
- Remove `src/profileView/`
- Remove `src/historyView/`
- Remove `src/memoryView/`
- Update command redirects

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

- **ProgressView Modernization PRD:** `docs/prd-progressview-modernization.md`
- **Lit Documentation:** https://lit.dev/
- **Zod Documentation:** https://zod.dev/
- **Shared Schemas:** `src/shared/schemas/`
- **Shared Components:** `src/shared/components/`
- **Base Classes:** `src/common/webview/Base*.ts`
- **PR Review:** #2206 - Initial implementation attempt with review feedback
