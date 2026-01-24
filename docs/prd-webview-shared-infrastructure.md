# PRD: Webview Shared Infrastructure

## Overview

Establish shared infrastructure for all 5 webviews before modernizing individual views. This creates a foundation that makes each webview migration faster and more consistent.

## Current State

### Webview Inventory

| Webview | MessageHandler | JS Modules | Type Safety | Complexity |
|---------|----------------|------------|-------------|------------|
| **ProgressView** | 1,526 lines | 67+ files | None | Critical |
| **MainView** | 461 lines | 80+ files | Partial (has types.ts) | High |
| **MemoryView** | 278 lines | 7 files | None | Low |
| **ProfileView** | 211 lines | 7 files | None | Low |
| **HistoryView** | 160 lines | 7 files | None | Low |

### Shared Pain Points (All Webviews)

1. **Untyped IPC Messages**
   - Each webview has its own `commands.js` constants
   - No validation on message payloads
   - Backend and frontend can drift out of sync

2. **Manual DOM Manipulation**
   - Template strings with innerHTML
   - `document.getElementById()` + null checks
   - `classList.add/remove/toggle` scattered everywhere

3. **No Component Reuse**
   - Each webview reimplements buttons, containers, lists
   - Styling duplicated across CSS files
   - No shared interaction patterns

4. **Inconsistent State Management**
   - Each view has custom persistence patterns
   - ToggleStateStore exists but not universally used
   - WebviewStateManager API used differently per view

## Goals

**Phase 0: Shared Infrastructure**
- Typed IPC protocol usable by all webviews
- Shared Lit component library
- Unified build configuration

**Phase 1: ProgressView Migration** (separate PRD)
- Highest complexity, highest ROI

**Phase 2: Other Webviews** (future)
- MainView, HistoryView, ProfileView, MemoryView
- Each becomes trivial after infrastructure exists

## Non-Goals

- Changing backend EventBus architecture
- Consolidating webviews into one
- Adding new features during migration

---

## Architecture

### Directory Structure

```
src/
├── shared/                    # NEW: Browser-compatible, shared by all
│   ├── schemas/
│   │   ├── ipc.ts            # Base IPC message schemas
│   │   ├── progress.ts       # ProgressView-specific schemas
│   │   ├── main.ts           # MainView-specific schemas
│   │   ├── history.ts        # HistoryView-specific schemas
│   │   ├── profile.ts        # ProfileView-specific schemas
│   │   └── memory.ts         # MemoryView-specific schemas
│   ├── components/           # Shared Lit components
│   │   ├── Button.ts
│   │   ├── Card.ts
│   │   ├── Tabs.ts
│   │   ├── List.ts
│   │   └── index.ts
│   └── utils/                # Browser-safe utilities
│       ├── formatting.ts
│       └── validation.ts
├── progressView/
│   ├── frontend/             # NEW: Lit components (Phase 1)
│   └── modules/              # LEGACY: Delete after migration
├── webview/                  # MainView (Phase 2)
├── historyView/              # Phase 2
├── profileView/              # Phase 2
└── memoryView/               # Phase 2
```

### Shared IPC Protocol

```typescript
// src/shared/schemas/ipc.ts

import { z } from 'zod';

// Base message envelope - all webviews use this
export const IPCMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown(),
  timestamp: z.number().optional(),
});

// Discriminated union for type-safe dispatch
export const createIPCSchema = <T extends string, P extends z.ZodType>(
  type: T,
  payloadSchema: P
) => z.object({
  type: z.literal(type),
  payload: payloadSchema,
});

// Common payloads used by multiple webviews
export const ReadyMessageSchema = createIPCSchema('ready', z.object({}));

export const ErrorMessageSchema = createIPCSchema('error', z.object({
  code: z.string(),
  message: z.string(),
}));

// Webview → Extension (common actions)
export const FileActionSchema = createIPCSchema('file/action', z.object({
  action: z.enum(['open', 'reveal', 'copy', 'delete']),
  path: z.string(),
}));

export const SettingsToggleSchema = createIPCSchema('settings/toggle', z.object({
  key: z.string(),
  value: z.boolean(),
}));
```

### Per-Webview Schema Pattern

```typescript
// src/shared/schemas/progress.ts

import { z } from 'zod';
import { createIPCSchema } from './ipc';

// ProgressView-specific schemas
export const StreamSchema = z.object({
  id: z.string(),
  label: z.string(),
  agentCategory: z.enum(['workflow', 'toolUse']),
  status: z.enum(['idle', 'running', 'completed', 'error']),
});

export const SyncFullMessageSchema = createIPCSchema('sync/full', z.object({
  streams: z.array(StreamSchema),
  activeStreamId: z.string().nullable(),
}));

// Union of all ProgressView messages
export const ProgressIPCMessageSchema = z.discriminatedUnion('type', [
  SyncFullMessageSchema,
  // ... other progress messages
]);

export type ProgressIPCMessage = z.infer<typeof ProgressIPCMessageSchema>;
```

### Shared Lit Components

```typescript
// src/shared/components/Button.ts

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('texra-button')
export class TexraButton extends LitElement {
  static styles = css`
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    :host([variant="secondary"]) button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
  `;

  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) variant: 'primary' | 'secondary' = 'primary';

  render() {
    return html`
      <button ?disabled=${this.disabled} @click=${this._onClick}>
        <slot></slot>
      </button>
    `;
  }

  private _onClick(e: Event) {
    if (this.disabled) {
      e.stopPropagation();
    }
  }
}
```

