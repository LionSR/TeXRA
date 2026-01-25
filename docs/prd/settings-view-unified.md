# PRD: Unified Settings View

**Status:** Draft
**Author:** Claude
**Date:** 2026-01-25
**Related:** Model dropdown, Agent dropdown, Profile View, History View

---

## Overview

Create a unified Settings View that consolidates model configuration, agent configuration, execution history, and profile/account management into a single tabbed interface. This replaces the scattered entry points with a cohesive settings experience.

---

## Goals

1. **Single source of truth** - All configuration in one place
2. **Easy navigation** - vscode-tabs with logical groupings, vscode-collapsible for subsections
3. **No auth required** - Most tabs work without login (except account features in header)
4. **VS Code native** - Use VS Code Elements web components (`@vscode-elements/elements`)
5. **Proper state management** - Global vs workspace state separation
6. **Backwards compatible** - Extend getConfig rather than replacing it; graceful migration
7. **Minimal custom CSS** - Only header bar needs custom styling, everything else native
8. **Consistent patterns** - Follow existing webview architecture (vanilla JS, Zod validation)

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

- Use `<vscode-form-group>` for all form layouts (native VS Code styling)
- Use `<vscode-collapsible>` for advanced/optional sections
- Keep actions visible (no hover-to-reveal complexity)
- Use standard VS Code color variables
- Follow existing webview patterns in the codebase

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

Use native `vscode-tabs` for navigation with an account header bar at the top. This provides
VS Code-native styling without custom CSS complexity.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  👤 user@example.com • Pro Plan                    [Manage] [Sign Out] [×]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Models]  Agents  LaTeX  Memory  History  Advanced                         │
│  ═══════                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Tab content with vscode-collapsible for subsections                        │
│                                                                             │
│  ▼ Recommended Models                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ ☑ Claude Sonnet 4.5 T    Anthropic   $3/$15    200K  🧠👁           │    │
│  │ ☑ GPT-5.2                OpenAI      $2/$10    256K  🧠👁           │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▼ Anthropic                                       ✓ API Key  [Configure]   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │ ☑ Claude Sonnet 4.5 T     200K   $3/$15    🧠👁📄                   │    │
│  │ ☑ Claude Opus 4.5 T       200K   $15/$75   🧠👁📄🎧                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ▶ OpenAI (28)                                     ✓ API Key  [Configure]   │
│  ▶ Google (6)                                      ✗ No Key   [Configure]   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Not Logged In State:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Use TeXRA with your own API keys                         [Sign In]    [×]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Models]  Agents  LaTeX  Memory  History  Advanced                         │
│  ═══════                                                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│  ...                                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Tab Structure (5 tabs for v1):**

```
Tab 1: Models
├── Routing options (radio: direct/openrouter/proxy)
├── ▼ Recommended Models (collapsible)
└── Provider accordions (collapsible per provider)
    └── Model checkboxes + [Configure] for API key

Tab 2: Agents
├── Built-in agents list
├── Custom agents list
├── Remote agents (if logged in)
├── ▼ Workflow Settings (collapsible subsection)
│   └── Output storage mode
└── ▼ Tool-Use Settings (collapsible subsection)
    └── Edit approval, persistence, compaction, retry behavior

Tab 3: LaTeX
├── ▼ Formatter (collapsible)
├── ▼ LaTeXdiff (collapsible)
├── ▼ TikZ Figures (collapsible)
└── ▼ Replacements (collapsible, advanced)

Tab 4: Memory
└── Memory file browser with expandable content preview

Tab 5: History
└── Execution history browser (search, restore, rerun)
```

**Deferred to Future Release:**

```
Tab 6: Advanced
├── ▼ Multi-Agent (collapsible) - merge model, future ensemble
├── ▼ UI Preferences (collapsible) - reminders, image dimension, sort
├── ▼ Git Integration (collapsible)
├── ▼ System Paths (collapsible)
└── ▼ Debug (collapsible)
```

---

## Architecture

### Technology Stack

The Settings View follows the established webview patterns in this codebase:

| Layer | Technology | Notes |
|-------|------------|-------|
| **UI Components** | VS Code Elements (`@vscode-elements/elements`) | Native VS Code styling |
| **Frontend JS** | Vanilla ES6 modules | No framework (no Lit, no React) |
| **State Management** | WebviewStateManager + VS Code API | `vscode.getState()`/`setState()` |
| **Validation** | Zod schemas | Type-safe message validation |
| **Styling** | CSS with VS Code theme variables | Codicons for icons |

### Three-Layer Architecture

The webview architecture follows a three-layer pattern with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Extension Host (TypeScript)                   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SettingsViewProvider (extends BaseWebviewProvider)                 │
│  ├── Lifecycle: resolveWebviewView(), createOrShowPanel()           │
│  ├── HTML assignment and message routing                            │
│  └── Disposable management                                          │
│                                                                     │
│  SettingsViewContentProvider (extends BaseViewContentProvider)      │
│  ├── HTML generation with module bundling                           │
│  ├── URI mapping for JS/CSS modules                                 │
│  └── CSP nonce generation                                           │
│                                                                     │
│  SettingsViewMessageHandler (extends BaseViewMessageHandler)        │
│  ├── Command routing (createHandlers())                             │
│  ├── Zod validation (withValidatedMessage())                        │
│  └── Backend service calls                                          │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                        Webview (JavaScript)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  settingsViewState.js (extends WebviewStateManager pattern)         │
│  ├── State persistence via VS Code API                              │
│  └── Getter/setter with auto-save                                   │
│                                                                     │
│  SettingsViewMessageHandler.js (extends BaseWebviewMessageHandler)  │
│  ├── Message listener registration                                  │
│  └── Command → handler routing                                      │
│                                                                     │
│  SettingsViewDomHandler.js (extends BaseDomHandler)                 │
│  ├── Composes UI managers as properties                             │
│  ├── Listener tracking for cleanup                                  │
│  └── Cascading dispose()                                            │
│                                                                     │
│  Tab UI Managers (ES6 classes)                                      │
│  ├── ModelsTab.js, AgentsTab.js, LatexTab.js, etc.                  │
│  ├── Template-based rendering                                       │
│  └── Event listener management                                      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### File Structure

