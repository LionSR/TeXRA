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
2. **Easy navigation** - vscode-tabs with logical groupings, vscode-collapsible for subsections
3. **No auth required** - Most tabs work without login (except account features in header)
4. **VS Code native** - Use vscode-tabs, vscode-collapsible, vscode-form-group (native components)
5. **Proper state management** - Global vs workspace state separation
6. **Backwards compatible** - Extend getConfig rather than replacing it; graceful migration
7. **Minimal custom CSS** - Only header bar needs custom styling, everything else native

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

### HTML Structure (vscode-tabs + header bar)

```html
<div class="settings-container">
  <!-- Header Bar (only custom CSS needed) -->
  <header class="settings-header">
    <div class="account-info">
      <!-- Logged in state -->
      <span class="codicon codicon-account"></span>
      <span class="user-email">user@example.com</span>
      <span class="separator">•</span>
      <span class="user-plan">Pro Plan</span>
    </div>
    <div class="account-actions">
      <vscode-button appearance="secondary">Manage</vscode-button>
      <vscode-button appearance="secondary">Sign Out</vscode-button>
    </div>
  </header>

  <!-- Native vscode-tabs (no custom CSS) -->
  <vscode-tabs selected-index="0">
    <vscode-tab-header slot="header">Models</vscode-tab-header>
    <vscode-tab-header slot="header">Agents</vscode-tab-header>
    <vscode-tab-header slot="header">LaTeX</vscode-tab-header>
    <vscode-tab-header slot="header">Memory</vscode-tab-header>
    <vscode-tab-header slot="header">History</vscode-tab-header>
    <!-- Advanced tab deferred to future release -->

    <!-- Models Tab -->
    <vscode-tab-panel>
      <div class="tab-content">
        <vscode-collapsible title="Recommended Models" open>
          <!-- Model checkboxes -->
        </vscode-collapsible>

        <vscode-collapsible title="Anthropic" open>
          <!-- Provider models + Configure button -->
        </vscode-collapsible>

        <vscode-collapsible title="OpenAI">
          <!-- Provider models + Configure button -->
        </vscode-collapsible>
        <!-- More providers... -->
      </div>
    </vscode-tab-panel>

    <!-- Agents Tab -->
    <vscode-tab-panel>
      <div class="tab-content">
        <!-- Agent list (no collapsible needed for main content) -->
        <div class="agents-list">
          <!-- Agent checkboxes with badges -->
        </div>

        <vscode-collapsible title="Workflow Settings">
          <!-- Output storage mode -->
        </vscode-collapsible>

        <vscode-collapsible title="Tool-Use Settings">
          <!-- Edit approval, persistence, compaction -->
        </vscode-collapsible>
      </div>
    </vscode-tab-panel>

    <!-- LaTeX Tab -->
    <vscode-tab-panel>
      <div class="tab-content">
        <vscode-collapsible title="Formatter" open>
          <!-- Formatter settings -->
        </vscode-collapsible>

        <vscode-collapsible title="LaTeXdiff">
          <!-- Diff settings -->
        </vscode-collapsible>

        <vscode-collapsible title="TikZ Figures">
          <!-- TikZ settings -->
        </vscode-collapsible>

        <vscode-collapsible title="Replacements">
          <!-- Replacement rules -->
        </vscode-collapsible>
      </div>
    </vscode-tab-panel>

    <!-- Memory Tab -->
    <vscode-tab-panel>
      <div class="tab-content">
        <!-- Memory file browser -->
      </div>
    </vscode-tab-panel>

    <!-- History Tab -->
    <vscode-tab-panel>
      <div class="tab-content">
        <!-- History browser -->
      </div>
    </vscode-tab-panel>

    <!-- Advanced Tab - deferred to future release -->
  </vscode-tabs>
</div>
```

### Header Bar CSS (minimal custom styles)

```css
/* Only custom CSS needed - everything else is native vscode-elements */
.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-medium);
  border-bottom: 1px solid var(--vscode-widget-border);
  background: var(--vscode-sideBar-background);
}

.account-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-small);
  color: var(--vscode-foreground);
}

.account-info .separator {
  color: var(--vscode-descriptionForeground);
}

.account-actions {
  display: flex;
  gap: var(--spacing-small);
}

/* Tab content padding */
.tab-content {
  padding: var(--spacing-large);
  max-width: 720px;
}
```

---

## Tab Specifications

### Models Tab

