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
│  [Models]   Agents    Memory    History    Profile              │
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
  <vscode-tab-header slot="header">Memory</vscode-tab-header>
  <vscode-tab-header slot="header">History</vscode-tab-header>
  <vscode-tab-header slot="header">Profile</vscode-tab-header>

  <vscode-tab-panel id="modelsPanel">
    <!-- Models tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="agentsPanel">
    <!-- Agents tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="memoryPanel">
    <!-- Memory tab content -->
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

### Memory Tab

**Purpose:** Manage persistent agent memory and conversation settings.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Persistent memory storage for tool-use agents.                 │
│                                                                 │
│  CONVERSATION PERSISTENCE                                      │
│  ─────────────────────────────────────────────────────────────  │
│  ☑ Persist conversations across VS Code restarts               │
│    Sessions are saved and can be resumed later.                │
│                                                                 │
│  Session retention: [72 hours ▼]                               │
│    Options: 24h, 48h, 72h, 1 week, 2 weeks                     │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  MEMORY FILES                                     [Refresh]    │
│  ─────────────────────────────────────────────────────────────  │
│  Agent-created memory files stored in /memories                 │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📄 project-notes.md           12 KB    Jan 11, 2:34 PM    │  │
│  │    Project context and key decisions...                   │  │
│  │                                         [View] [Delete]   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📄 research-findings.md       8 KB     Jan 10, 4:12 PM    │  │
│  │    Literature review notes and citations...               │  │
│  │                                         [View] [Delete]   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 📁 figures/                   3 files  Jan 9, 11:00 AM    │  │
│  │                                         [Browse]          │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Total: 5 files, 24 KB                        [Clear All]      │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ACTIVE SESSIONS                                               │
│  ─────────────────────────────────────────────────────────────  │
│  Tool-use sessions waiting for continuation.                    │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ research (chat)               Jan 11, 1:15 PM   WAITING   │  │
│  │ "Help me analyze the survey results..."                   │  │
│  │                                      [Resume] [Discard]   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ paper-writing (chat)          Jan 10, 3:00 PM   WAITING   │  │
│  │ "Continue editing section 3..."                           │  │
│  │                                      [Resume] [Discard]   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:** (Migrated from memoryView)
- Conversation persistence toggle and TTL setting
- Memory file browser (from existing memoryView)
- File preview, delete actions
- Directory browsing (2-level deep)
- Active session list with resume/discard
- Storage usage display

**Data Sources:**
- Memory files: `/memories` directory managed by MemoryTool
- Active sessions: Tool-use session snapshots
- Settings: `texra.toolUse.persistence.*`

**Storage:** `workspaceState` for persistence settings

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

**Purpose:** Account management, API provider configuration, and routing settings.

