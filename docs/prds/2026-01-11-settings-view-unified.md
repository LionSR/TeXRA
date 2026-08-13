---
created: 2026-01-11
updated: 2026-02-19
---

# PRD: Unified Settings View

**Status:** Partially Implemented
**Author:** Claude
**Date:** 2026-01-11 (updated 2026-02-05)
**Related:** Model dropdown, Agent dropdown, Profile View, History View

---

## Overview

A unified Settings View that consolidates memory management, execution history, model configuration, agent configuration, and profile/account management into a single tabbed interface. This replaces the scattered entry points (profileView, historyView, memoryView) with a cohesive settings experience.

---

## Implementation Status

| Component             | Status  | Notes                                                   |
| --------------------- | ------- | ------------------------------------------------------- |
| Core tabbed structure | Done    | 4 tabs with header bar                                  |
| Memory tab            | Done    | Full file browser with toggle, preview, CRUD            |
| History tab           | Done    | Search (mark.js), restore, rerun, collapsible details   |
| Models tab            | Partial | API access mode toggle + inline provider key management |
| Agents tab            | Partial | Only remote agents table with Select                    |
| LaTeX settings        | VS Code | Remain as VS Code settings only                         |
| Advanced settings     | VS Code | Remain as VS Code settings only                         |
| Header bar            | Done    | Auth/unauth states, sign in/out, VS Code settings gear  |
| Old views removed     | Done    | profileView, historyView, memoryView fully deleted      |
| Lit web components    | Done    | Frontend uses Lit instead of vanilla JS                 |
| Zod schema protocol   | Done    | All messages validated via discriminated union          |

---

## Goals

1. **Single source of truth** - All configuration in one place
2. **Easy navigation** - vscode-tabs with logical groupings
3. **No auth required** - Memory and History tabs work without login
4. **VS Code native** - Use vscode-elements (`@vscode-elements/elements`) components
5. **Proper state management** - Global vs workspace state separation
6. **Backwards compatible** - Extend getConfig rather than replacing it; graceful migration
7. **Minimal custom CSS** - Only header bar needs custom styling, everything else native

---

## User Stories

1. As a user, I want to browse and manage persistent memory files created by agents
2. As a user, I want to browse execution history and restore previous sessions
3. As a user, I want to toggle between included model access and personal API keys
4. As a user, I want to set, remove, and check the status of my provider API keys inline
5. As a user, I want to view and select remote agents shared by my team
6. As a user, I want to easily switch between these configuration pages
7. As a user, I want to configure which models appear in my dropdown _(future)_

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

- Use `@vscode-elements/elements` Lit-compatible web components
- Use native `<details>/<summary>` for collapsible sections
- Keep actions visible (no hover-to-reveal complexity)
- Use standard VS Code color variables via design tokens
- Follow existing webview patterns in the codebase (Lit + Zod)

---

## Design

### Entry Points

**Implemented commands** (in `src/commands/settings/settingsCommands.ts`):

| Command ID               | Action                                       |
| ------------------------ | -------------------------------------------- |
| `texra.showSettingsView` | Opens the Settings View (default tab)        |
| `texra.showDashboard`    | Alias for showSettingsView                   |
| `texra.showMemory`       | Opens Settings View on Memory tab (index 0)  |
| `texra.showAgentHistory` | Opens Settings View on History tab (index 1) |

**Note:** `OPEN_AGENT_SETTINGS` and `OPEN_MODEL_SETTINGS` from the main view still open **native VS Code settings** (filtered to `@ext:texra-ai.texra`), not the unified Settings View.

### Header Bar + Tabs Layout (Implemented)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  👤 user@example.com • Pro Plan                        [⚙️] [Sign Out]     │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Memory]  History  Models  Agents                                          │
│  ════════                                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Tab content area                                                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Not Logged In State:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Use TeXRA with your own API keys                      [⚙️] [Sign In]      │
├─────────────────────────────────────────────────────────────────────────────┤
│  [Memory]  History  Models  Agents                                          │
│  ════════                                                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  ...                                                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

The ⚙️ button opens VS Code's native settings filtered to `@ext:texra-ai.texra`.

**Tab Structure (4 tabs implemented, tab order defined in `SETTINGS_TAB_ORDER`):**