```typescript
// src/shared/components/Tabs.ts

import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('texra-tabs')
export class TexraTabs extends LitElement {
  static styles = css`
    :host {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    ::slotted([slot="tab"]) {
      padding: 8px 16px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
    }
    ::slotted([slot="tab"][active]) {
      border-bottom-color: var(--vscode-focusBorder);
    }
  `;

  @property({ type: String }) activeTab = '';

  render() {
    return html`<slot name="tab"></slot>`;
  }
}
```

---

## Build Configuration

### Webpack Multi-Entry

```javascript
// webpack.config.js additions

const webviewConfigs = [
  'progressView',
  'webview',      // MainView
  'historyView',
  'profileView',
  'memoryView',
].map(name => ({
  name: `${name}-frontend`,
  entry: `./src/${name}/frontend/index.ts`,
  output: {
    path: path.resolve(__dirname, `dist/${name}`),
    filename: 'bundle.js',
  },
  target: 'web',  // Browser environment
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  // ... rest of config
}));

module.exports = [extensionConfig, ...webviewConfigs];
```

### TypeScript Configuration

```jsonc
// tsconfig.json additions
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "paths": {
      "@shared/*": ["src/shared/*"]
    }
  }
}
```

### Package Dependencies

```jsonc
// package.json additions
{
  "dependencies": {
    "lit": "^3.1.0"
  },
  "devDependencies": {
    "@lit/reactive-element": "^2.0.0"
  }
}
```

---

## Migration Strategy

### Phase 0: Infrastructure (This PRD)

**Week 1: Foundation**

1. Create `src/shared/` directory structure
2. Add Lit dependency and webpack entries
3. Implement base IPC schemas (`ipc.ts`)
4. Create 3-4 shared components (Button, Card, Tabs, List)

**Week 2: Validation**

5. Add ProgressView schemas (`progress.ts`)
6. Wire up schema validation in `ProgressViewMessageHandler.ts`
7. Verify existing functionality unchanged

**Deliverable**: Shared infrastructure ready, ProgressView has typed messages.

### Phase 1: ProgressView (Separate PRD)

Uses infrastructure from Phase 0. See `prd-progressview-modernization.md`.

### Phase 2: Other Webviews (Future PRDs)

| Webview | Effort | Notes |
|---------|--------|-------|
| HistoryView | 2-3 days | Simplest, good pilot |
| ProfileView | 2-3 days | Simple, mostly static |
| MemoryView | 3-4 days | Has toggle state |
| MainView | 1-2 weeks | Complex file selection |

Each migration follows same pattern:
1. Add schemas to `src/shared/schemas/{view}.ts`
2. Create `src/{view}/frontend/` with Lit components
3. Wire up message handler with validation
4. Delete `src/{view}/modules/` when complete

---

## Shared Component Library

### Component Inventory

| Component | Used By | Purpose |
|-----------|---------|---------|
| `<texra-button>` | All | Primary/secondary actions |
| `<texra-tabs>` | Progress, Main | View switching |
| `<texra-card>` | All | Content containers |
| `<texra-list>` | Progress, History | Scrollable item lists |
| `<texra-badge>` | Progress, Main | Status indicators |
| `<texra-input>` | Main, Memory | Text input with validation |
| `<texra-checkbox>` | Profile, Memory | Boolean toggles |
| `<texra-dropdown>` | Main | Selection menus |
| `<texra-modal>` | Progress | Overlays and dialogs |
| `<texra-toolbar>` | Progress, Main | Action button groups |

### Design Tokens

```css
/* src/shared/styles/tokens.css */
:root {
  /* Spacing */
  --texra-space-xs: 4px;
  --texra-space-sm: 8px;
  --texra-space-md: 16px;
  --texra-space-lg: 24px;

  /* Typography */
  --texra-font-mono: var(--vscode-editor-font-family);
  --texra-font-size-sm: 12px;
  --texra-font-size-md: 13px;

  /* Borders */
  --texra-radius-sm: 3px;
  --texra-radius-md: 6px;

  /* Transitions */
  --texra-transition-fast: 100ms ease;
  --texra-transition-normal: 200ms ease;
}
```

---

## Success Metrics

### After Phase 0

| Metric | Current | After |
|--------|---------|-------|
| Shared schemas | 0 | 6 files |
| Shared components | 0 | 10+ |
| Type-safe message handlers | 1 (partial) | 5 |
| Build entries | 1 | 6 |

### After All Phases

| Metric | Current | After |
|--------|---------|-------|
| Total JS modules (all webviews) | 168+ | ~60 |
| Duplicate component code | ~2000 lines | 0 |
| Type coverage (webview code) | ~10% | 100% |
| Shared component reuse | 0 | 40+ usages |

---

## Risks

### Medium: Lit Learning Curve

Team may be unfamiliar with Lit patterns. **Mitigation**: Start with simple components (Button, Card). Document patterns in AGENTS.md.

### Medium: Bundle Size Increase

Each webview adds ~5KB for Lit. **Mitigation**: Acceptable tradeoff for maintainability. Can tree-shake unused components.

### Low: VSCode Elements Compatibility

Already use `@vscode/webview-ui-toolkit` in some places. **Mitigation**: Wrap or replace incrementally. Both use web components standard.

---

## References

- [Lit Documentation](https://lit.dev/)
- [VSCode Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens Source](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews
- [Zod Documentation](https://zod.dev/)
