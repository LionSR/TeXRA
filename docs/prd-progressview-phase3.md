# PRD: ProgressView Modernization - Phase 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

## Phase 1 & 2 Completed

### What Was Done

- **Schema consolidation**: All types in `src/shared/schemas/` using Zod v4 patterns
- **Lit component architecture**: `ProgressApp`, `FileList`, `FollowUpInput`, `StreamTabs`, etc.
- **State management**: Using Lit's native `@state()` decorator (deleted unused `createStore.ts`)
- **Message validation**: All handlers validate with Zod schemas before processing
- **Nested record helper**: `updateNestedRounds<T>()` centralizes `Record<runId, Record<round, T[]>>` updates
- **Component boundaries**: Child components emit complete payloads (e.g., `FollowupSection.getFormData()`)

### Patterns Established

1. **State ownership**: Components own their form state; parents receive via events
2. **No DOM querying across boundaries**: Use refs within component, events across components
3. **Single `setStreamState` call**: All state updates in one place, no sequential band-aids
4. **Helper functions for complex updates**: Extract reusable logic (e.g., `updateNestedRounds`)

### Technical Debt Remaining

| Priority | Issue                    | Location                                                  | Notes                                                                        |
| -------- | ------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| High     | `@ts-nocheck` directives | `formatters/*.ts`, `LogList.ts`, `TaskGroupDomManager.ts` | Incrementally enable type checking                                           |
| High     | `LogList` bypasses Lit   | `components/LogList.ts`                                   | Uses `innerHTML` and manual DOM; convert to proper Lit or plain class        |
| Medium   | `htmlBuilders.ts` SRP    | `formatters/htmlBuilders.ts` (~336 lines)                 | Split into `syntaxHighlighting.ts`, `diffRendering.ts`, `fileListBuilder.ts` |
| Low      | Duplicate DOM queries    | `FollowUpInput.ts`                                        | Extract to `getTextarea()` helper                                            |
| Low      | TodoList repeat key      | `TodoList.ts`                                             | Use unique ID instead of `content-status`                                    |

---

## Phase 3a: Migrate JS Utilities to Shared TypeScript

**Problem**: ProgressView TypeScript imports from `@common/modules/*.js` files. This creates a mixed JS/TS codebase with no type safety at boundaries.

### Current State (JS utilities imported by TS)

```
src/common/modules/*.js          → Used by ProgressView TS via @common/modules/*.js
src/common/constants/*.js        → Used by ProgressView TS
src/common/webview/*.js          → Used by ProgressView TS
```

### Target State

```
src/shared/
├── schemas/                     # ✓ Already TypeScript
├── utils/
│   ├── html.ts                  # encodeHtml, decodeHtml (from htmlEncoding.js)
│   ├── dom.ts                   # DOM helpers (from domUtils.js)
│   ├── path.ts                  # getBasename (from pathUtils.js)
│   ├── string.ts                # formatRelativeTime (from stringUtils.js)
│   ├── clipboard.ts             # copyWithFeedback (from clipboardUtils.js)
│   ├── template.ts              # createFromTemplate (from templateUtils.js)
│   ├── dropdown.ts              # applyAgentOptions (from dropdownUtils.js)
│   └── textarea.ts              # textarea helpers (from textareaUtils.js)
├── constants/
│   ├── icons.ts                 # Icon class constants (from iconConstants.js)
│   ├── streamStatus.ts          # Stream status (from streamStatus.js)
│   └── agentTypes.ts            # Agent types (from agentTypes.js)
├── state/
│   ├── ToggleStateStore.ts      # Toggle state (from ToggleStateStore.js)
│   └── WebviewStateManager.ts   # Webview state (from webviewState.js)
├── webview/
│   ├── themeHandlers.ts         # Theme handling (from themeHandlers.js)
│   └── commands.ts              # Command constants (from commands.js)
├── components/
│   └── RecordingButton.ts       # Recording button (from RecordingButtonManager.js)
├── BaseWebviewApp.ts            # ✓ Already TypeScript
├── vscode.ts                    # ✓ Already TypeScript
└── index.ts                     # Re-exports
```

### Migration Steps

1. **Create TypeScript versions** in `src/shared/utils/`, `src/shared/constants/`, etc.
2. **Add proper types** - no `any`, proper function signatures
3. **Update imports** in ProgressView to use `@shared/utils/*`
4. **Delete JS originals** from `src/common/modules/`
5. **Update path aliases** in `tsconfig.json` if needed