```
src/
├── settingsView/                    # NEW - Unified settings view
│   ├── SettingsViewProvider.ts      # Extends BaseWebviewProvider
│   ├── SettingsViewMessageHandler.ts # Extends BaseViewMessageHandler
│   ├── SettingsViewContentProvider.ts # Extends BaseViewContentProvider
│   ├── schemas.ts                   # Zod schemas for messages
│   ├── index.html                   # Header bar + vscode-tabs layout
│   ├── styles/
│   │   └── index.css                # Minimal CSS (header bar only)
│   └── modules/
│       ├── script.js                # Entry point, initialization
│       ├── settingsViewState.js     # WebviewStateManager wrapper
│       ├── messageHandlers.js       # BaseWebviewMessageHandler extension
│       ├── domHandlers.js           # BaseDomHandler composition
│       ├── constants.js             # Element IDs, class names
│       ├── tabs/                    # Tab content modules (v1)
│       │   ├── ModelsTab.js         # Models + providers + routing
│       │   ├── AgentsTab.js         # Agents + collapsible settings
│       │   ├── LatexTab.js          # LaTeX settings (collapsibles)
│       │   ├── MemoryTab.js         # Memory files browser
│       │   └── HistoryTab.js        # History (migrated)
│       │   # AdvancedTab.js - deferred to future release
│       └── uiManagers/
│           ├── HeaderBar.js         # Account header bar
│           ├── ModelListRenderer.js
│           ├── ProviderRenderer.js
│           ├── AgentListRenderer.js
│           └── HistoryRenderer.js   # From historyView
│
├── common/
│   ├── webview/                     # Base classes (TypeScript)
│   │   ├── BaseWebviewProvider.ts   # Webview lifecycle
│   │   ├── BaseViewContentProvider.ts # HTML generation
│   │   ├── BaseViewMessageHandler.ts # Message routing + Zod validation
│   │   ├── commands.ts              # Centralized command constants
│   │   └── resourceRoots.ts         # Security resource roots
│   ├── modules/                     # Shared frontend utilities (JavaScript)
│   │   ├── BaseDomHandler.js        # Listener tracking, dispose pattern
│   │   ├── BaseWebviewMessageHandler.js # Message handler base
│   │   ├── webviewState.js          # WebviewStateManager
│   │   ├── webviewContext.js        # registerMessageHandlers()
│   │   ├── domUtils.js              # Safe DOM utilities
│   │   └── ToggleStateStore.js      # Boolean state management
│   └── styles/
│       └── common.css               # Shared styles
│
├── profileView/                     # DEPRECATED - merge into settingsView
├── historyView/                     # DEPRECATED - merge into settingsView
├── memoryView/                      # DEPRECATED - merge into settingsView
```

### Base Class Hierarchy

#### Extension Host (TypeScript)

**BaseWebviewProvider** (`src/common/webview/BaseWebviewProvider.ts`):
- Orchestrates webview lifecycle
- Handles HTML assignment via content provider
- Routes messages via message handler
- Manages disposables (extension-lifetime and view-lifetime)

```typescript
export abstract class BaseWebviewProvider {
  protected _view?: vscode.WebviewView;
  protected abstract contentProvider: BaseViewContentProvider;
  protected abstract messageHandler: BaseViewMessageHandler;

  // Called by VS Code when view becomes visible
  resolveWebviewView(webviewView: vscode.WebviewView): void;

  // For panel-based views (History, Settings)
  createOrShowPanel(options: PanelOptions): boolean;
}
```

**BaseViewContentProvider** (`src/common/webview/BaseViewContentProvider.ts`):
- Generates complete HTML with module bundling
- Maps module paths to webview URIs
- Handles CSP nonce generation

```typescript
export abstract class BaseViewContentProvider {
  // Module descriptor pattern for declaring dependencies
  protected viewModules: ModuleDescriptor[];

  // Returns complete HTML string
  getHtmlContent(webview: vscode.Webview): string;

  // Override for view-specific template variables
  protected getTemplateVariables(): Record<string, string>;
}
```

**BaseViewMessageHandler** (`src/common/webview/BaseViewMessageHandler.ts`):
- Routes messages by command name
- Provides Zod validation helper
- Error handling and logging

```typescript
export abstract class BaseViewMessageHandler {
  // Subclasses define their command handlers
  protected abstract createHandlers(): Record<string, MessageHandler>;

  // Validates message with Zod schema before handling
  protected async withValidatedMessage<S extends z.ZodType>(
    schema: S,
    message: unknown,
    messageName: string,
    handler: (data: z.infer<S>) => Promise<void>
  ): Promise<void>;
}
```

#### Webview Frontend (JavaScript)