```
Tab 0: Memory       ← IMPLEMENTED
├── Enable/disable toggle
├── Toolbar (Refresh, Open Folder)
└── Memory file list with expandable content preview

Tab 1: History      ← IMPLEMENTED
├── Search bar with prev/next navigation and match counter
├── Clear All History button
└── History items with delete/restore/rerun actions

Tab 2: Models       ← PARTIAL (API access mode + provider keys)
├── API access mode radio (if authenticated: Included Access vs Personal Keys)
└── Provider key list (always shown, all users)
    ├── 9 providers with three-state status (Set / Env / Not Set)
    └── Per-provider actions: Set Key, Get Key, Remove

Tab 3: Agents       ← PARTIAL (remote agents only)
├── Sign-in prompt (if unauthenticated)
└── Remote agents table with Select buttons
```

**Remain as VS Code settings only:**

LaTeX settings (formatter, latexdiff, TikZ, replacements) and advanced settings (multi-agent, UI preferences, git, system paths, debug) are configured via VS Code's built-in Settings UI.

---

## Tab Specifications

### Memory Tab (Implemented)

**Purpose:** Browse and manage persistent memory files created by tool-use agents.

**Components:**

- `<memory-tab>` - Tab container
- `<memory-toolbar>` - Refresh + Open in file explorer buttons
- `<memory-toggle>` - Enable/disable memory checkbox (`getToolUseMemoryEnabled`/`setToolUseMemoryEnabled`)
- `<memory-list>` - List of memory items
- `<memory-item>` - Individual file with metadata and collapsible content preview

**Layout (Implemented):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Memory                                                         │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ☑ Enable memory for chat agents                               │
│  Memory files created by tool-use agents.                       │
│                                                                 │
│                                         [Refresh] [Open Folder] │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  📄 project-notes.md                                            │
│     12 KB • 45 lines • Jan 11, 2:34 PM                         │
│     ▶ Contents                              [Open] [Delete]    │
│                                                                 │
│  📄 research-findings.md                                        │
│     8 KB • 23 lines • Jan 10, 4:12 PM                          │
│     ▶ Contents                              [Open] [Delete]    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**

- Memory file browser with expandable content preview (max 20 lines, 500 chars)
- Click "Open" to open file in editor
- Delete with confirmation dialog (native VS Code modal)
- Open folder in OS file explorer
- Toggle memory enabled/disabled for chat agents
- Refresh button to reload file list

**Data Sources:** Memory storage directory (walked recursively by `loadMemoryItems()`)

**Storage:** File system (no extension state needed)

---

### History Tab (Implemented)

**Purpose:** Browse and restore previous agent executions.

**Components:**

- `<history-tab>` - Tab container
- `<search-bar>` - Text input with debounced search (300ms), prev/next navigation, match counter
- `<history-list>` - Sorted list with Clear All button
- `<history-item>` - Individual entry with mark.js highlighting

**Layout (Implemented):**

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
│  │ [workflow] correct • Model: sonnet45T                     │  │
│  │ Instruction: Fix typos and grammar errors                 │  │
│  │ Input: paper.tex                                          │  │
│  │ ▶ More details                                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Jan 11, 2026 1:15 PM              [🗑] [↩ Restore] [▶ Run]│  │
│  │ [toolUse] chat • Model: gpt52                             │  │
│  │ ...                                                       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:**

- Search with highlighting (mark.js) across all items
- Cross-item search navigation (global match index, prev/next buttons)
- Per-item actions: Delete, Restore (sets agent config in main view), Rerun (executes agent)
- Collapsible "More details" showing reference files, auxiliary files, output files, tool config
- Items sorted by timestamp (newest first)
- Agent category badge, agent name, model, instruction, input/media files displayed
- State persistence: search index, total matches, toggle states saved via Zod schema (`HistoryViewState`)

**Storage:** Existing `AgentHistoryManager` storage mechanism

---

### Models Tab (Partially Implemented)

**Purpose:** Model access configuration and provider API key management.

**What's implemented:**

