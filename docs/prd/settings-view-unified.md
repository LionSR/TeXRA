# PRD: Unified Settings View

**Status:** Draft
**Author:** Claude
**Date:** 2026-01-11
**Related:** Model dropdown, Agent dropdown, Profile View, History View

---

## Overview

Create a unified Settings View that consolidates model configuration, agent configuration, execution history, and profile/account management into a single tabbed interface. This replaces the scattered entry points with a cohesive settings experience.

---

## Goals

1. **Single source of truth** - All configuration in one place
2. **Easy navigation** - Tab-based switching between Models, Agents, History, Profile
3. **No auth required** - Models, Agents, History tabs work without login
4. **VS Code native** - Use `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel` components
5. **Proper state management** - Global vs workspace state separation

---

## User Stories

1. As a user, I want to click a settings icon to configure which models appear in my dropdown
2. As a user, I want to configure different agents per workspace (research project vs thesis)
3. As a user, I want to browse execution history and restore previous sessions
4. As a user, I want to manage my account and API keys in the same interface
5. As a user, I want to easily switch between these configuration pages

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

### Tab Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  TeXRA Settings                                          [×]   │
├─────────────────────────────────────────────────────────────────┤
│  [Models]   Agents    History    Profile                        │
│  ═══════                                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                    Tab content here                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### HTML Structure (using vscode-elements)

```html
<vscode-tabs id="settingsTabs" selected-index="0">
  <vscode-tab-header slot="header">Models</vscode-tab-header>
  <vscode-tab-header slot="header">Agents</vscode-tab-header>
  <vscode-tab-header slot="header">History</vscode-tab-header>
  <vscode-tab-header slot="header">Profile</vscode-tab-header>

  <vscode-tab-panel id="modelsPanel">
    <!-- Models tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="agentsPanel">
    <!-- Agents tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="historyPanel">
    <!-- History tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="profilePanel">
    <!-- Profile tab content -->
  </vscode-tab-panel>
</vscode-tabs>
```

---

## Tab Specifications

### Models Tab