**Purpose:** Combined model selection and API provider configuration. Each provider shows API status + model selection together.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Models & Providers                                             │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ROUTING                                                        │
│  ─────────────────────────────────────────────────────────────  │
│  ● Direct to providers (recommended)                            │
│  ○ Route all through OpenRouter                                 │
│  ○ Use connection proxy                                         │
│                                                                 │
│  ⭐ RECOMMENDED MODELS                                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 T    Anthropic   $3/$15    200K  🧠👁 │  │
│  │ ☑ GPT-5.2                OpenAI      $2/$10    256K  🧠👁 │  │
│  │ ☑ Gemini 3 Pro           Google      $1.25/$5  1M    🧠👁 │  │
│  │ ☑ DeepSeek R1            DeepSeek    $0.55/$2  64K   🧠   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  PROVIDERS                                                      │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ▼ Anthropic                         ✓ API Key    [Configure]  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ Claude Sonnet 4.5 T     200K   $3/$15    🧠👁📄         │  │
│  │ ☑ Claude Opus 4.5 T       200K   $15/$75   🧠👁📄🎧       │  │
│  │ ☐ Claude Sonnet 4.5       200K   $3/$15    👁📄           │  │
│  │ ☐ Claude Haiku 3.5        200K   $0.8/$4   👁             │  │
│  │   ... more (21 models)                      [Enable All]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ OpenAI (28)                       ✓ API Key    [Configure]  │
│  ▶ Google (6)                        ✗ No Key     [Configure]  │
│  ▶ DeepSeek (7)                      ✓ API Key    [Configure]  │
│  ▶ xAI (5)                           ✗ No Key     [Configure]  │
│  ▶ Moonshot (8)                      ✗ No Key     [Configure]  │
│  ▶ DashScope (3)                     ✗ No Key     [Configure]  │
│                                                                 │
│  ▼ OpenRouter                        ✓ API Key    [Configure]  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ OpenRouter provides access to 200+ models with one key.   │  │
│  │ Routing: ● OpenRouter-only  ○ Route ALL through OR        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Selected: 12 models                                            │
└─────────────────────────────────────────────────────────────────┘
```

**Key Design:**
- Each provider accordion shows: status indicator + [Configure] button + model list
- Provider status: `✓ API Key`, `✗ No Key`, or `🔑 Env Var`
- Clicking [Configure] opens provider modal (API key + endpoint + streaming toggle)
- Models are listed under their provider for clear ownership

**Data Source:** `llm-zoo` package (ModelRegistry)

**Model Metadata Displayed:**
- Name (display name)
- Context window
- Cost (input/output per 1M tokens)
- Capabilities icons: 🧠 Reasoning, 👁 Vision, 📄 PDF, 🎧 Audio, 💬 Tools, ⚡ Cache

**Recommended Models (hardcoded):**
```typescript
const RECOMMENDED_MODELS = [
  'sonnet45T', 'opus45T', 'gpt52', 'gemini3p',
  'grok4', 'deepseekT', 'kimi2T', 'qwen3max'
];
```

**Storage:** `globalState.enabledModels: string[]`, `globalState.providerConfig`

---

### Agents Tab

**Purpose:** View and enable/disable agents, plus agent-specific settings. Supersedes the FolderExplorer/agent explorer.

**Scope (Phase 1):** View-only with enable/disable. Agent creation wizard deferred to Future Scope.

**Agent Metadata Displayed:**
| Field | Source | Display |
|-------|--------|---------|
| Name | YAML `name` | Text |
| Description | YAML `description` | Text (truncated) |
| Category | `agentCategory` | Badge: `[workflow]` or `[toolUse]` |
| Type | `settings.agentType` | Label: `CoT`, `Direct`, `Merge`, `Reflect` |
| Rounds | `settings.rounds` | Label: `×2`, `×3` (if > 1) |
| Inherits | `inherits` | Codicon: `$(extensions)` + parent name |
| Source | File location | `Built-in`, `Custom`, `Remote` |

**Agent Type Icons (codicons):**
- `$(lightbulb)` CoT (Chain-of-Thought)
- `$(zap)` Direct
- `$(git-merge)` Merge
- `$(sync)` Reflect
- `$(tools)` Tool-Use

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Select which agents appear in the dropdown.                    │
│  Settings are saved per workspace.                              │
│                                                                 │
│  BUILT-IN AGENTS                                               │
│  ─────────────────────────────────────────────────────────────  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ chat      Interactive conversation                      │  │
│  │             $(tools) toolUse                              │  │
│  │                                                           │  │
│  │ ☑ correct   Fix typos & LaTeX errors                      │  │
│  │             $(lightbulb) CoT  ×2  $(extensions) polish    │  │
│  │                                                           │  │
│  │ ☑ polish    Improve writing quality                       │  │
│  │             $(lightbulb) CoT  ×2                          │  │
│  │   ...                                                     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  CUSTOM AGENTS                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ my-reviewer   Reviews papers for clarity                │  │
│  │                 $(lightbulb) CoT  $(extensions) correct   │  │
│  │                              [Source Code] [Delete]       │  │
│  └───────────────────────────────────────────────────────────┘  │
│  📁 Custom agents are stored in: .texra/agents/                 │
│                                                                 │
│  REMOTE AGENTS                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  ☑ Auto-show remote agents if available                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ team-reviewer   Team's paper reviewer                   │  │
│  │                   $(lightbulb) CoT  ×3                    │  │
│  │ ☐ grant-writer    Grant proposal helper                   │  │
│  │                   $(tools) toolUse                        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        ─ or if not logged in ─                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  🔒 Sign in to access shared team agents       [Sign In]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ▼ Workflow Settings                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Settings for workflow agents (correct, polish, etc.)      │  │
│  │                                                           │  │
│  │ Storage mode: [Folder ▼]                                  │  │
│  │   How to store agent outputs.                             │  │
│  │   Options: In-place (overwrite), Folder (texra-outputs/)  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▼ Tool-Use Settings                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Settings for tool-use agents (chat, research, etc.)       │  │
│  │                                                           │  │
│  │ ☑ Require approval before file edits                      │  │
│  │   Show diff preview and require confirmation.             │  │
│  │                                                           │  │
│  │ ☑ Persist sessions across VS Code restarts                │  │
│  │   Session retention: [72 hours ▼]                         │  │
│  │                                                           │  │
│  │ Compaction threshold: [85 %]                              │  │
│  │   Compact context when usage exceeds this percentage.     │  │
│  │                                                           │  │
│  │ ─────────────────────────────────────────────────────────│  │
│  │ Retry Behavior                                            │  │
│  │ Max attempts: [3 ▼]                                       │  │
│  │   Maximum retry attempts for failed API requests.         │  │
│  │                                                           │  │
│  │ Backoff delay: [1000 ms]                                  │  │
│  │   Initial delay before retry (exponential backoff).       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ Advanced                                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Custom agents directory: [.texra/agents       ] [Browse]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Custom Agent Actions:**
- `[Source Code]` - Opens agent YAML file in editor
- `[Delete]` - Deletes custom agent YAML file

**Note:** Agent creation wizard and form-based editing are deferred to Future Scope.

**Settings Mapping:**
| UI Element | VS Code Setting |
|------------|-----------------|
| Auto-show remote agents | `texra.remoteAgents.autoShow` |
| Storage mode dropdown | `texra.agentOutputs.storageMode` |
| Require approval checkbox | `texra.toolUse.requireEditApproval` |
| Persist sessions checkbox | `texra.toolUse.persistence.enabled` |
| Session retention dropdown | `texra.toolUse.persistence.ttlHours` |
| Compaction threshold | `texra.model.compactionThresholdPercent` |
| Max attempts | `texra.model.retry.maxAttempts` |
| Backoff delay | `texra.model.retry.backoffMs` |
| Custom agents directory | `texra.explorer.agentsDirectory` (Advanced collapsible) |

**Storage:** `workspaceState.enabledAgents: string[]`, VS Code configuration for settings

---

### LaTeX Tab

**Purpose:** Configure LaTeX formatting, latexdiff, and TikZ compilation settings.

**Design Philosophy:** Consolidate scattered LaTeX-related VS Code settings into a visual, grouped interface. Settings remain in VS Code configuration for backwards compatibility.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure LaTeX formatting and processing options.             │
│                                                                 │
│  FORMATTER                                                     │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Formatter:  [latexindent ▼]                                   │
│              Options: latexindent, texfmt, none                 │
│                                                                 │
│  Config file (optional):                                       │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ /path/to/latexindent.yaml                       [Browse]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ☑ Show warning if latexindent is not installed                │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  LATEXDIFF                                                     │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Timeout: [30000 ms ▼]                                         │
│                                                                 │
│  Math markup:  [fine ▼]                                        │
│                Options: off, whole, coarse, fine                │
│                                                                 │
│  Picture environments (regex):                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ (?:picture|tikzpicture|scope|DIFnomarkup)[\w\d*@]*        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ☐ Generate diffs between rounds (multi-round agents)          │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  TIKZ FIGURES                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  Extra input directory (TEXINPUTS):                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ /path/to/tikz/inputs                            [Browse]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ☑ Include workspace root in TEXINPUTS                         │
│                                                                 │
│  ▶ TikZ template (advanced)                                    │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  REPLACEMENTS                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ☑ Wrap critique in align environment                          │
│                                                                 │
│  Enabled replacement categories:                               │
│  ☑ latex_spacing      ☑ latex_forbidden_commands               │
│  ☑ latex_xml          ☑ latex_document                         │
│  ☐ latexdiff                                                   │
│                                                                 │
│  Enabled regex replacements:                                   │
│  ☑ latexdiff_markup   ☐ (others)                               │
│                                                                 │
│  ▶ Custom replacements (advanced)                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Settings Mapping:**
| UI Element | VS Code Setting |
|------------|-----------------|
| Formatter dropdown | `texra.latex.formatter` |
| Config file path | `texra.latex.latexindentConfig` / `texra.latex.texfmtConfig` |
| Show warning checkbox | `texra.latex.showLatexindentWarning` |
| Timeout | `texra.latexdiff.timeoutMs` |
| Math markup | `texra.latexdiff.mathMarkup` |
| Picture environments | `texra.latexdiff.pictureEnvironments` |
| Generate between-round diffs | `texra.latexdiff.generateBetweenRoundDiffs` |
| TikZ input directory | `texra.latex.tikzInputDirectory` |
| Include workspace | `texra.latex.includeWorkspaceInTexinputs` |
| TikZ template | `texra.latex.tikzTemplate` |
| Wrap critique | `texra.latex.wrapCritiqueInAlign` |
| Replacement categories | `texra.latex.enabledReplacements` |
| Regex replacements | `texra.latex.enabledReplacementsRegex` |
| Custom replacements | `texra.latex.customReplacements` / `texra.latex.customReplacementsRegex` |

**Storage:** VS Code configuration (`texra.latex.*`, `texra.latexdiff.*`)

**Note:** Unlike other tabs that use globalState/workspaceState, LaTeX settings remain in VS Code configuration for backwards compatibility and to allow users to configure via settings.json if preferred.

---

### Memory Tab

**Purpose:** Browse and manage persistent memory files created by tool-use agents.

**Note:** Tool-use settings (edit approval, session persistence) are in the Agents tab under Tool-Use Settings collapsible.

**Key Design:** Show memory content on expand (like current memoryView implementation).

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Memory                                                         │
│  ─────────────────────────────────────────────────────────────  │
│  Memory files created by tool-use agents.                       │
│                                                                 │
│  MEMORY FILES                                     [Refresh]    │
│  ─────────────────────────────────────────────────────────────  │
│  Agent-created memory files stored in /memories                 │
│                                                                 │
│  ▼ 📄 project-notes.md           12 KB    Jan 11, 2:34 PM      │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ # Project Notes                                           │  │
│  │                                                           │  │
│  │ ## Key Decisions                                          │  │
│  │ - Using XYZ framework for...                              │  │
│  │ - Architecture follows...                                 │  │
│  │                                        [View Full] [Delete]│  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ 📄 research-findings.md       8 KB     Jan 10, 4:12 PM      │
│                                                                 │
│  ▶ 📄 citations.bib              2 KB     Jan 9, 3:00 PM       │
│                                                                 │
│  ▶ 📁 figures/                   3 files  Jan 9, 11:00 AM      │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  Total: 5 files, 24 KB                        [Clear All]      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Features:** (Migrated from memoryView)
- Memory file browser with expandable content preview
- Click file to expand and show content preview (first ~20 lines)
- [View Full] opens file in editor
- [Delete] removes file
- Directory browsing (2-level deep)
- Storage usage display

**Data Sources:**
- Memory files: `/memories` directory managed by MemoryTool

**Storage:** File system (no extension state needed)

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

### Provider Configuration Modal (from Models Tab)

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
│  │                                                           │  │
│  │ ☑ Enable streaming                                        │  │
│  │   Stream responses in real-time for this provider.        │  │
│  │   Disable if experiencing issues with proxies.            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│                                            [Cancel]   [Save]   │
└─────────────────────────────────────────────────────────────────┘
```

