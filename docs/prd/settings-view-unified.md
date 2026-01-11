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
2. **Easy navigation** - Tab-based switching between Models, Agents, LaTeX, Memory, History, Profile
3. **No auth required** - Models, Agents, LaTeX, Memory, History tabs work without login
4. **VS Code native** - Use `vscode-tabs`, `vscode-tab-header`, `vscode-tab-panel` components
5. **Proper state management** - Global vs workspace state separation
6. **Notion-style minimalism** - Clean, uncluttered interface with generous whitespace

---

## User Stories

1. As a user, I want to click a settings icon to configure which models appear in my dropdown
2. As a user, I want to configure different agents per workspace (research project vs thesis)
3. As a user, I want to browse execution history and restore previous sessions
4. As a user, I want to manage my account and API keys in the same interface
5. As a user, I want to easily switch between these configuration pages
6. As a user, I want to configure LaTeX formatter, latexdiff, and TikZ settings in one place

---

## Design Principles (Notion-Inspired)

The Settings View follows Notion's design philosophy: minimal chrome, generous whitespace, and content-first hierarchy.

### Core Principles

1. **Content over chrome** - No unnecessary borders, backgrounds, or decorations
2. **Generous whitespace** - Let content breathe; padding > borders
3. **Typography hierarchy** - Use font size/weight, not color, to establish importance
4. **Invisible affordances** - Actions appear on hover, not by default
5. **Grouped sections** - Clear visual separation using space, not lines

### Visual Guidelines

```css
/* Typography hierarchy */
.section-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 12px;
}

.item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--vscode-foreground);
}

.item-description {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

/* Spacing */
.section {
  padding: 16px 0;
}

.section + .section {
  border-top: 1px solid var(--vscode-widget-border);
}

/* Hover actions (Notion-style) */
.item-row .actions {
  opacity: 0;
  transition: opacity 0.15s;
}

.item-row:hover .actions {
  opacity: 1;
}

/* Cards - minimal borders */
.card {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 4px;
  padding: 12px 16px;
}

/* Focus on content, not containers */
.list-item {
  padding: 8px 0;
  /* No borders between items - use space */
}
```

### Anti-Patterns to Avoid

- ❌ Heavy borders and outlines everywhere
- ❌ Colorful badges and status indicators
- ❌ Multiple competing visual hierarchies
- ❌ Actions always visible (clutter)
- ❌ Compact, dense layouts
- ❌ Deeply nested sections

### Examples

**Good (Notion-style):**
```
FORMATTER

Formatter     latexindent ▼

Config file   /path/to/config              Browse
```

**Bad (cluttered):**
```
┌─────────────────────────────────────────┐
│ ⚙️ FORMATTER SETTINGS                   │
├─────────────────────────────────────────┤
│ [Formatter:] [latexindent ▼] [ℹ️]       │
│ [Config:] [_______________] [📁 Browse] │
└─────────────────────────────────────────┘
```

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
│  [Models]  Agents   LaTeX   Memory   History   Profile         │
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
  <vscode-tab-header slot="header">LaTeX</vscode-tab-header>
  <vscode-tab-header slot="header">Memory</vscode-tab-header>
  <vscode-tab-header slot="header">History</vscode-tab-header>
  <vscode-tab-header slot="header">Profile</vscode-tab-header>

  <vscode-tab-panel id="modelsPanel">
    <!-- Models tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="agentsPanel">
    <!-- Agents tab content -->
  </vscode-tab-panel>
  <vscode-tab-panel id="latexPanel">
    <!-- LaTeX tab content -->
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

**Purpose:** Configure agents and create custom ones without YAML complexity.

**Design Philosophy:** Users should be able to create and modify agents through a simple UI, not by editing YAML files. The complexity is hidden; power users can access raw YAML if needed.