**Purpose:** Configure which models appear in the model dropdown.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure which models appear in the model dropdown.           │
│                                                                 │
│  ⭐ RECOMMENDED                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 T    Anthropic   $3/$15    200K  🧠👁 │  │
│  │ ☑ Claude Opus 4.5 T      Anthropic   $15/$75   200K  🧠👁 │  │
│  │ ☑ GPT-5.2                OpenAI      $2/$10    256K  🧠👁 │  │
│  │ ☑ Gemini 3 Pro           Google      $1.25/$5  1M    🧠👁 │  │
│  │ ☑ Grok 4                 xAI         $3/$15    256K  🧠👁 │  │
│  │ ☑ DeepSeek R1            DeepSeek    $0.55/$2  64K   🧠   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ALL MODELS                                                     │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ▼ Anthropic (21)                                 [Enable All] │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 Thinking   200K   $3/$15    🧠👁📄    │  │
│  │ ☑ Claude Opus 4.5 Thinking     200K   $15/$75   🧠👁📄🎧  │  │
│  │ ☐ Claude Sonnet 4.5            200K   $3/$15    👁📄      │  │
│  │ ☐ Claude Sonnet 4.0            200K   $3/$15    👁📄      │  │
│  │ ☐ Claude Haiku 3.5             200K   $0.8/$4   👁        │  │
│  │   ... more                                                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ OpenAI (28)                                                 │
│  ▶ Google (6)                                                  │
│  ▶ DeepSeek (7)                                                │
│  ▶ xAI (5)                                                     │
│  ▶ Moonshot (8)                                                │
│  ▶ DashScope (3)                                               │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Selected: 12 models                              [Save Changes]│
└─────────────────────────────────────────────────────────────────┘
```

**Data Source:** `llm-zoo` package (ModelRegistry)

**Model Metadata Displayed:**
- Name (display name)
- Provider
- Cost (input/output per 1M tokens)
- Context window
- Capabilities icons: 🧠 Reasoning, 👁 Vision, 📄 PDF, 🎧 Audio, 💬 Tools, ⚡ Cache

**Sorting:**
- Recommended section: hardcoded curated list
- Provider sections: newest model families first within each provider

**Recommended Models (hardcoded):**
```typescript
const RECOMMENDED_MODELS = [
  'sonnet45T',   // Claude Sonnet 4.5 Thinking
  'opus45T',     // Claude Opus 4.5 Thinking
  'gpt52',       // GPT-5.2
  'gemini3p',    // Gemini 3 Pro
  'grok4',       // Grok 4
  'deepseekT',   // DeepSeek R1
  'kimi2T',      // Kimi K2 Thinking
  'qwen3max',    // Qwen 3 Max
];
```

**Storage:** `globalState.enabledModels: string[]`

---

### Agents Tab

**Purpose:** Configure which agents appear in agent dropdowns.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure which agents appear in the agent dropdowns.          │
│  Settings are saved per workspace.                              │
│                                                                 │
│  LOCAL AGENTS                                     [Enable All] │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ ask             Quick Q&A without tools                 │  │
│  │ ☑ chat            Interactive chat with context           │  │
│  │ ☑ correct         Corrects typos, grammar, LaTeX          │  │
│  │ ☑ draw            Creates/polishes TikZ figures           │  │
│  │ ☐ merge           Merges partial edits into document      │  │
│  │ ☑ ocr             Handwritten math → LaTeX                │  │
│  │ ☑ paper2poster    Paper → academic poster                 │  │
│  │ ☑ paper2slide     Paper → Beamer presentation             │  │
│  │ ☑ polish          Improves writing quality & clarity      │  │
│  │ ☑ research        Research assistant with tools           │  │
│  │ ☑ search          Search & retrieval                      │  │
│  │ ☐ transcribe_audio Audio transcription                    │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  CUSTOM AGENTS                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  No custom agents in this workspace.        [Learn More]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  REMOTE AGENTS                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ team-reviewer   Team's paper reviewer       [Public]    │  │
│  │ ☑ grant-writer    Grant proposal helper       [Team]      │  │
│  │ ☐ thesis-helper   Thesis writing assistant    [Private]   │  │
│  │                                                           │  │
│  │  ☐ Auto-show new remote agents                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        ─ or if not logged in ─                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  🔒 Sign in to access shared team agents       [Sign In]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Selected: 12 agents                              [Save Changes]│
└─────────────────────────────────────────────────────────────────┘
```

**Data Source:** `agentRegistry` (built-in, custom, remote)

**Agent Metadata Displayed:**
- Name
- Description
- Source badge (for remote: visibility)

**Sections:**
1. **Local Agents** - Built-in agents from `resources/agents/`
2. **Custom Agents** - User-defined agents in workspace
3. **Remote Agents** - Shared team agents (requires auth)

**Storage:** `workspaceState.enabledAgents: string[]`

---

### History Tab

**Purpose:** Browse and restore previous agent executions.