**Streaming Settings (per provider):**
The `texra.model.useStreaming*` settings (9 total) are now configured per provider
in the Advanced Options of each provider's configuration modal. This replaces the
scattered VS Code settings with a unified UI.

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

### Advanced Tab (DEFERRED TO FUTURE RELEASE)

> **Note:** This tab is not included in v1. Specifications kept for future reference.

**Purpose:** Multi-agent settings, UI preferences, retry behavior, system paths, and developer options. Uses vscode-collapsible for organization.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Advanced settings and system configuration.                    │
│                                                                 │
│  ▼ Multi-Agent                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Configure multi-agent operations and ensemble runs.       │  │
│  │                                                           │  │
│  │ Default merge model: [Claude Sonnet 4.5 ▼]                │  │
│  │   Model used for combining outputs from multiple agents.  │  │
│  │                                                           │  │
│  │ ─────────────────────────────────────────────────────────│  │
│  │ COMING SOON                                               │  │
│  │ • Ensemble runs across multiple models                    │  │
│  │ • Agent pipeline configurations                           │  │
│  │ • Output voting and consensus                             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▼ UI Preferences                                              │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ General interface preferences.                            │  │
│  │                                                           │  │
│  │ ☑ Show API key reminders                                  │  │
│  │   Show reminders when API keys are missing.               │  │
│  │                                                           │  │
│  │ ☑ Show dependency reminders                               │  │
│  │   Show reminders for missing dependencies (latexindent).  │  │
│  │                                                           │  │
│  │ ☑ Show login banner                                       │  │
│  │   Show banner suggesting to sign in.                      │  │
│  │                                                           │  │
│  │ Max image dimension: [2048 ▼]                             │  │
│  │   Larger images resized before sending to models.         │  │
│  │   Options: 1024, 2048, 4096                               │  │
│  │                                                           │  │
│  │ Progress board sort: [Timestamp descending ▼]             │  │
│  │   Options: Timestamp ascending, Timestamp descending      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ Git Integration                                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Commits to show: [50 ▼]                                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ System Paths                                                │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Sox audio path: [/usr/bin/sox            ] [Browse]       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ Debug (Developer)                                           │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☐ Enable debug logging                                    │  │
│  │ ☐ Enable verbose output                                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Settings Mapping:**
| UI Element | VS Code Setting |
|------------|-----------------|
| Default merge model | `texra.merge.defaultModel` |
| Show API key reminders | `texra.ui.showApiKeyReminders` |
| Show dependency reminders | `texra.ui.showDependencyReminders` |
| Show login banner | `texra.ui.showLoginBanner` |
| Max image dimension | `texra.maxImageDimension` |
| Progress board sort | `texra.progressBoard.streamSortOrder` |
| Commits to show | `texra.git.numberOfCommitsToShow` |
| Sox audio path | `texra.audio.soxPath` |
| Debug mode | `texra.logger.debugMode` |
| Save debug objects | `texra.debug.saveDebugObjects` |
| Save input prompt | `texra.debug.saveInputPrompt` |