- API access mode radio (`<api-access-section>`): "Use Included Access" vs "Use My Own Keys" (authenticated users only)
- When "included" is selected, shows collapsible summary: provider count + model count/list
- Error state if providers can't be loaded
- Provider key list (`<provider-key-list>`): inline table of all 9 providers with three-state status and actions (available to all users, including unauthenticated)
- Three-state key status: `Set` (stored in SecretStorage), `Env` (environment variable only), `Not Set`
- Per-provider actions: "Set Key" (opens VS Code native password input), "Get Key" (opens provider URL in browser), "Remove" (only shown for SecretStorage keys)
- Context-aware description: different text when using included access vs personal keys

**Layout (Current - Authenticated):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Model Access                                                   │
│                                                                 │
│  ● Use Included Access                                          │
│    ▶ Included: 3 providers, 12 models                          │
│  ○ Use My Own Keys                                              │
│                                                                 │
│  API Keys                                                       │
│  You are using included access. Personal keys below are         │
│  optional overrides.                                            │
│  ┌───────────┬──────────┬─────────────────────────────────────┐ │
│  │ Provider  │ Status   │ Actions                             │ │
│  ├───────────┼──────────┼─────────────────────────────────────┤ │
│  │ OpenAI    │ ✓ Set    │ [Set Key] [Get Key] [Remove]        │ │
│  │ Anthropic │ ● Env    │ [Set Key] [Get Key]                 │ │
│  │ Google    │ ○ Not Set│ [Set Key] [Get Key]                 │ │
│  │ ...       │          │                                     │ │
│  └───────────┴──────────┴─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Layout (Current - Unauthenticated):**

```
┌─────────────────────────────────────────────────────────────────┐
│  API Keys                                                       │
│  Set API keys for the providers you want to use.                │
│  ┌───────────┬──────────┬─────────────────────────────────────┐ │
│  │ Provider  │ Status   │ Actions                             │ │
│  ├───────────┼──────────┼─────────────────────────────────────┤ │
│  │ OpenAI    │ ○ Not Set│ [Set Key] [Get Key]                 │ │
│  │ Anthropic │ ○ Not Set│ [Set Key] [Get Key]                 │ │
│  │ ...       │          │                                     │ │
│  └───────────┴──────────┴─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**What's NOT yet implemented:**

- Model selection checkboxes (per-model enable/disable)
- Recommended models section
- Per-provider collapsibles with model lists
- Provider configuration modal (endpoint + streaming toggle)
- Routing options (direct/OpenRouter/proxy)
- Model metadata display (cost, context window, capabilities)

**Future Models Tab Layout (Not Yet Built):**

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

**Data Source:** `llm-zoo` package (ModelRegistry)

**Model Metadata (for future display):**

- Name (display name)
- Context window
- Cost (input/output per 1M tokens)
- Capabilities icons: 🧠 Reasoning, 👁 Vision, 📄 PDF, 🎧 Audio, 💬 Tools, ⚡ Cache

**Storage:** `globalState.enabledModels: string[]`, `globalState.providerConfig`

---

### Agents Tab (Partially Implemented)

**Purpose:** View and select agents. Currently limited to remote agents.

**What's implemented:**

- Sign-in prompt for unauthenticated users (`<sign-in-prompt>`)
- Remote agents table (`<agents-table>`) with columns: Name, Category badge, Multi-Output badge, Description, Visibility badge, Select button
- Clicking Select dispatches `selectAgentInMainView()` to set the agent in the main webview
- "No remote agents available" message when empty

**Layout (Current):**

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────┬──────────┬───────┬─────────────────┬────┬────────┐│
│  │ Name    │ Category │ Multi │ Description     │ 👁 │ Action ││
│  ├─────────┼──────────┼───────┼─────────────────┼────┼────────┤│
│  │ review  │ workflow │       │ Reviews papers  │ 🌐 │ Select ││
│  │ chat-v2 │ toolUse  │ ✓     │ Enhanced chat   │ 🔒 │ Select ││
│  └─────────┴──────────┴───────┴─────────────────┴────┴────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**What's NOT yet implemented:**

- Built-in agents list with enable/disable checkboxes
- Custom agents list with Source Code / Delete actions
- Workflow Settings collapsible (output storage mode)
- Tool-Use Settings collapsible (edit approval, persistence, compaction, retry)
- Advanced collapsible (custom agents directory)

**Future Agents Tab Layout (Not Yet Built):**

```
┌─────────────────────────────────────────────────────────────────┐
│  Select which agents appear in the dropdown.                    │
│                                                                 │
│  BUILT-IN AGENTS                                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ chat      Interactive conversation       $(tools)       │  │
│  │ ☑ correct   Fix typos & LaTeX errors       $(lightbulb)   │  │
│  │ ☑ polish    Improve writing quality        $(lightbulb)   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  CUSTOM AGENTS                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ my-reviewer   Reviews papers for clarity                │  │
│  │                              [Source Code] [Delete]       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  REMOTE AGENTS                                                 │
│  (current agents table implementation)                         │
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
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Settings Mapping (for future implementation):**