**Layout:** (Migrated from existing historyView)
```
┌─────────────────────────────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ 🔍 Search history items...            [◀] [▶] 3 matches  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [Clear All History]                                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Jan 11, 2026 2:34 PM              [🗑] [↩ Restore] [▶ Run]│  │
│  │ Agent: correct • Model: sonnet45T                         │  │
│  │ Input: paper.tex • Output: paper_corrected.tex            │  │
│  │ ▶ Show details                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Jan 11, 2026 1:15 PM              [🗑] [↩ Restore] [▶ Run]│  │
│  │ Agent: polish • Model: gpt52                              │  │
│  │ ...                                                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:** (Same as current historyView)
- Search with highlighting (mark.js)
- Delete, Restore, Rerun actions
- Collapsible details per item

**Storage:** Existing history storage mechanism

---

### Profile Tab

**Purpose:** Account management and API keys.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  👤 user@example.com                        [Sign Out]  │    │
│  │     Pro Plan • Ultra Tier                               │    │
│  │     Access expires: Feb 15, 2026                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  MODEL ACCESS                                                  │
│  ─────────────────────────────────────────────────────────────  │
│  ○ Use Included Access                                         │
│    Works automatically. No setup needed.                       │
│                                                                 │
│  ● Use My Own API Keys                                         │
│    Provide your own API keys from providers.                   │
│                                                                 │
│  ▶ View included providers & models                            │
│                                                                 │
│  API KEYS                                                      │
│  ─────────────────────────────────────────────────────────────  │
│  Anthropic    ●●●●●●●●sk-1234              [Edit] [Delete]    │
│  OpenAI       ●●●●●●●●sk-5678              [Edit] [Delete]    │
│  Google       Not configured                      [Add Key]    │
│  DeepSeek     Not configured                      [Add Key]    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

─── or if not logged in ───

┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Sign in to sync settings and access premium features   │    │
│  │                                         [Sign In]       │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  API KEYS (Local Mode)                                         │
│  ─────────────────────────────────────────────────────────────  │
│  Configure API keys to use AI models without an account.       │
│                                                                 │
│  Anthropic    Not configured                      [Add Key]    │
│  OpenAI       Not configured                      [Add Key]    │
│  ...                                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**
- Account info display
- Model access mode toggle (included vs own keys)
- API key management
- Sign in/out

---

## State Management

### Global State (`context.globalState`)

Shared across all workspaces, persists per machine.

```typescript
interface GlobalState {
  // Model preferences - same models everywhere
  enabledModels: string[];

  // Version for migrations
  settingsVersion: number;
}
```

### Workspace State (`context.workspaceState`)

Per-workspace, different projects have different preferences.

```typescript
interface WorkspaceState {
  // Agent preferences - different per project
  enabledAgents: string[];

  // Last selections - restore on reopen
  lastUsedAgent: string;
  lastUsedModel: string;

  // Remote agent settings
  remoteAgentsAutoShow: boolean;

  // Version for migrations
  settingsVersion: number;
}
```

### Defaults (Hardcoded)

```typescript
const RECOMMENDED_MODELS = [
  'sonnet45T', 'opus45T', 'gpt52', 'gemini3p',
  'grok4', 'deepseekT', 'kimi2T', 'qwen3max'
];

const DEFAULT_ENABLED_MODELS = [
  'sonnet45T', 'opus45T', 'gpt52', 'gpt52pro', 'gpt41',
  'gemini3p', 'gemini3f', 'grok4', 'deepseekT',
  'kimi2T', 'kimi2', 'qwen3max'
];

const DEFAULT_ENABLED_AGENTS = [
  'ask', 'chat', 'correct', 'draw', 'ocr',
  'paper2slide', 'paper2poster', 'polish', 'research', 'search'
];
```

---

## Migration Plan

### From VS Code Config to State

| Old (settings.json) | New (Extension State) |
|---------------------|----------------------|
| `texra.models` | `globalState.enabledModels` |
| `texra.agents` | `workspaceState.enabledAgents` |
| `texra.toolUseAgents` | `workspaceState.enabledAgents` |

### Migration Logic

```typescript
async function migrateSettings(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('texra');

  // Migrate models (one-time)
  if (!context.globalState.get('enabledModels')) {
    const oldModels = config.get<string[]>('models');
    if (oldModels?.length) {
      await context.globalState.update('enabledModels', oldModels);
    }
  }

  // Migrate agents (one-time per workspace)
  if (!context.workspaceState.get('enabledAgents')) {
    const oldAgents = config.get<string[]>('agents') ?? [];
    const oldToolUse = config.get<string[]>('toolUseAgents') ?? [];
    const combined = [...new Set([...oldAgents, ...oldToolUse])];
    if (combined.length) {
      await context.workspaceState.update('enabledAgents', combined);
    }
  }
}
```

---

## Architecture

### File Structure

```
src/
├── settingsView/                    # NEW - Unified settings view
│   ├── SettingsViewProvider.ts      # WebviewViewProvider
│   ├── SettingsViewMessageHandler.ts
│   ├── SettingsViewContentProvider.ts
│   ├── index.html                   # Tabbed layout
│   ├── styles.css
│   └── modules/
│       ├── main.js                  # Entry point
│       ├── messageHandlers.js
│       ├── settingsViewState.js
│       ├── tabs/
│       │   ├── ModelsTab.js         # Models tab logic
│       │   ├── AgentsTab.js         # Agents tab logic
│       │   ├── HistoryTab.js        # History tab logic (migrated)
│       │   └── ProfileTab.js        # Profile tab logic (migrated)
│       └── uiManagers/
│           ├── ModelListRenderer.js
│           ├── AgentListRenderer.js
│           ├── HistoryRenderer.js   # From historyView
│           └── ProfileRenderer.js   # From profileView
│
├── profileView/                     # DEPRECATED - merge into settingsView
├── historyView/                     # DEPRECATED - merge into settingsView
```

### Commands

```typescript
// Register command to open settings view
commands.registerCommand('texra.openSettings', (tab?: string) => {
  settingsViewProvider.show();
  if (tab) {
    settingsViewProvider.selectTab(tab); // 'models' | 'agents' | 'history' | 'profile'
  }
});