**Storage:** VS Code configuration (backwards compatible)

**Note:** Multi-Agent is included now, but ensemble features are awaiting multi-agent feature maturity. Retry settings are in the Agents tab (Tool-Use Settings).

---

### Features Summary

**Tab Layout with Header Bar (v1 - 5 tabs):**
- **Header Bar** - Account info, sign in/out, manage account (always visible)
- **Models Tab** - Provider configuration, model selection, routing options
- **Agents Tab** - Agent list, Workflow Settings (collapsible), Tool-Use Settings (collapsible)
- **LaTeX Tab** - Formatter, latexdiff, TikZ (all as collapsibles)
- **Memory Tab** - Memory file browser with expandable content preview
- **History Tab** - Execution history browser

**Deferred to Later Release:**
- **Advanced Tab** - Multi-Agent, UI preferences, git, system paths, debug (all collapsibles)

**Key Features:**
- Account info in header bar (minimal custom CSS, always visible)
- Native vscode-tabs for navigation (no custom styling)
- vscode-collapsible for subsections within tabs
- Per-provider configuration in Models tab
- Provider modal with API key + custom endpoint + streaming toggle
- OpenRouter special configuration (routing mode)
- Global routing options (direct/OpenRouter/proxy)
- Environment variable hints

**Key UX Improvements:**
1. **Works without login** - Configure API keys without account
2. **Visual provider status** - See which providers are configured at a glance
3. **Custom endpoints exposed** - No more hidden VS Code settings
4. **OpenRouter simplified** - Clear explanation and routing options
5. **Model availability feedback** - See which models are ready in Models tab
6. **Minimal custom CSS** - Only header bar needs styling, tabs and collapsibles are native

---

## State Management

### VS Code Configuration (Primary)

Settings View reads/writes directly to VS Code configuration using `ConfigurationTarget`:

```typescript
const config = vscode.workspace.getConfiguration('texra');

// Global settings (user-level, all workspaces)
await config.update('models', enabledModels, ConfigurationTarget.Global);
await config.update('maxImageDimension', 2048, ConfigurationTarget.Global);

// Workspace settings (project-level, .vscode/settings.json)
await config.update('agents', enabledAgents, ConfigurationTarget.Workspace);
await config.update('agentOutputs.storageMode', 'folder', ConfigurationTarget.Workspace);
```

**Setting Scopes:**
| Setting | ConfigurationTarget | Reason |
|---------|---------------------|--------|
| `texra.models` | Global | Same models everywhere |
| `texra.maxImageDimension` | Global | User preference |
| Provider endpoints | Global | Same API setup everywhere |
| `texra.agents` | Workspace | Different projects need different agents |
| `texra.agentOutputs.storageMode` | Workspace | Project-specific output location |
| `texra.toolUse.*` | Global | Consistent behavior |
| `texra.latex.*` | Global/Workspace | User choice |

**Benefits of VS Code Config:**
- No extension state migration needed
- Works with VS Code Settings Sync automatically
- Users can still edit settings.json directly
- Respects VS Code conventions

### Extension State (Minimal)

Only for caching and truly ephemeral UI state:

```typescript
// globalState - only for caching
context.globalState.get('modelMetadataCache');  // Cached llm-zoo data

// No settings stored in extension state
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

### No Migration Needed

Since Settings View reads/writes directly to VS Code configuration:

1. **Existing settings.json configurations continue to work unchanged**
2. **No extension state migration required**
3. **Settings View is just a GUI wrapper around existing VS Code settings**

```typescript
// Settings View simply reads and writes VS Code config
const config = vscode.workspace.getConfiguration('texra');

// Read
const models = config.get<string[]>('models');

// Write with appropriate scope
await config.update('models', newModels, ConfigurationTarget.Global);
await config.update('agents', newAgents, ConfigurationTarget.Workspace);
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
│   ├── index.html                   # Header bar + vscode-tabs layout
│   ├── styles.css                   # Minimal CSS (header bar only)
│   └── modules/
│       ├── main.js                  # Entry point
│       ├── messageHandlers.js
│       ├── settingsViewState.js
│       ├── headerBar.js             # Account header bar logic
│       ├── tabs/                    # Tab content modules (v1)
│       │   ├── ModelsTab.js         # Models + providers + routing
│       │   ├── AgentsTab.js         # Agents + collapsible settings
│       │   ├── LatexTab.js          # LaTeX settings (collapsibles)
│       │   ├── MemoryTab.js         # Memory files browser
│       │   └── HistoryTab.js        # History (migrated)
│       │   # AdvancedTab.js - deferred to future release
│       └── uiManagers/
│           ├── ModelListRenderer.js
│           ├── ProviderRenderer.js
│           ├── AgentListRenderer.js
│           ├── LatexSettingsRenderer.js
│           ├── MemoryRenderer.js    # From memoryView
│           └── HistoryRenderer.js   # From historyView
│
├── profileView/                     # DEPRECATED - merge into settingsView
├── historyView/                     # DEPRECATED - merge into settingsView
├── memoryView/                      # DEPRECATED - merge into settingsView
```

### Commands

```typescript
// Register command to open settings view
commands.registerCommand('texra.openSettings', (tab?: SettingsTab) => {
  settingsViewProvider.show();
  if (tab) {
    // Tab index: 0=models, 1=agents, 2=latex, 3=memory, 4=history, 5=advanced
    settingsViewProvider.selectTab(tab);
  }
});

type SettingsTab = 'models' | 'agents' | 'latex' | 'memory' | 'history' | 'advanced';

// Shortcut commands
commands.registerCommand('texra.openModelSettings', () =>
  commands.executeCommand('texra.openSettings', 'models'));
commands.registerCommand('texra.openAgentSettings', () =>
  commands.executeCommand('texra.openSettings', 'agents'));
commands.registerCommand('texra.openLatexSettings', () =>
  commands.executeCommand('texra.openSettings', 'latex'));
```

### Message Protocol

```typescript
// Extension → Webview
type SettingsMessage =
  | { command: 'SET_MODELS_DATA', models: ModelInfo[], enabled: string[] }
  | { command: 'SET_AGENTS_DATA', agents: AgentInfo[], enabled: string[] }
  | { command: 'SET_LATEX_DATA', settings: LatexSettings }
  | { command: 'SET_HISTORY_DATA', items: HistoryItem[] }
  | { command: 'SET_PROFILE_DATA', profile: ProfileInfo | null }
  | { command: 'SELECT_TAB', tab: string };

// Webview → Extension
type SettingsAction =
  | { command: 'SAVE_ENABLED_MODELS', models: string[] }
  | { command: 'SAVE_ENABLED_AGENTS', agents: string[] }
  | { command: 'SAVE_LATEX_SETTING', key: string, value: unknown }
  | { command: 'RESTORE_HISTORY', id: string }
  | { command: 'DELETE_HISTORY', id: string }
  | { command: 'SIGN_IN' }
  | { command: 'SIGN_OUT' }
  | { command: 'SET_API_KEY', provider: string, key: string };

// Agent info includes category
interface AgentInfo {
  name: string;
  description: string;
  category: 'workflow' | 'toolUse';
  source: 'builtIn' | 'builtInToolUse' | 'custom' | 'remote';
  enabled: boolean;
}
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

### v1 Release
1. Single entry point for 5 core tabs (Models, Agents, LaTeX, Memory, History)
2. Native vscode-tabs navigation (keyboard accessible)
3. Settings properly scoped (models global, agents per-workspace via ConfigurationTarget)
4. History search and restore working
5. Account info visible in header bar (minimal custom CSS)
6. LaTeX settings functional and synced with VS Code config
7. vscode-collapsible used effectively for subsections
8. Only header bar needs custom styling (everything else native)
9. Existing settings.json configurations continue to work unchanged

---

## Implementation Phases

### v1 Release (5 Tabs)

#### Phase 1: Core Structure
- Create settingsView with vscode-tabs + header bar
- Implement header bar (account info, sign in/out - minimal custom CSS)
- Add main webview entry point (gear icon)
- Deep link support (open to specific tab)

#### Phase 2: Models Tab
- Implement Models tab with provider collapsibles
- Provider accordions with API status + model list
- Provider configuration modal (API key + endpoint + streaming toggle)
- Routing options (radio group at top)
- Migrate provider config from old profileView

#### Phase 3: Agents Tab
- Implement Agents tab with agent list
- Show category badges (workflow/toolUse) and source (built-in/custom/remote)
- Add Workflow Settings collapsible (output storage mode)
- Add Tool-Use Settings collapsible (edit approval, persistence, compaction, retry behavior)
- Include Advanced collapsible (custom agents directory)
- **Note:** Supersedes FolderExplorer/agent explorer view

#### Phase 4: LaTeX Tab
- Implement LaTeX tab with collapsible sections:
  - Formatter (collapsible)
  - LaTeXdiff (collapsible)
  - TikZ Figures (collapsible)
  - Replacements (collapsible)
- Wire up to existing VS Code configuration
- Add file browser for config paths