**Agent Categories:**
- `workflow` - Document-processing agents (input → output transformations)
- `toolUse` - Interactive agents with tool capabilities (chat, research)

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Configure agents and create custom ones.                       │
│  Settings are saved per workspace.                              │
│                                                                 │
│  MY AGENTS                                    [+ Create Agent]  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ chat        Interactive conversation  [toolUse] Built-in│  │
│  │ ☑ correct     Fix typos & LaTeX errors  [workflow] Built-in│  │
│  │ ☑ polish      Improve writing quality   [workflow] Built-in│  │
│  │ ☑ research    Research with tools       [toolUse] Built-in│  │
│  │ ☑ my-reviewer Reviews papers...         [workflow]  Custom │  │
│  │                                          [Edit] [Delete] │  │
│  │ ☐ draw        Create TikZ figures       [workflow] Built-in│  │
│  │ ☐ ocr         Handwritten → LaTeX       [workflow] Built-in│  │
│  │ ☐ paper2slide Paper → Beamer slides     [workflow] Built-in│  │
│  │ ☐ paper2poster Paper → poster           [workflow] Built-in│  │
│  │ ☐ transcribe  Audio transcription       [workflow] Built-in│  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  REMOTE AGENTS                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ☑ team-reviewer   Team's paper reviewer  [workflow] Public │  │
│  │ ☐ grant-writer    Grant proposal helper  [toolUse]  Team  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        ─ or if not logged in ─                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  🔒 Sign in to access shared team agents       [Sign In]  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  [Advanced: Open Agent Files]          ← Power users only      │
└─────────────────────────────────────────────────────────────────┘
```

**Category Badge Styling:**
```css
.category-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  text-transform: lowercase;
}
.category-badge--workflow {
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.category-badge--toolUse {
  background: var(--vscode-statusBarItem-prominentBackground);
  color: var(--vscode-statusBarItem-prominentForeground);
}
```

---

### Create Agent Wizard

Click **[+ Create Agent]** → AI-assisted creation:

```
┌─────────────────────────────────────────────────────────────────┐
│  Create Custom Agent                                      [×]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  What should this agent do?                                    │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Review my paper drafts and suggest improvements for       │  │
│  │ clarity, argument structure, and academic tone.           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  Agent name: [paper-reviewer    ]                              │
│                                                                 │
│  Type:                                                         │
│  ● Document processor (input → output)                         │
│  ○ Interactive chat (conversation)                             │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  💡 AI will generate the agent for you.                        │
│                                                                 │
│                                      [Cancel]  [Create Agent]  │
└─────────────────────────────────────────────────────────────────┘
```

**Flow:**
1. User describes what agent should do (plain English)
2. AI generates YAML configuration behind the scenes
3. Agent immediately appears in list, ready to use
4. No YAML knowledge required

---

### Edit Agent Form

Click **[Edit]** on custom agent → Form-based editor:

```
┌─────────────────────────────────────────────────────────────────┐
│  Edit Agent: paper-reviewer                               [×]  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  BASIC                                                         │
│  ─────────────────────────────────────────────────────────────  │
│  Name:        [paper-reviewer                ]                 │
│  Description: [Reviews papers for clarity    ]                 │
│  Category:    [workflow ▼]                                     │
│  Based on:    [correct ▼] (inherit from built-in)              │
│                                                                 │
│  INSTRUCTIONS                                                  │
│  ─────────────────────────────────────────────────────────────  │
│  What the agent should do:                                     │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ You are an academic paper reviewer. Analyze the document  │  │
│  │ for clarity, argument structure, and academic tone.       │  │
│  │ Suggest specific improvements with examples.              │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ▶ Advanced options (rounds, agentType, etc.)                  │
│                                                                 │
│  ─────────────────────────────────────────────────────────────  │
│  [View YAML]                       [Cancel]  [Test]  [Save]   │
└─────────────────────────────────────────────────────────────────┘
```

**Form fields map to YAML transparently:**
- Name → `name:`
- Description → `description:`
- Category → `agentCategory:` (workflow | toolUse)
- Based on → `inherits:`
- Instructions → `prompts.systemPrompt:`

---

### Complexity Comparison

| Task | Before (YAML) | After (UI) |
|------|---------------|------------|
| **Create agent** | Write YAML from scratch | Describe in English, AI generates |
| **Edit agent** | Edit YAML syntax | Fill out form |
| **Set inheritance** | `inherits: correct` | Dropdown: "Based on: correct" |
| **Change category** | Edit `agentCategory: workflow` | Dropdown |
| **View all agents** | File explorer + folders | Single flat list with category badges |

---

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   User Input    │────▶│   Form/Wizard   │────▶│   YAML File     │
│  (plain text)   │     │   (abstracts)   │     │  (storage)      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │  Agent Registry │
                        │  (runtime)      │
                        └─────────────────┘
```

YAML files remain the source of truth, but users interact through forms.

---

### Power User Escape Hatches

1. **[View YAML]** button in edit form - opens raw YAML
2. **[Advanced: Open Agent Files]** - opens file explorer
3. YAML files still editable directly if preferred

**Storage:** `workspaceState.enabledAgents: string[]`

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
│   ├── styles.css                   # Notion-inspired styling
│   └── modules/
│       ├── main.js                  # Entry point
│       ├── messageHandlers.js
│       ├── settingsViewState.js
│       ├── tabs/
│       │   ├── ModelsTab.js         # Models tab logic
│       │   ├── AgentsTab.js         # Agents tab logic (with categories)
│       │   ├── LatexTab.js          # LaTeX settings tab
│       │   ├── MemoryTab.js         # Memory tab logic (migrated)
│       │   ├── HistoryTab.js        # History tab logic (migrated)
│       │   └── ProfileTab.js        # Profile tab logic (migrated)
│       └── uiManagers/
│           ├── ModelListRenderer.js
│           ├── AgentListRenderer.js
│           ├── LatexSettingsRenderer.js
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
    // 'models' | 'agents' | 'latex' | 'memory' | 'history' | 'profile'
    settingsViewProvider.selectTab(tab);
  }
});

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