// Shortcut commands
commands.registerCommand('texra.openModelSettings', () =>
  commands.executeCommand('texra.openSettings', 'models'));
commands.registerCommand('texra.openAgentSettings', () =>
  commands.executeCommand('texra.openSettings', 'agents'));
```

### Message Protocol

```typescript
// Extension → Webview
type SettingsMessage =
  | { command: 'SET_MODELS_DATA', models: ModelInfo[], enabled: string[] }
  | { command: 'SET_AGENTS_DATA', agents: AgentInfo[], enabled: string[] }
  | { command: 'SET_HISTORY_DATA', items: HistoryItem[] }
  | { command: 'SET_PROFILE_DATA', profile: ProfileInfo | null }
  | { command: 'SELECT_TAB', tab: string };

// Webview → Extension
type SettingsAction =
  | { command: 'SAVE_ENABLED_MODELS', models: string[] }
  | { command: 'SAVE_ENABLED_AGENTS', agents: string[] }
  | { command: 'RESTORE_HISTORY', id: string }
  | { command: 'DELETE_HISTORY', id: string }
  | { command: 'SIGN_IN' }
  | { command: 'SIGN_OUT' }
  | { command: 'SET_API_KEY', provider: string, key: string };
```

---

## Open Questions

1. **Deep linking:** Should clicking model dropdown gear go directly to Models tab?
   - **Proposed:** Yes, via `texra.openSettings` command with tab parameter

2. **History size:** History tab may have many items - pagination or virtual scroll?
   - **Proposed:** Keep current approach (load all, search/filter client-side)

3. **Remote agents in profile:** Remove completely or keep summary?
   - **Proposed:** Remove from profile, fully in Agents tab

4. **Settings sync:** Future cloud sync of preferences?
   - **Proposed:** Out of scope for v1, design state structure to support later

---

## Success Metrics

1. Single entry point for all configuration
2. Easy tab navigation (keyboard accessible)
3. State properly persisted (models global, agents per-workspace)
4. History search and restore working
5. Profile/auth flow unchanged

---

## Implementation Phases

### Phase 1: Core Structure
- Create settingsView with tab navigation
- Implement Models tab with provider accordions
- Wire up globalState for model preferences

### Phase 2: Agents Tab
- Implement Agents tab with local/custom/remote sections
- Wire up workspaceState for agent preferences
- Handle remote agents auth state

### Phase 3: Migrate History
- Move history rendering to History tab
- Preserve search, delete, restore, rerun functionality
- Delete old historyView

### Phase 4: Migrate Profile
- Move profile/auth to Profile tab
- Preserve API key management
- Delete old profileView

### Phase 5: Polish
- Add main webview entry point (gear icon)
- Deep link support (open to specific tab)
- Migration from old VS Code config
- Documentation

---

## References

- VS Code Elements: `@vscode-elements/elements`
  - `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel`
  - `vscode-collapsible`, `vscode-checkbox`, `vscode-button`
- LLM Zoo: Model metadata source
- Existing views: `src/profileView/`, `src/historyView/`