#### Phase 5: Memory Tab
- Migrate memoryView to Memory tab
- Implement expandable content preview
- Delete old memoryView

#### Phase 6: History Tab + v1 Cleanup
- Move history rendering to History tab
- Preserve search, delete, restore, rerun functionality
- Delete old historyView
- Remove deprecated views (profileView, historyView, memoryView)
- Remove FolderExplorer/agent explorer (superseded)
- Documentation

### Future Release (Deferred)

#### Advanced Tab
- Multi-Agent (merge model + ensemble features)
- UI Preferences (reminders, image dimension, sort order)
- Git Integration
- System Paths
- Debug

#### Agent Creation Wizard
- AI-assisted agent creation from plain English description
- Form-based editing without YAML knowledge

#### Multi-Agent Ensemble
- Run across multiple models with voting/consensus

---

## Settings Coverage Summary

Based on 79 total settings in package.json:

### v1 Release - Covered by Settings View

| Tab | Settings Covered |
|-----|------------------|
| **Models** | `texra.models`, `texra.model.useStreaming*` (9), `texra.model.useOpenRouter`, `texra.model.useImprovedConnection`, `texra.model.improvedConnectionDomain`, `texra.model.baseUrlDeepSeek` |
| **Agents** | `texra.agents`, `texra.toolUseAgents`, `texra.remoteAgents.autoShow`, `texra.explorer.agentsDirectory`, `texra.agentOutputs.storageMode`, `texra.toolUse.*` (3), `texra.model.compactionThresholdPercent`, `texra.model.retry.*` (2) |
| **LaTeX** | `texra.latex.*` (7), `texra.latexdiff.*` (4) |
| **Memory** | Memory file browser (no config, file system) |
| **History** | History browser (existing storage) |

### Deferred to Future Release (Advanced Tab)

| Section | Settings |
|---------|----------|
| **Multi-Agent** | `texra.merge.defaultModel` |
| **UI Preferences** | `texra.ui.*` (3), `texra.progressBoard.streamSortOrder`, `texra.maxImageDimension` |
| **Git Integration** | `texra.git.numberOfCommitsToShow` |
| **System Paths** | `texra.audio.soxPath` |
| **Debug** | `texra.debug.*`, `texra.logger.*` |

### Remain as VS Code Settings Only
These are advanced/power-user settings that don't need UI exposure:

- `texra.files.*` (16) - File type filtering patterns (power user)
- `texra.auth.*` (3) - System-level authentication endpoints
- `texra.remoteAgents.cacheTimeHours` (1) - Advanced cache behavior
- Other system-level paths and debug flags

---

## Integration Surface Areas

Key integration points that need updating when implementing the Settings View:

### 1. Main Webview Entry Points
| Location | Current Behavior | New Behavior |
|----------|-----------------|--------------|
| `src/webview/index.html` line 524 | Agent settings button → VS Code settings | → Settings View (Agents tab) |
| `src/webview/index.html` line 552 | Model settings button → VS Code settings | → Settings View (Models tab) |
| `src/webview/modules/uiManagers/SettingsButtonManager.js` | Opens VS Code settings | Opens Settings View |

### 2. Commands to Update
| Command | File | Change |
|---------|------|--------|
| `texra.openSettings` | `src/commands/system/` | Open Settings View instead of VS Code settings |
| `texra.openAgentSettings` | `src/commands/system/` | Open Settings View → Agents tab |
| `texra.openModelSettings` | `src/commands/system/` | Open Settings View → Models tab |

### 3. Dropdown Options Computation
| Function | File | Impact |
|----------|------|--------|
| `computeAgentOptions()` | `src/agent/index/agentRegistry.ts` | No change - still reads VS Code config |
| `computeModelOptions()` | `src/model/computeModelOptions.ts` | No change - still reads VS Code config |

### 4. Configuration Watchers
`src/MainViewProvider.ts` (lines 84-120) watches for config changes.
- No change needed - Settings View writes to VS Code config
- Existing watchers will pick up changes automatically

### 5. View Registrations (package.json)
| View | Current | After Implementation |
|------|---------|---------------------|
| `texra.profileView` | Registered in contributes.views | Remove after Phase 6 |
| `texra.historyView` | Command-opened panel | Remove after Phase 5 |
| `texra.memoryView` | Command-opened panel | Remove after Phase 4 |
| `texra.agentExplorer` | TreeView in sidebar | Remove after Phase 2 |
| `texra.settingsView` | N/A | Add new panel registration |

### 6. Message Handlers to Migrate
| Handler | From | To |
|---------|------|-----|
| `ProfileViewMessageHandler` | `src/profileView/` | `src/settingsView/` (compose) |
| `HistoryViewMessageHandler` | `src/historyView/` | `src/settingsView/` (compose) |
| `MemoryViewMessageHandler` | `src/memoryView/` | `src/settingsView/` (compose) |

### 7. No State Migration Needed
Settings View reads/writes directly to VS Code configuration - no migration required.

---

## Component Mapping (vscode-elements)

### Tab Layout
```html
<vscode-tabs>                   <!-- Tab container -->
  <vscode-tab-header>           <!-- Tab buttons -->
  <vscode-tab-panel>            <!-- Tab content panels -->
</vscode-tabs>
```

### Form Components by Tab

| UI Pattern | Component | Example Usage |
|------------|-----------|---------------|
| **Single selection** | `<vscode-single-select>` | Formatter dropdown, Math markup |
| **Checkbox** | `<vscode-checkbox>` | Enable/disable toggles |
| **Text input** | `<vscode-textfield>` | API keys, file paths |
| **Multiline text** | `<vscode-textarea>` | TikZ template, agent instructions |
| **Radio group** | `<vscode-radio-group>` | Routing mode, access mode |
| **Collapsible section** | `<vscode-collapsible>` | Advanced options, provider details |
| **Button** | `<vscode-button>` | Save, Browse, Create Agent |
| **Badge** | `<vscode-badge>` | Category badges (workflow/toolUse) |