**Layout (Logged In):**
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ACCOUNT                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  👤 user@example.com                        [Sign Out]  │    │
│  │     Pro Plan • Ultra Tier                               │    │
│  │     Access expires: Feb 15, 2026                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  MODEL ACCESS MODE                                             │
│  ─────────────────────────────────────────────────────────────  │
│  ● Use Included Access                                         │
│    Works automatically. No setup needed.                       │
│    ▶ View included providers & models                          │
│                                                                 │
│  ○ Use My Own API Keys                                         │
│    Configure providers below.                                  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  API PROVIDERS                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Configure API keys and endpoints for each provider.           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Anthropic                                        [Edit]  │  │
│  │ ✓ API Key configured                                     │  │
│  │ Endpoint: default                                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ OpenAI                                           [Edit]  │  │
│  │ ✓ API Key configured                                     │  │
│  │ Endpoint: default                                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Google                                      [Configure]  │  │
│  │ ✗ API Key not set                                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ OpenRouter                                  [Configure]  │  │
│  │ ✗ API Key not set                                        │  │
│  │ ℹ Route multiple providers through one API key           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ More providers (DeepSeek, xAI, Moonshot, DashScope)         │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ROUTING OPTIONS                                               │
│  ─────────────────────────────────────────────────────────────  │
│  ● Direct to providers (recommended)                           │
│    Connect directly to each provider's API                     │
│                                                                 │
│  ○ Route all through OpenRouter                                │
│    Use OpenRouter for unified billing (requires OpenRouter key)│
│                                                                 │
│  ○ Use connection proxy                                        │
│    Route through proxy.texra.ai for improved connectivity      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Layout (Not Logged In):**
```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ACCOUNT                                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  Use TeXRA with your own API keys            [Sign In]  │    │
│  │  Sign in to sync settings across devices                │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  API PROVIDERS                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Configure API keys to use AI models.                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Anthropic                               [Configure]      │  │
│  │ ✗ API Key not set                                        │  │
│  │ Models: Claude Sonnet 4.5, Claude Opus 4.5, ...          │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ OpenAI                                  [Configure]      │  │
│  │ ✗ API Key not set                                        │  │
│  │ Models: GPT-5.2, GPT-4.1, o4-mini, ...                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ OpenRouter                              [Configure]      │  │
│  │ ✗ API Key not set                                        │  │
│  │ ℹ Access ALL providers with a single API key             │  │
│  │   Get your key at openrouter.ai/keys                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ More providers (Google, DeepSeek, xAI, Moonshot, DashScope) │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  💡 TIP: Use OpenRouter to access all models with one key      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### Provider Configuration Modal

When clicking [Edit] or [Configure] on a provider:

**Standard Provider (Anthropic, OpenAI, Google, etc.):**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure Anthropic                                     [×]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  API Key                                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ sk-ant-api03-●●●●●●●●●●●●●●●●●●●●            [👁] [Clear] │  │
│  └───────────────────────────────────────────────────────────┘  │
│  Get your key at: console.anthropic.com                        │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Alternative: Environment Variable                             │
│  Set ANTHROPIC_API_KEY in your environment or .env file        │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ▶ Advanced Options                                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Custom Endpoint (optional)                                │  │
│  │ ┌─────────────────────────────────────────────────────┐   │  │
│  │ │                                                     │   │  │
│  │ └─────────────────────────────────────────────────────┘   │  │
│  │ Leave empty for default (api.anthropic.com)               │  │
│  │ Use for: proxies, Azure OpenAI, self-hosted models        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                            [Cancel]   [Save]   │
└─────────────────────────────────────────────────────────────────┘
```

**OpenRouter (Special Case):**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure OpenRouter                                    [×]   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  OpenRouter provides access to 200+ AI models from multiple    │
│  providers through a single API key and unified billing.       │
│                                                                 │
│  API Key                                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ sk-or-v1-●●●●●●●●●●●●●●●●●●●●●●●●            [👁] [Clear] │  │
│  └───────────────────────────────────────────────────────────┘  │
│  Get your key at: openrouter.ai/keys                           │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Routing Mode                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ● OpenRouter-only models                                      │
│    Only use OpenRouter for models that require it              │
│    (marked with 🔀 in model list)                              │
│                                                                 │
│  ○ Route ALL models through OpenRouter                         │
│    Use OpenRouter for every model request                      │
│    Benefits: unified billing, usage tracking, fallbacks        │
│    Note: Slightly higher latency, OpenRouter pricing applies   │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                            [Cancel]   [Save]   │
└─────────────────────────────────────────────────────────────────┘
```

---

### Provider Status Indicators

In the Models tab, show provider/routing status on each model:

```
┌───────────────────────────────────────────────────────────────┐
│ ☑ Claude Sonnet 4.5 T    $3/$15   200K   🧠👁  ✓ Ready       │  ← Key configured
│ ☑ GPT-5.2                $2/$10   256K   🧠👁  ✓ Ready       │
│ ☐ Gemini 3 Pro           $1.25/$5 1M     🧠👁  ⚠ No key      │  ← Missing key
│ ☑ Llama 3 405B           $0.90/$0 128K   🧠    🔀 OpenRouter │  ← OpenRouter only
└───────────────────────────────────────────────────────────────┘
```

**Status Icons:**
- `✓ Ready` - API key configured, model available
- `⚠ No key` - Provider not configured (click to configure)
- `🔀 OpenRouter` - Available via OpenRouter only
- `🔒 Premium` - Requires subscription tier (if using included access)

---

### Features Summary

**Profile Tab Features:**
- Account info display (if logged in)
- Model access mode toggle (included vs own keys) - only when logged in
- Per-provider configuration cards
- Provider modal with API key + custom endpoint
- OpenRouter special configuration (routing mode)
- Global routing options (direct/OpenRouter/proxy)
- Sign in/out
- Environment variable hints

**Key UX Improvements:**
1. **Works without login** - Configure API keys without account
2. **Visual provider status** - See which providers are configured at a glance
3. **Custom endpoints exposed** - No more hidden VS Code settings
4. **OpenRouter simplified** - Clear explanation and routing options
5. **Model availability feedback** - See which models are ready in Models tab

---

## State Management

### Global State (`context.globalState`)

Shared across all workspaces, persists per machine.

```typescript
interface GlobalState {
  // Model preferences - same models everywhere
  enabledModels: string[];