| UI Element                 | Storage                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| Auto-show remote agents    | `globalState.autoShowRemoteAgents`                                    |
| Agent visibility           | `workspaceState.enabledAgents`, `workspaceState.enabledToolUseAgents` |
| Custom agents directory    | `globalState.customAgentDir`                                          |
| Storage mode dropdown      | `texra.agentOutputs.storageMode` (VS Code config)                     |
| Require approval checkbox  | `texra.toolUse.requireEditApproval` (VS Code config)                  |
| Persist sessions checkbox  | `texra.toolUse.persistence.enabled` (VS Code config)                  |
| Session retention dropdown | `texra.toolUse.persistence.ttlHours` (VS Code config)                 |
| Compaction threshold       | `texra.model.compactionThresholdPercent` (VS Code config)             |
| Max attempts               | `texra.model.retry.maxAttempts` (VS Code config)                      |
| Backoff delay              | `texra.model.retry.backoffMs` (VS Code config)                        |

**Storage:** State managers for agent settings, VS Code configuration for remaining settings

---

---

### Features Summary

**Implemented (4 tabs):**

- **Header Bar** - Account info (email + tier), sign in/out, VS Code settings gear (always visible)
- **Memory Tab** - Full memory file browser with toggle, toolbar, content preview, delete
- **History Tab** - Full execution history with search (mark.js), restore, rerun, collapsible details
- **Models Tab** - API access mode toggle + inline provider key management (set/remove/status for 9 providers)
- **Agents Tab** - Remote agents table with Select action

**Not yet implemented:**

- **Models Tab expansion** - Model selection UI, provider configuration (endpoint + streaming), routing options
- **Agents Tab expansion** - Built-in/custom agent lists, enable/disable, Workflow/Tool-Use settings

**Remain as VS Code settings only:**

- **LaTeX settings** - Formatter, latexdiff, TikZ, replacements
- **Advanced settings** - Multi-agent, UI preferences, git, system paths, debug

---

## State Management

### VS Code Configuration (Primary)

Settings View reads/writes directly to VS Code configuration using `ConfigurationTarget`:

```typescript
const config = vscode.workspace.getConfiguration('texra');

// Global settings (user-level, all workspaces)
await config.update('models', enabledModels, ConfigurationTarget.Global);

// Workspace settings (project-level, .vscode/settings.json)
await config.update('agents', enabledAgents, ConfigurationTarget.Workspace);
```

**Setting Scopes:**

| Setting                          | ConfigurationTarget | Reason                                   |
| -------------------------------- | ------------------- | ---------------------------------------- |
| `texra.models`                   | Global              | Same models everywhere                   |
| Provider endpoints               | Global              | Same API setup everywhere                |
| Agent visibility                 | Workspace           | Different projects need different agents |
| `texra.agentOutputs.storageMode` | Workspace           | Project-specific output location         |
| `texra.toolUse.*`                | Global              | Consistent behavior                      |
| `texra.latex.*`                  | Global/Workspace    | User choice                              |

### Secret Storage (`context.secrets`)

Secure credential storage (VS Code SecretStorage API). Unchanged from existing implementation.

### Environment Variable Fallback

API keys can also be set via environment variables (existing behavior).

**Priority order:**

1. VS Code Secrets (highest)
2. Environment variables
3. `.env` file in workspace

---

## Architecture (Implemented)

### Technology Stack