### Priority Order

| Priority | File                       | Lines | Complexity | Notes                      |
| -------- | -------------------------- | ----- | ---------- | -------------------------- |
| 1        | `htmlEncoding.js`          | 30    | Low        | Pure functions, easy win   |
| 2        | `iconConstants.js`         | ~50   | Low        | Just constants             |
| 3        | `pathUtils.js`             | ~30   | Low        | Pure functions             |
| 4        | `stringUtils.js`           | ~50   | Low        | Pure functions             |
| 5        | `clipboardUtils.js`        | ~30   | Low        | Simple async               |
| 6        | `domUtils.js`              | 443   | Medium     | Many functions, DOM types  |
| 7        | `templateUtils.js`         | 97    | Medium     | DOM manipulation           |
| 8        | `dropdownUtils.js`         | ~100  | Medium     | VS Code component types    |
| 9        | `textareaUtils.js`         | ~80   | Medium     | Textarea handling          |
| 10       | `ToggleStateStore.js`      | ~50   | Medium     | Class with state           |
| 11       | `webviewState.js`          | ~100  | Medium     | State management           |
| 12       | `themeHandlers.js`         | ~50   | Low        | Theme utilities            |
| 13       | `RecordingButtonManager.js`| ~150  | High       | Complex component          |

### Type Definitions Needed

```typescript
// src/shared/utils/html.ts
export function encodeHtml(value: unknown): string;
export function decodeHtml(value: unknown): string;
export function encodeListForHtml(values: unknown[], separator?: string): string;

// src/shared/utils/dom.ts
export function getRadioChangeValue(event: Event, radioGroup: HTMLElement | null): string;
export function setRadioGroupValue(radioGroup: HTMLElement, value: string, selector?: string): void;
export function setElementDisabled(element: Element, disabled: boolean): void;
export function waitForElement(selector: string, options?: { timeout?: number }): {
  promise: Promise<Element | null>;
  dispose: () => void;
};

// src/shared/state/ToggleStateStore.ts
export class ToggleStateStore {
  constructor(storageKey: string);
  get(id: string): boolean;
  set(id: string, value: boolean): void;
  toggle(id: string): boolean;
}
```

### What NOT to Migrate

View-specific JS modules will be **replaced** (not migrated) by Lit components:

- `src/webview/modules/*.js` → Replaced by MainView Lit components
- `src/historyView/modules/*.js` → Replaced by HistoryView Lit components
- `src/memoryView/modules/*.js` → Replaced by MemoryView Lit components
- `src/profileView/modules/*.js` → Replaced by ProfileView Lit components

---

## Phase 3b: Migrate Other Webviews

**Prerequisite:** Phase 3a (shared utilities) should be complete or in progress.

### Migration Order

| Order | Webview         | Handler Lines | JS Modules | Rationale                             |
| ----- | --------------- | ------------- | ---------- | ------------------------------------- |
| 1     | **HistoryView** | 160           | 7          | Simplest, good validation of patterns |
| 2     | **ProfileView** | 211           | 7          | Simple, mostly static display         |
| 3     | **MemoryView**  | 278           | 7          | Has toggle state, moderate complexity |
| 4     | **MainView**    | 461           | 80+        | Most complex after ProgressView       |

### Per-Webview Migration Template

For each webview:

#### Step 1: Schema Setup

```typescript
// src/{viewName}/schemas.ts
export * from '@shared/schemas'; // Common schemas
// Add view-specific schemas if needed
```

#### Step 2: Create Lit App

```typescript
// src/{viewName}/frontend/index.ts
import { LitElement, html } from 'lit';
import { customElement } from 'lit/decorators.js';
import '@shared/components';  // Shared components

@customElement('{view-name}-app')
export class {ViewName}App extends LitElement {
  // ...
}
```

#### Step 3: Add Webpack Entry

```javascript
// webpack.config.js
const {viewName}Config = {
  name: '{viewName}',
  entry: './src/{viewName}/frontend/index.ts',
  // ... same pattern as progressView
};
```

#### Step 4: Delete Legacy

```
DELETE: src/{viewName}/modules/
UPDATE: src/{viewName}/index.html
```

### HistoryView Migration (Example)

**Current structure:**

- `HistoryViewMessageHandler.ts`: 160 lines
- `modules/`: 7 files (HistoryRenderer, SearchManager, etc.)

**After migration:**