  // Provider configuration (non-secret parts)
  providerConfig: {
    [providerId: string]: {
      customEndpoint?: string;   // Custom base URL (empty = default)
      enabled: boolean;          // Show in provider list
    };
  };

  // Routing preferences
  routing: {
    mode: 'direct' | 'openrouter' | 'proxy';  // Global routing strategy
    openRouterMode: 'exclusive' | 'all';       // Only OR-models vs all
    proxyDomain?: string;                      // Custom proxy domain
  };

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

### Secret Storage (`context.secrets`)

Secure credential storage (VS Code SecretStorage API).

```typescript
// Keys stored in secrets (unchanged from current implementation)
// apiKey.anthropic
// apiKey.openai
// apiKey.google
// apiKey.openRouter
// apiKey.deepseek
// apiKey.xai
// apiKey.moonshot
// apiKey.dashscope

// Access via SecretManager
SecretManager.getApiKey('anthropic');
SecretManager.setApiKey('anthropic', 'sk-...');
SecretManager.deleteApiKey('anthropic');
```

### Environment Variable Fallback

API keys can also be set via environment variables (existing behavior):

```bash
# In shell or .env file
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
DEEPSEEK_API_KEY=...
XAI_API_KEY=...
```

**Priority order:**
1. VS Code Secrets (highest)
2. Environment variables
3. `.env` file in workspace

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

const DEFAULT_ROUTING = {
  mode: 'direct',
  openRouterMode: 'exclusive',
};

// Provider metadata (for display)
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    envVar: 'ANTHROPIC_API_KEY',
    defaultEndpoint: 'https://api.anthropic.com',
  },
  openai: {
    name: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    envVar: 'OPENAI_API_KEY',
    defaultEndpoint: 'https://api.openai.com/v1',
  },
  google: {
    name: 'Google',
    keyUrl: 'https://aistudio.google.com/apikey',
    envVar: 'GOOGLE_API_KEY',
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
  },
  openRouter: {
    name: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    envVar: 'OPENROUTER_API_KEY',
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    description: 'Access 200+ models with a single API key',
  },
  deepseek: {
    name: 'DeepSeek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    envVar: 'DEEPSEEK_API_KEY',
    defaultEndpoint: 'https://api.deepseek.com',
  },
  xai: {
    name: 'xAI (Grok)',
    keyUrl: 'https://console.x.ai',
    envVar: 'XAI_API_KEY',
    defaultEndpoint: 'https://api.x.ai/v1',
  },
  moonshot: {
    name: 'Moonshot (Kimi)',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    envVar: 'MOONSHOT_API_KEY',
    defaultEndpoint: 'https://api.moonshot.cn/v1',
  },
  dashscope: {
    name: 'DashScope (Qwen)',
    keyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    envVar: 'DASHSCOPE_API_KEY',
    defaultEndpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  },
};
```

---

## Migration Plan

### Critical: API Keys Storage - NO CHANGE

**API keys remain in VS Code SecretStorage.** This is non-negotiable:

```typescript
// UNCHANGED - Keys stay in VS Code Secrets
context.secrets.get('apiKey.anthropic');
context.secrets.store('apiKey.anthropic', 'sk-...');

// Environment variable fallback also unchanged
process.env.ANTHROPIC_API_KEY
```

Users who have configured API keys will continue to work without any action.

---

### What Moves to Extension State

| Setting | From | To | Reason |
|---------|------|-----|--------|
| `texra.models` | VS Code config | `globalState.enabledModels` | UI in Models tab |
| `texra.agents` | VS Code config | `workspaceState.enabledAgents` | UI in Agents tab |
| `texra.toolUseAgents` | VS Code config | `workspaceState.enabledAgents` | Merge with agents |
| `texra.model.useOpenRouter` | VS Code config | `globalState.routing.mode` | UI in Profile tab |
| `texra.model.useImprovedConnection` | VS Code config | `globalState.routing.mode` | UI in Profile tab |
| `texra.model.improvedConnectionDomain` | VS Code config | `globalState.routing.proxyDomain` | UI in Profile tab |
| `texra.toolUse.persistence.enabled` | VS Code config | `workspaceState.memorySettings` | UI in Memory tab |
| `texra.toolUse.persistence.ttlHours` | VS Code config | `workspaceState.memorySettings` | UI in Memory tab |

### What Stays in VS Code Config

These remain in VS Code settings (advanced, rarely changed, or system paths):

- `texra.model.useStreaming*` - Provider-specific streaming toggles
- `texra.model.compactionThresholdPercent` - Advanced context management
- `texra.model.baseUrlDeepSeek` - Custom endpoint (moved to globalState.providerConfig)
- `texra.latex.*` - LaTeX formatter settings
- `texra.files.*` - File handling patterns
- `texra.latexdiff.*` - Diff settings
- `texra.logger.*`, `texra.debug.*` - Development settings
- `texra.audio.soxPath`, `texra.explorer.agentsDirectory` - System paths

### Graceful Migration Strategy

**Principle:** Read from new state first, fallback to VS Code config, never break existing setups.

```typescript
/**
 * Get enabled models with graceful migration.
 * Priority: globalState > VS Code config > defaults
 */