### Form Layout Components
```html
<!-- Standard form group with label -->
<vscode-form-group>
  <vscode-label>Formatter</vscode-label>
  <vscode-single-select>
    <vscode-option value="latexindent">latexindent</vscode-option>
    <vscode-option value="tex-fmt">tex-fmt</vscode-option>
    <vscode-option value="none">none</vscode-option>
  </vscode-single-select>
</vscode-form-group>

<!-- Checkbox (self-labeled) -->
<vscode-checkbox id="showWarning">
  Show warning if latexindent is not installed
</vscode-checkbox>

<!-- File path with browse button -->
<vscode-form-group>
  <vscode-label>Config file</vscode-label>
  <div class="input-with-button">
    <vscode-textfield placeholder="/path/to/config"></vscode-textfield>
    <vscode-button appearance="secondary">Browse</vscode-button>
  </div>
</vscode-form-group>

<!-- Section header using vscode-label -->
<vscode-label class="section-label">FORMATTER</vscode-label>
```

### Models Tab Components
- `<vscode-collapsible>` - Provider accordions (Anthropic, OpenAI, etc.)
- `<vscode-checkbox>` - Model enable/disable
- `<vscode-badge>` - Capability icons, status indicators

### Agents Tab Components
- `<vscode-checkbox>` - Agent enable/disable
- `<vscode-badge>` - Category badges (workflow/toolUse), source badges
- `<vscode-button>` - Create Agent, Edit, Delete
- `<vscode-single-select>` - Category dropdown, inheritance dropdown
- `<vscode-textarea>` - Agent instructions

### LaTeX Tab Components
- `<vscode-single-select>` - Formatter, math markup
- `<vscode-checkbox>` - Boolean settings
- `<vscode-textfield>` - File paths, regex patterns
- `<vscode-textarea>` - TikZ template
- `<vscode-collapsible>` - Advanced sections

### Header Bar + Provider Modal Components
- `<vscode-button>` - Manage, Sign In/Out
- `<vscode-textfield type="password">` - API keys (in modal)
- `<vscode-radio-group>` - Routing mode (in Models tab)
- `<vscode-collapsible>` - Provider details (in Models tab)

---

## Code Reuse Patterns

### Base Classes (Extend Existing Infrastructure)

```
src/settingsView/
├── SettingsViewProvider.ts         # extends BaseWebviewProvider
├── SettingsViewMessageHandler.ts   # extends BaseViewMessageHandler
├── SettingsViewContentProvider.ts  # extends BaseViewContentProvider
```

### Provider Pattern
```typescript
// SettingsViewProvider.ts
export class SettingsViewProvider extends BaseWebviewProvider
    implements vscode.WebviewViewProvider {
  public static readonly viewType = 'texra.settingsView';

  protected contentProvider: SettingsViewContentProvider;
  protected messageHandler: SettingsViewMessageHandler;

  constructor(context: vscode.ExtensionContext) {
    super(context);
    this.contentProvider = new SettingsViewContentProvider(context);
    this.messageHandler = new SettingsViewMessageHandler(context);
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: getSharedLocalResourceRoots(this.context, 'settingsView'),
    };
    super.resolveWebviewViewInternal(webviewView);
  }

  /** Open settings to specific tab */
  public async showSettings(tab?: SettingsTab): Promise<void> {
    const isNew = this.createOrShowPanel({
      viewType: SettingsViewProvider.viewType,
      title: 'TeXRA Settings',
      viewPath: 'settingsView',
    });
    if (tab) {
      await this.messageHandler.selectTab(this._view?.webview, tab);
    }
  }
}
```

### Module Descriptors Pattern
```typescript
// SettingsViewContentProvider.ts
const SETTINGS_VIEW_MODULES = [
  { key: 'settingsViewStateUri', path: 'modules/settingsViewState.js' },
  { key: 'headerBarUri', path: 'modules/headerBar.js' },
  { key: 'modelsTabUri', path: 'modules/tabs/ModelsTab.js' },
  { key: 'agentsTabUri', path: 'modules/tabs/AgentsTab.js' },
  { key: 'latexTabUri', path: 'modules/tabs/LatexTab.js' },
  { key: 'memoryTabUri', path: 'modules/tabs/MemoryTab.js' },
  { key: 'historyTabUri', path: 'modules/tabs/HistoryTab.js' },
  { key: 'advancedTabUri', path: 'modules/tabs/AdvancedTab.js' },
] as const;

export class SettingsViewContentProvider extends BaseViewContentProvider {
  constructor(context: vscode.ExtensionContext) {
    super(context, 'SettingsView', [...SETTINGS_VIEW_MODULES]);
  }
  protected getViewPath(): string { return 'settingsView'; }
}
```

### Tab Manager Pattern (Frontend)
```javascript
// modules/tabs/BaseTab.js - Abstract base for all tabs
export class BaseTab {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
  }

  render(data) { throw new Error('Implement render()'); }

  dispose() {
    // Clean up event listeners
  }

  // Shared helpers
  createSettingRow(label, control) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    row.innerHTML = `<span class="setting-label">${label}</span>`;
    row.appendChild(control);
    return row;
  }

  createCheckbox(id, label, checked) {
    const checkbox = document.createElement('vscode-checkbox');
    checkbox.id = id;
    checkbox.checked = checked;
    checkbox.textContent = label;
    return checkbox;
  }

  createSelect(id, options, value) {
    const select = document.createElement('vscode-single-select');
    select.id = id;
    options.forEach(opt => {
      const option = document.createElement('vscode-option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === value) option.selected = true;
      select.appendChild(option);
    });
    return select;
  }
}
```

### Minimal Custom CSS (extend common.css)
```css
/* settingsView/styles/index.css */
/* Rely on vscode-form-group and vscode-elements for layout */
/* Only add minimal custom styles where needed */

.settings-container {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--spacing-large);
}

/* Section dividers */
.section + .section {
  border-top: 1px solid var(--vscode-widget-border);
  padding-top: var(--spacing-large);
  margin-top: var(--spacing-large);
}

/* Section labels (uppercase headers) */
.section-label {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: var(--spacing-medium);
}

/* Input + button combos */
.input-with-button {
  display: flex;
  gap: var(--spacing-small);
}
.input-with-button vscode-textfield {
  flex: 1;
}
```