1. Single entry point for all configuration
2. Easy tab navigation (keyboard accessible)
3. State properly persisted (models global, agents per-workspace)
4. History search and restore working
5. Profile/auth flow unchanged
6. LaTeX settings functional and synced with VS Code config
7. Notion-style minimalist appearance achieved

---

## Implementation Phases

### Phase 1: Core Structure
- Create settingsView with tab navigation (6 tabs)
- Implement Models tab with provider accordions
- Wire up globalState for model preferences
- Test graceful migration from VS Code config
- Apply Notion-style CSS variables and spacing

### Phase 2: Agents Tab
- Implement Agents tab with local/custom/remote sections
- Add category badges (workflow/toolUse)
- Wire up workspaceState for agent preferences
- Handle remote agents auth state
- Implement AI-assisted agent creation wizard

### Phase 3: LaTeX Tab
- Implement LaTeX tab with formatter, latexdiff, TikZ sections
- Wire up to existing VS Code configuration
- Add file browser for config paths
- Add collapsible advanced sections (TikZ template, custom replacements)

### Phase 4: Memory Tab
- Migrate memoryView to Memory tab
- Add conversation persistence settings UI
- Add active sessions list with resume/discard
- Delete old memoryView

### Phase 5: Migrate History
- Move history rendering to History tab
- Preserve search, delete, restore, rerun functionality
- Delete old historyView

### Phase 6: Migrate Profile
- Move profile/auth to Profile tab
- Implement provider configuration cards
- Implement provider modal (API key + endpoint)
- Add routing options UI
- Delete old profileView

### Phase 7: Polish
- Add main webview entry point (gear icon)
- Deep link support (open to specific tab)
- Verify graceful migration (no breaking existing setups)
- Accessibility audit (keyboard navigation)
- Documentation

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
<!-- Notion-style form row (no vscode-form-group for cleaner look) -->
<div class="setting-row">
  <span class="setting-label">Formatter</span>
  <vscode-single-select>
    <vscode-option value="latexindent">latexindent</vscode-option>
    <vscode-option value="tex-fmt">tex-fmt</vscode-option>
    <vscode-option value="none">none</vscode-option>
  </vscode-single-select>
</div>

<!-- Checkbox row -->
<div class="setting-row">
  <vscode-checkbox id="showWarning">
    Show warning if latexindent is not installed
  </vscode-checkbox>
</div>

<!-- File path row with browse button -->
<div class="setting-row">
  <span class="setting-label">Config file</span>
  <div class="setting-input-group">
    <vscode-textfield placeholder="/path/to/config"></vscode-textfield>
    <vscode-button appearance="secondary">Browse</vscode-button>
  </div>
</div>
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

### Profile Tab Components
- `<vscode-radio-group>` - Access mode, routing mode
- `<vscode-textfield type="password">` - API keys
- `<vscode-button>` - Sign In/Out, Configure, Save
- `<vscode-collapsible>` - Provider details

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
  { key: 'modelsTabUri', path: 'modules/tabs/ModelsTab.js' },
  { key: 'agentsTabUri', path: 'modules/tabs/AgentsTab.js' },
  { key: 'latexTabUri', path: 'modules/tabs/LatexTab.js' },
  { key: 'memoryTabUri', path: 'modules/tabs/MemoryTab.js' },
  { key: 'historyTabUri', path: 'modules/tabs/HistoryTab.js' },
  { key: 'profileTabUri', path: 'modules/tabs/ProfileTab.js' },
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

### Shared CSS Variables (extend common.css)
```css
/* settingsView/styles/index.css */
@import '../../common/styles/common.css';

/* Notion-style settings layout */
.settings-container {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--spacing-large);
}

.section {
  padding: var(--spacing-large) 0;
}

.section + .section {
  border-top: 1px solid var(--vscode-widget-border);
}

.section-header {
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--vscode-descriptionForeground);
  margin-bottom: var(--spacing-medium);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-small) 0;
  min-height: 32px;
}

.setting-label {
  flex: 0 0 160px;
  color: var(--vscode-foreground);
}

.setting-row vscode-single-select,
.setting-row vscode-textfield {
  flex: 1;
  max-width: 300px;
}

.setting-input-group {
  display: flex;
  gap: var(--spacing-small);
  flex: 1;
  max-width: 400px;
}

.setting-input-group vscode-textfield {
  flex: 1;
}

/* Hover actions (Notion-style) */
.item-row .actions {
  opacity: 0;
  transition: opacity 0.15s;
}
.item-row:hover .actions {
  opacity: 1;
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