**BaseDomHandler** (`src/common/modules/BaseDomHandler.js`):
- Tracks event listeners for automatic cleanup
- Composes child managers as properties
- Cascading dispose pattern

```javascript
class BaseDomHandler {
  constructor(managers = {}) {
    this._listeners = [];      // Track all listeners
    this._managers = managers; // Nested managers
    Object.assign(this, managers); // Expose as properties
  }

  addListener(elementOrId, event, handler) {
    // Tracks listener for later cleanup
  }

  dispose() {
    // Cleans up all listeners AND nested managers
  }
}
```

**BaseWebviewMessageHandler** (`src/common/modules/BaseWebviewMessageHandler.js`):
- Registers message listeners with webview context
- Routes messages by command name
- Cleanup on dispose

```javascript
class BaseWebviewMessageHandler {
  constructor() {
    this._disposeFn = null;
    this._handlers = {};  // Command → handler map
  }

  setup() {
    this._disposeFn = registerMessageHandlers(this._handlers);
  }

  dispose() {
    this._disposeFn?.();
  }
}
```

**WebviewStateManager** (`src/common/modules/webviewState.js`):
- Wraps VS Code's `getState()`/`setState()` APIs
- Immutable state copies with spread operators
- Methods: `getState()`, `setState()`, `update()`

---

## Message Protocol (Zod-native)

### Schema Patterns

Use Zod schemas as single source of truth. Follow existing patterns from `src/webview/types/messages.ts`.

**File:** `src/settingsView/schemas.ts`

```typescript
import { z } from 'zod';

// =============================================================================
// Command Constants
// =============================================================================

export const SETTINGS_VIEW_COMMANDS = {
  // Extension → Webview
  SET_MODELS_DATA: 'SET_MODELS_DATA',
  SET_AGENTS_DATA: 'SET_AGENTS_DATA',
  SET_LATEX_DATA: 'SET_LATEX_DATA',
  SELECT_TAB: 'SELECT_TAB',
  // Webview → Extension
  GET_INITIAL_DATA: 'GET_INITIAL_DATA',
  TAB_CHANGED: 'TAB_CHANGED',
  SAVE_ENABLED_MODELS: 'SAVE_ENABLED_MODELS',
  SAVE_ENABLED_AGENTS: 'SAVE_ENABLED_AGENTS',
  SAVE_SETTING: 'SAVE_SETTING',
  SET_API_KEY: 'SET_API_KEY',
  SIGN_IN: 'SIGN_IN',
  SIGN_OUT: 'SIGN_OUT',
} as const;

// =============================================================================
// Shared Base Schemas (composition pattern)
// =============================================================================

const BaseMessageSchema = z.object({
  command: z.string(),
});

// =============================================================================
// Tab and Settings Schemas
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
// Extension → Webview Messages
// =============================================================================

export const SetModelsDataSchema = z.object({
  command: z.literal('SET_MODELS_DATA'),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    provider: z.string(),
    contextWindow: z.number(),
    inputCost: z.number(),
    outputCost: z.number(),
    capabilities: z.array(z.string()),
  })),
  enabled: z.array(z.string()),
  providerStatus: z.record(z.object({
    hasKey: z.boolean(),
    keySource: z.enum(['secret', 'env', 'none']),
  })),
});

export const SetAgentsDataSchema = z.object({
  command: z.literal('SET_AGENTS_DATA'),
  agents: z.array(z.object({
    name: z.string(),
    source: z.enum(['builtIn', 'builtInToolUse', 'custom', 'remote']),
    category: z.enum(['workflow', 'toolUse']),
    agentType: z.enum(['CoT', 'direct', 'toolUse']),
    description: z.string().optional(),
    enabled: z.boolean(),
  })),
});

export const SelectTabSchema = z.object({
  command: z.literal('SELECT_TAB'),
  tab: SettingsTabSchema,
});

// Discriminated union for type-safe message handling
export const SettingsMessageSchema = z.discriminatedUnion('command', [
  SetModelsDataSchema,
  SetAgentsDataSchema,
  SelectTabSchema,
]);

export type SettingsMessage = z.infer<typeof SettingsMessageSchema>;

// =============================================================================
// Webview → Extension Actions
// =============================================================================

export const SaveEnabledModelsSchema = z.object({
  command: z.literal('SAVE_ENABLED_MODELS'),
  models: z.array(z.string()),
});

export const SaveEnabledAgentsSchema = z.object({
  command: z.literal('SAVE_ENABLED_AGENTS'),
  agents: z.array(z.string()),
});

export const SaveSettingSchema = z.object({
  command: z.literal('SAVE_SETTING'),
  key: z.string(),
  value: z.unknown(),
  scope: z.enum(['global', 'workspace']).optional(),
});

export const SetApiKeySchema = z.object({
  command: z.literal('SET_API_KEY'),
  provider: z.string(),
  key: z.string(),
});

export const SettingsActionSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('GET_INITIAL_DATA') }),
  z.object({ command: z.literal('TAB_CHANGED'), tab: SettingsTabSchema }),
  SaveEnabledModelsSchema,
  SaveEnabledAgentsSchema,
  SaveSettingSchema,
  SetApiKeySchema,
  z.object({ command: z.literal('SIGN_IN') }),
  z.object({ command: z.literal('SIGN_OUT') }),
]);

export type SettingsAction = z.infer<typeof SettingsActionSchema>;
```

### Zod Patterns Summary

Follow these patterns from the existing codebase:

| Pattern | Usage | Example |
|---------|-------|---------|
| **Schema Composition** | Reusable base schemas | `BaseMessageSchema.extend({ ... })` |
| **`.extend()` + `.shape`** | Add fields while extending | `BaseSchema.extend(WithFilePath.shape)` |
| **`.pick()`** | Select subset of fields | `FullSchema.pick({ field1: true })` |
| **Type Inference** | `z.infer<typeof Schema>` | Single source of truth for types |
| **Transform + Pipe** | Data transformation | `z.string().transform(s => s.trim()).pipe(z.string().min(1))` |
| **Discriminated Unions** | Type-safe message routing | `z.discriminatedUnion('command', [...])` |
| **`.prefault()`** | Defaults during parsing | `z.enum([...]).prefault('default')` |
| **Safe Parsing** | Non-throwing validation | `schema.safeParse(data)` + callback |

---

## Frontend Implementation Patterns

### ES6 Class + Singleton Pattern

All frontend modules use ES6 classes with singleton exports:

```javascript
// settingsViewState.js
import { WebviewStateManager } from '@common/modules/webviewState.js';

class SettingsViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this._activeTab = 'models';
    this._enabledModels = [];
  }

  initialize() {
    const saved = this.stateManager.getState();
    this._activeTab = saved.activeTab ?? 'models';
    this._enabledModels = saved.enabledModels ?? [];
  }

  get activeTab() { return this._activeTab; }
  set activeTab(value) {
    this._activeTab = value;
    this.save();
  }

  save() {
    this.stateManager.update({
      activeTab: this._activeTab,
      enabledModels: this._enabledModels,
    });
  }
}

export const settingsViewState = new SettingsViewState();
```

### DOM Handler Composition

Use BaseDomHandler for listener tracking and manager composition:

```javascript
// domHandlers.js
import { BaseDomHandler } from '@common/modules/BaseDomHandler.js';
import { HeaderBar } from './uiManagers/HeaderBar.js';
import { ModelsTab } from './tabs/ModelsTab.js';
import { AgentsTab } from './tabs/AgentsTab.js';
import { settingsViewState } from './settingsViewState.js';

class SettingsViewDomHandler extends BaseDomHandler {
  constructor() {
    const headerBar = new HeaderBar();
    const modelsTab = new ModelsTab(settingsViewState);
    const agentsTab = new AgentsTab(settingsViewState);

    super({
      headerBar,
      modelsTab,
      agentsTab,
      // More tabs...
    });
  }

  initializeUI() {
    this.headerBar.render();
    this.showTab(settingsViewState.activeTab);
  }

  showTab(tabName) {
    // Hide all tabs, show selected
    Object.values(this._managers).forEach(mgr => {
      if (mgr.hide) mgr.hide();
    });
    this[tabName + 'Tab']?.show();
  }
}

export const settingsViewDomHandler = new SettingsViewDomHandler();
```

### Tab Manager Pattern

Each tab extends BaseDomHandler for listener cleanup:

```javascript
// tabs/ModelsTab.js
import { BaseDomHandler } from '@common/modules/BaseDomHandler.js';
import { safeGetElementById } from '@common/modules/domUtils.js';
import { ELEMENT_IDS } from '../constants.js';

export class ModelsTab extends BaseDomHandler {
  constructor(state) {
    super();
    this.state = state;
    this._container = null;
  }

  get container() {
    if (!this._container) {
      this._container = safeGetElementById(ELEMENT_IDS.MODELS_TAB);
    }
    return this._container;
  }

  render(data) {
    this.container.innerHTML = `
      <vscode-collapsible title="Recommended Models" open>
        ${this.renderModelList(data.recommended)}
      </vscode-collapsible>

      ${data.providers.map(provider => `
        <vscode-collapsible title="${provider.name} (${provider.models.length})">
          <div class="provider-header">
            ${this.renderProviderStatus(provider)}
            <vscode-button appearance="secondary">Configure</vscode-button>
          </div>
          ${this.renderModelList(provider.models)}
        </vscode-collapsible>
      `).join('')}
    `;
    this.attachEventListeners();
  }

  renderModelList(models) {
    return models.map(m => `
      <vscode-checkbox id="model-${m.id}" ${m.enabled ? 'checked' : ''}>
        ${m.name}
        <span class="model-meta">${m.contextWindow}K • $${m.inputCost}/$${m.outputCost}</span>
      </vscode-checkbox>
    `).join('');
  }

  attachEventListeners() {
    this.container.querySelectorAll('vscode-checkbox').forEach(cb => {
      this.addListener(cb, 'change', () => this.handleModelToggle(cb));
    });
  }

  handleModelToggle(checkbox) {
    const modelId = checkbox.id.replace('model-', '');
    vscode.postMessage({
      command: 'SAVE_ENABLED_MODELS',
      models: this.getEnabledModels(),
    });
  }

  show() { this.container.style.display = 'block'; }
  hide() { this.container.style.display = 'none'; }
}
```

### Message Handler Pattern

Frontend message handler extends base class:

```javascript
// messageHandlers.js
import { BaseWebviewMessageHandler } from '@common/modules/BaseWebviewMessageHandler.js';
import { SETTINGS_VIEW_COMMANDS } from './constants.js';
import { settingsViewState } from './settingsViewState.js';
import { settingsViewDomHandler } from './domHandlers.js';

class SettingsViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._handlers = {
      [SETTINGS_VIEW_COMMANDS.SET_MODELS_DATA]: (m) => this.handleSetModelsData(m),
      [SETTINGS_VIEW_COMMANDS.SET_AGENTS_DATA]: (m) => this.handleSetAgentsData(m),
      [SETTINGS_VIEW_COMMANDS.SELECT_TAB]: (m) => this.handleSelectTab(m),
    };
  }

  handleSetModelsData(message) {
    settingsViewState.updateModels(message);
    settingsViewDomHandler.modelsTab.render(message);
  }

  handleSetAgentsData(message) {
    settingsViewState.updateAgents(message);
    settingsViewDomHandler.agentsTab.render(message);
  }

  handleSelectTab(message) {
    settingsViewState.activeTab = message.tab;
    settingsViewDomHandler.showTab(message.tab);
  }
}

export const messageHandler = new SettingsViewMessageHandler();
```

### Initialization Flow

```javascript
// script.js
import { settingsViewState } from './modules/settingsViewState.js';
import { settingsViewDomHandler } from './modules/domHandlers.js';
import { messageHandler } from './modules/messageHandlers.js';
import { SETTINGS_VIEW_COMMANDS } from './modules/constants.js';

// 1. Initialize state from VS Code's memory
settingsViewState.initialize();

// 2. Register message handlers early
messageHandler.setup();

// 3. When DOM is ready, initialize UI and request data
document.addEventListener('DOMContentLoaded', () => {
  settingsViewDomHandler.initializeUI();
  vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA });
});

// 4. Clean up on navigation
window.addEventListener('beforeunload', () => {
  settingsViewDomHandler.dispose();
  messageHandler.dispose();
});
```

---

## Tab Specifications

### Models Tab

**Purpose:** Combined model selection and API provider configuration.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  Models & Providers                                             │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ROUTING                                                        │
│  ● Direct to providers (recommended)                            │
│  ○ Route all through OpenRouter                                 │
│  ○ Use connection proxy                                         │
│                                                                 │
│  ⭐ RECOMMENDED MODELS                                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 T    Anthropic   $3/$15    200K  🧠👁 │  │
│  │ ☑ GPT-5.2                OpenAI      $2/$10    256K  🧠👁 │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  PROVIDERS                                                      │
│  ▼ Anthropic                         ✓ API Key    [Configure]  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 T     200K   $3/$15    🧠👁📄         │  │
│  │ ☑ Claude Opus 4.5 T       200K   $15/$75   🧠👁📄🎧       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ OpenAI (28)                       ✓ API Key    [Configure]  │
│  ▶ Google (6)                        ✗ No Key     [Configure]  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Storage:** `globalState.enabledModels: string[]`, `globalState.providerConfig`

---

### Agents Tab

**Purpose:** View and enable/disable agents, plus agent-specific settings.

**Layout:**

```
┌─────────────────────────────────────────────────────────────────┐
│  BUILT-IN AGENTS                                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ chat      Interactive conversation  $(tools) toolUse    │  │
│  │ ☑ correct   Fix typos & LaTeX errors  $(lightbulb) CoT    │  │
│  │ ☑ polish    Improve writing quality   $(lightbulb) CoT    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  CUSTOM AGENTS                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ my-reviewer   Reviews papers       [Source Code] [Delete]│  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  REMOTE AGENTS                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ team-reviewer   Team's paper reviewer                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▼ Workflow Settings                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Storage mode: [Folder ▼]                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▼ Tool-Use Settings                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Require approval before file edits                      │  │
│  │ ☑ Persist sessions across VS Code restarts                │  │
│  │ Compaction threshold: [85 %]                              │  │
│  │ Max retry attempts: [3 ▼]                                 │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Storage:** `workspaceState.enabledAgents: string[]`, VS Code configuration

---

### LaTeX Tab

**Purpose:** Configure LaTeX formatting, latexdiff, and TikZ settings.

**Settings Groups:**

| Group | Settings |
|-------|----------|
| **Formatter** | `texra.latex.formatter`, `latexindentConfig`, `texfmtConfig`, `showLatexindentWarning` |
| **LaTeXdiff** | `texra.latexdiff.mathMarkup`, `timeoutMs`, `pictureEnvironments`, `generateBetweenRoundDiffs` |
| **TikZ Figures** | `texra.latex.tikzInputDirectory`, `includeWorkspaceInTexinputs`, `tikzTemplate` |
| **Replacements** | `texra.latex.wrapCritiqueInAlign`, `enabledReplacements`, `enabledReplacementsRegex` |

---

### Memory Tab

**Purpose:** Browse and manage memory files created by tool-use agents.

**Features:**
- Memory file browser with expandable content preview
- Click to expand and show content (first ~20 lines)
- [View Full] opens file in editor
- [Delete] removes file

---

### History Tab

**Purpose:** Browse and restore previous agent executions.

**Features:**
- Search with highlighting (mark.js)
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

### Webview State

UI state persisted via VS Code API:

```javascript
// Frontend
const state = vscode.getState();  // Restore on reopen
vscode.setState({ activeTab: 'models' });  // Persist
```

---

## Implementation Phases

### v1 Release (5 Tabs)

#### Phase 1: Core Structure
- Create settingsView with vscode-tabs + header bar
- Implement base classes (Provider, ContentProvider, MessageHandler)
- Add main webview entry point (gear icon)

#### Phase 2: Models Tab
- Provider collapsibles with API status
- Model checkboxes with capabilities
- Provider configuration modal

#### Phase 3: Agents Tab
- Agent list with category badges
- Workflow Settings collapsible
- Tool-Use Settings collapsible

#### Phase 4: LaTeX Tab
- Formatter, latexdiff, TikZ collapsibles
- Wire up to VS Code configuration

#### Phase 5: Memory Tab
- Migrate memoryView
- Expandable content preview

#### Phase 6: History Tab + Cleanup
- Move history rendering
- Delete deprecated views

### Future Release

- **Advanced Tab** - Multi-Agent, UI preferences, debug
- **Agent Creation Wizard** - Form-based agent creation

---

## Lessons Learned (PR #2206 Review)

Based on code review feedback from the initial implementation attempt, the following issues must be addressed:

### Critical: Single Source of Truth Violations

#### Command Constants Duplication

**Problem:** `SETTINGS_VIEW_COMMANDS` was defined in THREE places:
- `src/settingsView/schemas.ts` (TypeScript)
- `src/settingsView/modules/constants.js` (JavaScript)
- `src/common/webview/commands.ts` (shared)

**Impact:** Commands can drift out of sync, causing silent message routing failures.

**Solution:** Define commands ONLY in `src/common/webview/commands.ts`:
```typescript
// src/common/webview/commands.ts - SINGLE SOURCE OF TRUTH
export const SETTINGS_VIEW_COMMANDS = {
  // Extension → Webview
  SET_INITIAL_DATA: 'SET_INITIAL_DATA',
  SET_MODELS_DATA: 'SET_MODELS_DATA',
  // ... all commands
} as const;