- **Lit** (Web Components) for the frontend UI
- **Zod v4** schemas for all message validation (both inbound and outbound)
- **mark.js** for search highlighting in history
- **@vscode-elements/elements** for native-looking VS Code components

### File Structure (Current)

```
src/
├── settingsView/                                 # Unified settings view
│   ├── index.html                                # HTML shell
│   ├── SettingsViewProvider.ts                    # VS Code WebviewViewProvider
│   ├── SettingsViewContentProvider.ts             # Bundle URI provider
│   ├── SettingsViewMessageHandler.ts              # Backend message handler (all domains)
│   ├── utils/
│   │   └── memoryFileSystem.ts                    # Memory directory walker + preview builder
│   └── frontend/
│       ├── index.ts                               # Entry point (imports SettingsApp)
│       ├── SettingsApp.ts                         # Root Lit component (<settings-app>)
│       ├── styles.ts                              # Shared styles across all tabs
│       ├── tabs/
│       │   ├── MemoryTab.ts                       # Memory tab component
│       │   ├── HistoryTab.ts                      # History tab component
│       │   ├── ModelsTab.ts                       # Models tab component
│       │   └── AgentsTab.ts                       # Agents tab component
│       └── components/
│           ├── memory/
│           │   ├── MemoryToolbar.ts                # Refresh + Open folder toolbar
│           │   ├── MemoryToggle.ts                 # Enable/disable memory checkbox
│           │   ├── MemoryList.ts                   # List of memory items
│           │   ├── MemoryItem.ts                   # Single memory entry with preview
│           │   └── events.ts                       # Memory-related custom events
│           ├── history/
│           │   ├── SearchBar.ts                    # Search input with nav controls
│           │   ├── HistoryList.ts                  # Searchable list of history items
│           │   ├── HistoryItem.ts                  # Single history entry with mark.js
│           │   ├── events.ts                       # History-related custom events
│           │   ├── state.ts                        # Persisted search/toggle state (Zod)
│           │   └── styles.ts                       # History-specific CSS
│           └── profile/
│               ├── ApiAccessSection.ts             # Included vs Personal API key radio
│               ├── ProviderKeyList.ts              # Provider key status table with actions
│               ├── ProfileInfo.ts                  # User email/ID/tier display
│               ├── SignInPrompt.ts                 # Unauthenticated state prompt
│               ├── AgentsTable.ts                  # Remote agents table with Select
│               ├── events.ts                       # Profile + provider key custom events
│               └── styles.ts                       # Profile-specific CSS (shared table styles)
│
├── shared/schemas/
│   ├── settingsViewMessages.ts                    # Unified Zod schemas + dispatcher
│   ├── memoryViewMessages.ts                      # Memory data schemas (re-exported)
│   ├── historyViewMessages.ts                     # History data schemas (re-exported)
│   └── profileViewMessages.ts                     # Profile data schemas (re-exported)
│
├── commands/settings/
│   └── settingsCommands.ts                        # Command registration
│
├── profileView/                                   # REMOVED (merged into settingsView)
├── historyView/                                   # REMOVED (merged into settingsView)
├── memoryView/                                    # REMOVED (merged into settingsView)
```

### Component Architecture

```
<settings-app>                    # Root Lit element, holds all state
├── Header bar (inline render)    # Auth/unauth states
└── <vscode-tabs>                 # Native tab navigation
    ├── <memory-tab>              # Delegates to memory components
    │   ├── <memory-toggle>
    │   ├── <memory-toolbar>
    │   └── <memory-list>
    │       └── <memory-item> (×N)
    ├── <history-tab>             # Delegates to history components
    │   ├── <search-bar>
    │   └── <history-list>
    │       └── <history-item> (×N)
    ├── <models-tab>              # Mixed auth
    │   ├── <api-access-section>  # (if authenticated)
    │   └── <provider-key-list>   # (always shown)
    └── <agents-tab>              # Auth-gated
        ├── <sign-in-prompt>      # (if not authenticated)
        └── <agents-table>        # (if authenticated)
```

All state lives in `<settings-app>` and flows down via Lit reactive properties. Events bubble up from child components to `SettingsApp` which sends `postMessage()` to the backend.

### Message Protocol (Implemented)