function getEnabledModels(context: vscode.ExtensionContext): string[] {
  // 1. Check new storage first
  const fromState = context.globalState.get<string[]>('enabledModels');
  if (fromState !== undefined) {
    return fromState;
  }

  // 2. Fallback to VS Code config (existing users)
  const config = vscode.workspace.getConfiguration('texra');
  const fromConfig = config.get<string[]>('models');
  if (fromConfig?.length) {
    // Auto-migrate on first read
    context.globalState.update('enabledModels', fromConfig);
    return fromConfig;
  }

  // 3. Return defaults
  return DEFAULT_ENABLED_MODELS;
}

/**
 * Get routing configuration with migration.
 */
function getRoutingConfig(context: vscode.ExtensionContext): RoutingConfig {
  const fromState = context.globalState.get<RoutingConfig>('routing');
  if (fromState !== undefined) {
    return fromState;
  }

  // Migrate from scattered VS Code settings
  const config = vscode.workspace.getConfiguration('texra.model');
  const useOpenRouter = config.get<boolean>('useOpenRouter', false);
  const useProxy = config.get<boolean>('useImprovedConnection', false);
  const proxyDomain = config.get<string>('improvedConnectionDomain');

  const migrated: RoutingConfig = {
    mode: useOpenRouter ? 'openrouter' : useProxy ? 'proxy' : 'direct',
    openRouterMode: 'exclusive',
    proxyDomain,
  };

  // Auto-migrate
  context.globalState.update('routing', migrated);
  return migrated;
}
```

### Migration Timing

1. **On extension activate:** Check and migrate settings lazily (on first read)
2. **No forced migration:** Users can continue using VS Code config until they open Settings View
3. **Settings View writes:** Once user saves in Settings View, new storage is used
4. **VS Code config becomes secondary:** Still works for users who prefer it

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
│       │   ├── MemoryTab.js         # Memory tab logic (migrated)
│       │   ├── HistoryTab.js        # History tab logic (migrated)
│       │   └── ProfileTab.js        # Profile tab logic (migrated)
│       └── uiManagers/
│           ├── ModelListRenderer.js
│           ├── AgentListRenderer.js
│           ├── MemoryRenderer.js    # From memoryView
│           ├── HistoryRenderer.js   # From historyView
│           └── ProfileRenderer.js   # From profileView
│
├── profileView/                     # DEPRECATED - merge into settingsView
├── historyView/                     # DEPRECATED - merge into settingsView
├── memoryView/                      # DEPRECATED - merge into settingsView
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
- Create settingsView with tab navigation (5 tabs)
- Implement Models tab with provider accordions
- Wire up globalState for model preferences
- Test graceful migration from VS Code config

### Phase 2: Agents Tab
- Implement Agents tab with local/custom/remote sections
- Wire up workspaceState for agent preferences
- Handle remote agents auth state

### Phase 3: Memory Tab
- Migrate memoryView to Memory tab
- Add conversation persistence settings UI
- Add active sessions list with resume/discard
- Delete old memoryView

### Phase 4: Migrate History
- Move history rendering to History tab
- Preserve search, delete, restore, rerun functionality
- Delete old historyView

### Phase 5: Migrate Profile
- Move profile/auth to Profile tab
- Implement provider configuration cards
- Implement provider modal (API key + endpoint)
- Add routing options UI
- Delete old profileView

### Phase 6: Polish
- Add main webview entry point (gear icon)
- Deep link support (open to specific tab)
- Verify graceful migration (no breaking existing setups)
- Documentation

---

## References

- VS Code Elements: `@vscode-elements/elements`
  - `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel`
  - `vscode-collapsible`, `vscode-checkbox`, `vscode-button`
- LLM Zoo: Model metadata source
- Existing views: `src/profileView/`, `src/historyView/`