// src/settingsView/schemas.ts - IMPORT, don't redefine
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/commands';
export { SETTINGS_VIEW_COMMANDS };

// src/settingsView/modules/constants.js - IMPORT from shared
// Use import map to access common/webview/commands.js
```

#### Provider Metadata Duplication

**Problem:** `PROVIDER_META` defined in both:
- `SettingsViewMessageHandler.ts` (TypeScript backend)
- `constants.js` (JavaScript frontend)

**Solution:** Define provider metadata ONCE in backend and send to frontend via `InitialData`:
```typescript
// Backend: Include in collectInitialData()
const initialData = {
  // ... other data
  providerMeta: PROVIDER_META,  // Send to frontend
};

// Frontend: Access from state, don't hardcode
const provider = settingsViewState.providerMeta[providerId];
```

---

### Security Issues

#### XSS Vulnerability in HTML Rendering

**Problem:** Template literals directly interpolate user data without escaping:
```javascript
// ❌ VULNERABLE - file.path could contain malicious HTML
<div class="memory-file" data-path="${file.path}">
  ${file.name}
</div>

// ❌ VULNERABLE - agent names from user YAML files
<span class="agent-name">${agent.name}</span>
```

**Solution:** Always escape user-controlled data:
```javascript
import { escapeHtml } from '@common/modules/htmlEncoding.js';

// ✅ SAFE - escape all user data
<div class="memory-file" data-path="${escapeHtml(file.path)}">
  ${escapeHtml(file.name)}
</div>

// ✅ SAFE - use textContent via DOM API
const nameEl = row.querySelector('.agent-name');
nameEl.textContent = agent.name;  // Automatically escaped
```

**Files requiring escaping:**
- `HistoryTab.js` - `item.agentName`, `item.modelName`, `item.inputFile`, `item.id`
- `MemoryTab.js` - `file.name`, `file.path`
- `AgentListRenderer.js` - `agent.name`, `agent.description`
- `ModelListRenderer.js` - `model.name`, `provider.name`

#### Path Traversal in Memory Operations

**Problem:** File paths from webview used directly without validation:
```typescript
// ❌ VULNERABLE - path could be "../../../etc/passwd"
async ({ path: storagePath }) => {
  const absolutePath = StorageFS.fullPath(storagePath);
  await vscode.window.showTextDocument(uri);
}
```

**Solution:** Validate paths are within expected directory:
```typescript
import { resolveMemoryStoragePath, MEMORY_STORAGE_ROOT } from '@tools/memory/memoryStorage';