**Schema file:** `src/shared/schemas/settingsViewMessages.ts`

**Tab order constant:**

```typescript
export const SETTINGS_TAB_ORDER = [
  'MEMORY',
  'HISTORY',
  'MODELS',
  'AGENTS',
] as const;
```

**Inbound commands (frontend → backend): 19 total**

| Domain     | Commands                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation | `openVscodeSettings`                                                                                                                  |
| Memory     | `getMemoryData`, `openMemoryFile`, `openMemoryFolder`, `deleteMemory`, `getMemoryEnabled`, `setMemoryEnabled`                         |
| History    | `getHistoryData`, `rerunAgent`, `restoreAgent`, `deleteAgent`, `clearHistory`                                                         |
| Profile    | `getProfileData`, `selectAgent`, `signIn`, `signOut`, `setApiAccessMode`, `setProviderKey`, `removeProviderKey`, `openProviderKeyUrl` |

**Outbound commands (backend → frontend): 6 total**

| Domain     | Commands                              |
| ---------- | ------------------------------------- |
| Navigation | `setTab`                              |
| Memory     | `updateMemory`, `updateMemoryEnabled` |
| History    | `updateHistory`, `historyCleared`     |
| Profile    | `updateProfile`                       |

The `updateProfile` outbound message includes `providerKeyStatuses` (array of `{provider, displayName, status, keyUrl}`) with `.default([])` for backward compatibility.

All messages validated via `z.discriminatedUnion('command', [...])` with type-safe handler registry and `dispatchSettingsViewInbound()` dispatcher.

### Backend Message Handler

`SettingsViewMessageHandler` extends `BaseViewMessageHandler` and directly implements all handlers (no delegation to sub-handlers). Combines Memory, History, and Profile domains into a single handler registry.

Key methods:

- `sendAllData(webview)` - Sends all data in parallel on view open
- `sendMemoryData/sendMemoryEnabled/sendHistoryData/sendProfileData` - Individual domain senders

### Code Reuse Patterns

```
src/settingsView/
├── SettingsViewProvider.ts         # extends BaseWebviewProvider
├── SettingsViewMessageHandler.ts   # extends BaseViewMessageHandler
├── SettingsViewContentProvider.ts  # extends BaseViewContentProvider
```

---

## Implementation Phases

### Done: Phase 1 - Core Structure + Memory + History

- [x] Create settingsView with vscode-tabs + header bar (Lit components)
- [x] Implement header bar (account info, sign in/out, VS Code settings gear)
- [x] Migrate memoryView to Memory tab (expandable content preview, CRUD)
- [x] Migrate historyView to History tab (search, restore, rerun)
- [x] Zod schema-driven message protocol (discriminated union dispatcher)
- [x] Delete old standalone views (profileView, historyView, memoryView)
- [x] Deep link support (open to specific tab via command)
- [x] API access mode toggle (included vs personal keys)
- [x] Remote agents table with Select

### Next: Phase 2 - Models Tab Expansion

- [x] Inline provider key management (set/remove/status for all 9 providers)
- [x] Three-state key status (Set via SecretStorage, Env var, Not Set)
- [x] Available without login (unauthenticated users see provider key list directly)
- [x] Backend `showInputBox` for secure password entry
- [x] Refresh main view API key status after key changes
- [ ] Implement model selection UI with per-model checkboxes
- [ ] Add recommended models section
- [ ] Add per-provider collapsibles with model lists
- [ ] Provider configuration modal (custom endpoint + streaming toggle)
- [ ] Routing options (direct/OpenRouter/proxy radio group)
- [ ] Model metadata display from llm-zoo (cost, context window, capabilities)
- [ ] Wire `OPEN_MODEL_SETTINGS` from main view to Settings View Models tab

### Next: Phase 3 - Agents Tab Expansion

- [ ] Built-in agents list with enable/disable checkboxes
- [ ] Custom agents list with Source Code / Delete actions
- [ ] Add Workflow Settings collapsible (output storage mode)
- [ ] Add Tool-Use Settings collapsible (edit approval, persistence, compaction, retry)
- [ ] Include Advanced collapsible (custom agents directory)
- [ ] Wire `OPEN_AGENT_SETTINGS` from main view to Settings View Agents tab