### Message Handler Composition
```typescript
// SettingsViewMessageHandler.ts
export class SettingsViewMessageHandler extends BaseViewMessageHandler<...> {
  // Compose handlers from existing views where possible
  private historyHandlers: HistoryHandlers;
  private profileHandlers: ProfileHandlers;

  constructor(context: vscode.ExtensionContext) {
    super('SettingsView');
    this.historyHandlers = new HistoryHandlers(context);
    this.profileHandlers = new ProfileHandlers(context);
  }

  protected createHandlers(): Record<string, MessageHandler<...>> {
    return {
      // Models tab
      [SETTINGS_COMMANDS.GET_MODELS_DATA]: this.handleGetModels.bind(this),
      [SETTINGS_COMMANDS.SAVE_ENABLED_MODELS]: this.handleSaveModels.bind(this),

      // Agents tab
      [SETTINGS_COMMANDS.GET_AGENTS_DATA]: this.handleGetAgents.bind(this),
      [SETTINGS_COMMANDS.SAVE_ENABLED_AGENTS]: this.handleSaveAgents.bind(this),

      // LaTeX tab (direct VS Code config read/write)
      [SETTINGS_COMMANDS.GET_LATEX_DATA]: this.handleGetLatex.bind(this),
      [SETTINGS_COMMANDS.SAVE_LATEX_SETTING]: this.handleSaveLatex.bind(this),

      // Delegate to existing handlers
      ...this.historyHandlers.getHandlers(),
      ...this.profileHandlers.getHandlers(),
    };
  }
}
```

### Reducing Boilerplate: Setting Renderer Factory
```javascript
// modules/utils/SettingRenderer.js
export const SettingRenderer = {
  /** Render a dropdown setting row */
  dropdown(id, label, options, value, onChange) {
    return `
      <div class="setting-row">
        <span class="setting-label">${label}</span>
        <vscode-single-select id="${id}" value="${value}">
          ${options.map(o => `<vscode-option value="${o.value}">${o.label}</vscode-option>`).join('')}
        </vscode-single-select>
      </div>
    `;
  },

  /** Render a checkbox setting row */
  checkbox(id, label, checked, description) {
    return `
      <div class="setting-row setting-row--checkbox">
        <vscode-checkbox id="${id}" ${checked ? 'checked' : ''}>
          ${label}
        </vscode-checkbox>
        ${description ? `<span class="setting-description">${description}</span>` : ''}
      </div>
    `;
  },

  /** Render a file path setting row */
  filePath(id, label, value, placeholder) {
    return `
      <div class="setting-row">
        <span class="setting-label">${label}</span>
        <div class="setting-input-group">
          <vscode-textfield id="${id}" value="${value}" placeholder="${placeholder}"></vscode-textfield>
          <vscode-button appearance="secondary" data-browse="${id}">Browse</vscode-button>
        </div>
      </div>
    `;
  },

  /** Render a section with settings */
  section(title, settingsHtml) {
    return `
      <div class="section">
        <div class="section-header">${title}</div>
        ${settingsHtml}
      </div>
    `;
  }
};
```

---

## LaTeX Settings Grouping

Based on actual `package.json` configuration (14 settings total):

### Group 1: Formatter (4 settings)
| Setting | UI Component |
|---------|--------------|
| `texra.latex.formatter` | `<vscode-single-select>` (latexindent/tex-fmt/none) |
| `texra.latex.latexindentConfig` | `<vscode-textfield>` + Browse |
| `texra.latex.texfmtConfig` | `<vscode-textfield>` + Browse |
| `texra.latex.showLatexindentWarning` | `<vscode-checkbox>` |

### Group 2: LaTeXdiff (4 settings)
| Setting | UI Component |
|---------|--------------|
| `texra.latexdiff.mathMarkup` | `<vscode-single-select>` (off/whole/coarse/fine) |
| `texra.latexdiff.timeoutMs` | `<vscode-textfield type="number">` |
| `texra.latexdiff.pictureEnvironments` | `<vscode-textfield>` (regex) |
| `texra.latexdiff.generateBetweenRoundDiffs` | `<vscode-checkbox>` |

### Group 3: TikZ Figures (3 settings)
| Setting | UI Component |
|---------|--------------|
| `texra.latex.tikzInputDirectory` | `<vscode-textfield>` + Browse |
| `texra.latex.includeWorkspaceInTexinputs` | `<vscode-checkbox>` |
| `texra.latex.tikzTemplate` | `<vscode-collapsible>` + `<vscode-textarea>` |

### Group 4: Replacements (5 settings) - Collapsible Advanced
| Setting | UI Component |
|---------|--------------|
| `texra.latex.wrapCritiqueInAlign` | `<vscode-checkbox>` |
| `texra.latex.enabledReplacements` | Checkbox group (14 options) |
| `texra.latex.enabledReplacementsRegex` | Checkbox group (6 options) |
| `texra.latex.customReplacements` | `<vscode-collapsible>` + JSON editor |
| `texra.latex.customReplacementsRegex` | `<vscode-collapsible>` + JSON editor |

---

## References

- VS Code Elements: `@vscode-elements/elements`
  - Tabs: `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel`
  - Forms: `vscode-single-select`, `vscode-checkbox`, `vscode-textfield`, `vscode-textarea`
  - Layout: `vscode-collapsible`, `vscode-form-group` (avoid for Notion-style)
  - Actions: `vscode-button`, `vscode-badge`
- Base Classes: `src/common/webview/Base*.ts`
- Shared Styles: `src/common/styles/common.css`
- LLM Zoo: Model metadata source
- Existing views: `src/profileView/`, `src/historyView/`, `src/memoryView/`