```
src/historyView/
├── frontend/
│   ├── index.ts
│   ├── HistoryApp.ts          # ~200 lines total
│   └── components/
│       ├── HistoryList.ts
│       └── SearchBar.ts
├── schemas.ts                  # Re-exports + history-specific
└── HistoryViewMessageHandler.ts
```

**Estimated: 2-3 days**

### MainView Migration (Largest)

**Current structure:**

- `MainViewMessageHandler.ts`: 461 lines
- `modules/`: 80+ files (FileSelect, RecordingManager, etc.)

**Key challenges:**

- Complex file selection UI
- Multiple manager classes
- Recording functionality

**After migration:**

```
src/webview/
├── frontend/
│   ├── index.ts
│   ├── MainApp.ts
│   ├── store.ts
│   └── components/
│       ├── FileSelector/
│       │   ├── FileSelector.ts
│       │   ├── FileList.ts
│       │   └── FileItem.ts
│       ├── RecordingPanel.ts
│       ├── InstructionBox.ts
│       └── ActionButtons.ts
├── schemas.ts
└── MainViewMessageHandler.ts
```

**Estimated: 1-2 weeks**

---

## Build Configuration

### Final webpack.config.js

```javascript
const path = require('path');

const baseWebviewConfig = {
  target: 'web',
  resolve: {
    extensions: ['.ts', '.js'],
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@agent': path.resolve(__dirname, 'src/agent'),
      '@common': path.resolve(__dirname, 'src/common'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@eventBus': path.resolve(__dirname, 'src/eventBus'),
      '@logger': path.resolve(__dirname, 'src/logger'),
    },
  },
  module: {
    rules: [{ test: /\.ts$/, use: 'ts-loader', exclude: /node_modules/ }],
  },
};

const webviewConfigs = [
  'progressView',
  'webview',
  'historyView',
  'profileView',
  'memoryView',
].map((name) => ({
  ...baseWebviewConfig,
  name,
  entry: `./src/${name}/frontend/index.ts`,
  output: {
    path: path.resolve(__dirname, `dist/${name}`),
    filename: 'bundle.js',
  },
}));

module.exports = [extensionConfig, ...webviewConfigs];
```

### tsconfig.json Updates

```jsonc
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "useDefineForClassFields": false,
    "paths": {
      "@shared/*": ["src/shared/*"],
      // ... existing paths
    },
  },
}
```

---

## Phase 3 Success Metrics

### Phase 3a (JS → TS Migration)

| Metric                              | Before    | After   |
| ----------------------------------- | --------- | ------- |
| JS files in `src/common/modules/`   | 25+       | 0       |
| JS files in `src/common/constants/` | 4         | 0       |
| TS files in `src/shared/utils/`     | 0         | 8+      |
| TS files in `src/shared/constants/` | 0         | 3+      |
| Mixed JS/TS imports in ProgressView | 27        | 0       |

### Phase 3b (Webview Migration)

| Metric                       | Before Phase 3 | After Phase 3 |
| ---------------------------- | -------------- | ------------- |
| Total webview JS files       | ~100+          | 0             |
| Type coverage (all webviews) | ~50%           | 100%          |
| Lit components (total)       | ~15            | ~50           |
| Webviews using Lit           | 1              | 5             |

---

## Phase 3 Risks

### Medium: Pattern Drift

Each webview migration may deviate from established patterns.

**Mitigation**: Use Phase 2 shared infrastructure. Code review against ProgressView patterns.

### Medium: Nested Record Complexity

The `Record<string, Record<string, T[]>>` pattern for run/round data is error-prone.

**Mitigation**: Use `updateNestedRounds` helper. Consider flattening to `Map<CompositeKey, T[]>` if pattern keeps causing issues.

### Low: Diminishing Returns

Smaller webviews may not benefit as much from Lit migration.

**Mitigation**: Keep migrations simple for small webviews. Don't over-engineer.

---

## Anti-Patterns to Avoid

These were fixed in Phase 1 & 2; don't reintroduce them:

1. **DOM queries for cross-component state** - Parent should not `document.getElementById()` into child
2. **Multiple sequential `setStreamState` calls** - Consolidate into single call with helper functions
3. **`@ts-nocheck` on new files** - Use proper types or `@ts-expect-error` with comments
4. **Manual DOM manipulation in Lit components** - Either use Lit properly or don't extend `LitElement`
5. **Unused abstractions** - Don't add `createStore.ts`-style helpers unless actually used
6. **Importing JS from TS** - After Phase 3a, all shared utilities must be TypeScript; no `from '*.js'` imports

---

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