---

## Settings Coverage Summary

Based on settings in package.json:

### Implemented

| Tab         | Settings Covered                                                                                                                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Models**  | `texra.model.apiAccessMode` (included vs personal), provider API key management (9 providers via SecretStorage), `texra.model.useStreaming*` (9 streaming toggles), per-provider custom endpoint (`texra.model.baseUrl*`, 7 providers), model visibility (state manager), polish model selection |
| **Agents**  | Agent visibility — workflow and tool-use (workspace state), auto-show remote agents (global state), custom agents directory (global state), create agent with AI                                                                                                                                 |
| **Memory**  | Memory file browser (file system, no config needed)                                                                                                                                                                                                                                              |
| **History** | History browser (existing storage)                                                                                                                                                                                                                                                               |

### Not Yet Implemented

| Tab        | Settings to Cover                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Models** | `texra.model.useOpenRouter`, `texra.model.useImprovedConnection`, `texra.model.improvedConnectionDomain`                     |
| **Agents** | `texra.agentOutputs.storageMode`, `texra.toolUse.*` (3), `texra.model.compactionThresholdPercent`, `texra.model.retry.*` (2) |

### Remain as VS Code Settings Only

These settings are configured via VS Code's built-in Settings UI:

- `texra.latex.*` (7), `texra.latexdiff.*` (4) - LaTeX formatting, latexdiff, TikZ, replacements
- `texra.ui.*` (3), `texra.progressBoard.streamSortOrder`, `texra.maxImageDimension` - UI preferences
- `texra.git.numberOfCommitsToShow` - Git integration
- `texra.audio.soxPath` - System paths
- `texra.debug.*`, `texra.logger.*` - Debug settings
- `texra.files.*` (16) - File type filtering patterns
- `texra.auth.*` (3) - System-level authentication endpoints

---

## Integration Surface Areas

### Currently Active

| Location                         | Behavior                          |
| -------------------------------- | --------------------------------- |
| `texra.showSettingsView` command | Opens Settings View               |
| `texra.showDashboard` command    | Opens Settings View (alias)       |
| `texra.showMemory` command       | Opens Settings View → Memory tab  |
| `texra.showAgentHistory` command | Opens Settings View → History tab |

### Still Pointing to VS Code Settings (To Be Updated)

| Location                        | Current Behavior                          | Target Behavior              |
| ------------------------------- | ----------------------------------------- | ---------------------------- |
| Main view "Open Agent Settings" | Opens VS Code settings filtered to agents | → Settings View (Agents tab) |
| Main view "Open Model Settings" | Opens VS Code settings filtered to models | → Settings View (Models tab) |

### No Change Needed

| Function                | File                               | Impact                                                               |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `computeAgentOptions()` | `src/agent/index/agentRegistry.ts` | Reads VS Code config - no change                                     |
| `computeModelOptions()` | `src/model/computeModelOptions.ts` | Reads VS Code config - no change                                     |
| Config watchers         | `src/MainViewProvider.ts`          | Settings View writes to VS Code config - watchers work automatically |

---

## Open Questions

1. **Models tab scope:** How much of the full model selection UI (provider collapsibles, model checkboxes, routing) should be built next vs keeping the current minimal API access toggle?

2. **LaTeX tab priority:** Should the LaTeX tab be implemented before completing Models/Agents expansion?

3. **Deep linking from main view:** When should `OPEN_MODEL_SETTINGS` and `OPEN_AGENT_SETTINGS` be redirected from VS Code native settings to the Settings View?

4. **History pagination:** History tab currently loads all items. If history grows large, should we add pagination or virtual scroll?

---

## References

- VS Code Elements: `@vscode-elements/elements` (Lit-compatible web components)
  - Tabs: `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel`
  - Actions: `vscode-button`, `vscode-badge`
  - Forms: `vscode-single-select`, `vscode-checkbox`, `vscode-textfield`
- Lit: Web component framework for frontend
- Zod v4: Schema validation for all message protocols
- mark.js: Search highlighting in history tab
- Base Classes: `src/common/webview/Base*.ts`
- Shared Styles: `src/shared/styles/`
- LLM Zoo: Model metadata source (for future Models tab)