async ({ path: storagePath }) => {
  // ✅ SAFE - validate path is within memory storage
  const resolvedPath = resolveMemoryStoragePath(storagePath);
  if (!resolvedPath) {
    this.logger.warn('Invalid memory path attempted:', storagePath);
    return;
  }
  const uri = vscode.Uri.file(resolvedPath);
  await vscode.window.showTextDocument(uri);
}
```

#### Unvalidated Setting Keys

**Problem:** `settingKey` parameter accepted any string:
```typescript
// ❌ Could modify arbitrary VS Code settings
await config.update(settingKey, value);
```

**Solution:** Whitelist allowed configuration keys in schema:
```typescript
export const SaveSettingSchema = z.object({
  command: z.literal('SAVE_SETTING'),
  key: z.enum([
    'texra.latex.formatter',
    'texra.latex.latexindentConfig',
    'texra.latexdiff.mathMarkup',
    // ... explicit whitelist
  ]),
  value: z.unknown(),
});
```

---

### Missing Functionality

#### Missing Command Handlers

**Problem:** Commands defined in frontend but handlers missing in backend:
- `BROWSE_AGENTS_DIRECTORY` - Browse button in Agents tab
- `OPEN_AGENTS_DIRECTORY` - Open button in Agents tab

**Solution:** Ensure every command in `constants.js` has a corresponding handler in `createHandlers()`.

**Checklist pattern:**
```typescript
// In MessageHandler, verify all commands have handlers
protected createHandlers(): Record<string, MessageHandler> {
  const handlers = {
    // Verify EVERY command from SETTINGS_VIEW_COMMANDS is here
    [SETTINGS_VIEW_COMMANDS.GET_INITIAL_DATA]: this.handleGetInitialData.bind(this),
    [SETTINGS_VIEW_COMMANDS.BROWSE_AGENTS_DIRECTORY]: this.handleBrowseAgentsDir.bind(this),
    [SETTINGS_VIEW_COMMANDS.OPEN_AGENTS_DIRECTORY]: this.handleOpenAgentsDir.bind(this),
    // ...
  };

  // Optional: Runtime check that all commands have handlers
  for (const cmd of Object.values(SETTINGS_VIEW_COMMANDS)) {
    if (!handlers[cmd]) {
      console.warn(`Missing handler for command: ${cmd}`);
    }
  }
  return handlers;
}
```

#### Memory/History Data Not in Initial Load

**Problem:** `collectInitialData()` didn't include memory files or history items, causing tabs to be empty on first load.

**Solution:** Include ALL tab data in initial payload:
```typescript
async collectInitialData(): Promise<InitialData> {
  const [account, models, providers, agents, latex, history, memory] =
    await Promise.all([
      this.collectAccountData(),
      this.collectModelsData(),
      this.collectProvidersData(),
      this.collectAgentsData(),
      this.collectLatexSettings(),
      this.collectHistoryData(),    // ✅ Include history
      this.collectMemoryData(),     // ✅ Include memory
    ]);

  return {
    account, models, providers, agents, latexSettings: latex,
    historyItems: history,  // ✅ Must be in payload
    memoryFiles: memory,    // ✅ Must be in payload
    memoryEnabled: true,
  };
}
```

Also update `updateFromInitialData()` in state manager:
```javascript
updateFromInitialData(data) {
  this.updateAccount(data.account);
  this.updateModels(data.models);
  this.updateAgents(data.agents);
  this.updateLatexSettings(data.latexSettings);
  this.updateHistoryItems(data.historyItems);  // ✅ Don't forget
  this.updateMemoryFiles(data.memoryFiles);    // ✅ Don't forget
}
```

#### Tab Selection Not Applied

**Problem:** When opening Settings View to a specific tab (e.g., via `texra.showAgentHistory`), the requested tab was ignored.

**Solution:** Apply tab selection in frontend message handler:
```javascript
handleSetInitialData(message) {
  settingsViewState.updateFromInitialData(message);

  // ✅ Apply selected tab from initial data
  if (message.selectedTab) {
    settingsViewState.selectedTab = message.selectedTab;
    tabManager.selectTab(message.selectedTab);  // Actually switch tab
  }

  this.renderAllTabs();
}
```

#### API Access Mode Toggle Missing

**Problem:** Paid subscribers lost the ability to toggle between "included access" (TeXRA's API keys) and "personal keys" (their own API keys).

**Solution:** Add API access mode to Models tab or header bar:
```typescript
// In SettingsViewMessageHandler
[SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE]: this.handleSetApiAccessMode.bind(this),

private async handleSetApiAccessMode(message: unknown): Promise<void> {
  await this.withValidatedMessage(
    SetApiAccessModeSchema,
    message,
    'setApiAccessMode',
    async ({ mode }) => {
      const useIncluded = mode === 'included';
      await getServerSideKeyService().setUseIncludedModelAccess(useIncluded);
      // Refresh UI
    }
  );
}
```

---

### UX Issues

#### Missing Confirmation Dialogs

**Problem:** Destructive actions executed immediately without user confirmation:
- `clearAllMemory()` deletes all files
- `handleClearHistory()` deletes all history

**Solution:** Add confirmation dialogs:
```typescript
// Backend handler
private async handleClearAllMemory(): Promise<void> {
  const confirmed = await vscode.window.showWarningMessage(
    'Delete all memory files? This cannot be undone.',
    { modal: true },
    'Delete All'
  );

  if (confirmed !== 'Delete All') return;

  // Proceed with deletion
}
```

Or in frontend with VS Code-style:
```javascript
async clearAllMemory() {
  // Send confirmation request to backend
  vscode.postMessage({
    command: SETTINGS_VIEW_COMMANDS.CONFIRM_CLEAR_ALL_MEMORY,
  });
  // Backend shows dialog and proceeds if confirmed
}
```

---

### Data Consistency Issues

#### Inconsistent Default Values

**Problem:** Default values differed between Settings View and execution code:
```typescript
// Settings View used 'fine'
latexdiffMathMarkup: getConfig('texra.latexdiff.mathMarkup', 'fine'),

// Execution code used 'coarse'
const mathMarkup = getConfig('texra.latexdiff.mathMarkup', 'coarse');
```

**Solution:** Define defaults in ONE place (settingsSchema.ts):
```typescript
// settingsSchema.ts - SINGLE SOURCE OF TRUTH
export const MathMarkupSchema = z.enum(['off', 'whole', 'coarse', 'fine']).default('coarse');

// Everywhere else - use schema default
const mathMarkup = MathMarkupSchema.parse(getConfig('texra.latexdiff.mathMarkup'));
```

#### Provider ID Case Mismatch

**Problem:** Provider IDs inconsistently cased:
```typescript
// Schema used camelCase
ProviderIdSchema = z.enum(['anthropic', 'openai', 'openRouter', ...]);

// Model configs used lowercase
MODEL_CONFIGS[model].provider.toLowerCase() === 'openrouter'  // ❌ Mismatch!
```

**Solution:** Use consistent lowercase for all provider IDs:
```typescript
export const ProviderIdSchema = z.enum([
  'anthropic',
  'openai',
  'google',
  'openrouter',  // ✅ Lowercase
  'deepseek',
  'xai',
  'moonshot',
  'dashscope',
]);
```

#### Settings Migration Missing

**Problem:** When moving settings from VS Code config to workspace storage, existing user values were lost.

**Solution:** Add migration on activation:
```typescript
// In extension.ts or settings initialization
async function migrateSettings() {
  const config = vscode.workspace.getConfiguration('texra');
  const storage = context.workspaceState;

  const settingsToMigrate = [
    { old: 'latex.formatter', new: WorkspaceStateKey.FORMATTER },
    { old: 'latexdiff.mathMarkup', new: WorkspaceStateKey.MATH_MARKUP },
  ];

  for (const { old, new: newKey } of settingsToMigrate) {
    const existing = storage.get(newKey);
    if (existing === undefined) {
      const value = config.get(old);
      if (value !== undefined) {
        await storage.update(newKey, value);
      }
    }
  }
}
```

---

### Architecture Recommendations

#### Large MessageHandler Class

**Problem:** `SettingsViewMessageHandler.ts` grew to 1000+ lines.

**Solution:** Extract domain-specific handler classes:
```
src/settingsView/
├── SettingsViewMessageHandler.ts      # Orchestrates, ~200 lines
├── handlers/
│   ├── ModelHandlers.ts               # Model/provider operations
│   ├── AgentHandlers.ts               # Agent CRUD operations
│   ├── LatexHandlers.ts               # LaTeX settings
│   ├── HistoryHandlers.ts             # History operations
│   └── MemoryHandlers.ts              # Memory file operations
```

Usage:
```typescript
export class SettingsViewMessageHandler extends BaseViewMessageHandler {
  private modelHandlers: ModelHandlers;
  private agentHandlers: AgentHandlers;
  // ...

  protected createHandlers(): Record<string, MessageHandler> {
    return {
      ...this.modelHandlers.getHandlers(),
      ...this.agentHandlers.getHandlers(),
      // ...
    };
  }
}
```

#### Performance: Lazy Loading for Large Data

**Problem:** Loading all memory files with content previews could be slow.

**Solution:** Lazy load previews on expand:
```javascript
// Initial load: metadata only
const memoryFiles = files.map(f => ({
  name: f.name,
  path: f.path,
  size: f.size,
  // preview: NOT included initially
}));

// On expand: fetch preview
async expandFile(filePath) {
  vscode.postMessage({
    command: SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW,
    path: filePath,
  });
}
```

---

### Test Coverage Requirements

No tests were included in the initial implementation. Required test coverage:

| Area | Test Type | Priority |
|------|-----------|----------|
| **Zod Schemas** | Unit tests for validation edge cases | High |
| **Message Handlers** | Unit tests for each handler | High |
| **State Management** | Tests for settingsViewState.js | Medium |
| **Data Collection** | Tests for collectModelsData, etc. | Medium |
| **Tab Switching** | Integration tests | Medium |
| **API Key Flow** | Integration tests | High |
| **Legacy Redirects** | Verify old commands work | Medium |

Example test structure:
```typescript
// tests/settingsView/schemas.test.ts
describe('SettingsView Schemas', () => {
  describe('SaveSettingSchema', () => {
    it('rejects unknown setting keys', () => {
      const result = SaveSettingSchema.safeParse({
        command: 'SAVE_SETTING',
        key: 'texra.unknown.setting',  // Not in whitelist
        value: 'test',
      });
      expect(result.success).toBe(false);
    });
  });
});

// tests/settingsView/messageHandler.test.ts
describe('SettingsViewMessageHandler', () => {
  it('handles all defined commands', () => {
    const handler = new SettingsViewMessageHandler(mockContext);
    const handlers = handler['createHandlers']();

    for (const cmd of Object.values(SETTINGS_VIEW_COMMANDS)) {
      expect(handlers[cmd]).toBeDefined(`Missing handler for ${cmd}`);
    }
  });
});
```

---

## Implementation Checklist

Before merging Settings View implementation, verify:

### Single Source of Truth
- [ ] Commands defined in ONE file only (`commands.ts`)
- [ ] Provider metadata defined in ONE file, sent via InitialData
- [ ] Default values defined in `settingsSchema.ts`
- [ ] Provider IDs use consistent casing (lowercase)

### Security
- [ ] All user data escaped before HTML interpolation
- [ ] Memory file paths validated against storage root
- [ ] Setting keys whitelisted in schema
- [ ] API keys use SecretManager (never in state/config)

### Completeness
- [ ] Every frontend command has a backend handler
- [ ] All tabs receive data in InitialData
- [ ] Tab selection from parameters actually applied
- [ ] API access mode toggle included (for paid users)

### UX Safety
- [ ] Destructive actions have confirmation dialogs
- [ ] Error messages shown for failed operations
- [ ] Loading states for async operations

### Testing
- [ ] Schema validation tests
- [ ] Handler routing tests
- [ ] State management tests
- [ ] Legacy command redirect tests

---

## References

- **VS Code Elements:** `@vscode-elements/elements` (v2.4.0)
- **Base Classes:** `src/common/webview/Base*.ts`
- **Shared Modules:** `src/common/modules/*.js`
- **Shared Styles:** `src/common/styles/common.css`
- **Existing Views:** `src/profileView/`, `src/historyView/`, `src/progressView/`
- **PR Review:** #2206 - Initial implementation attempt with review feedback
