# PRD: ProgressView Modernization - Phase 3

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)

## Phase 3: Migrate Other Webviews

**Prerequisite:** Phase 1 (ProgressView) and Phase 2 (shared infrastructure extraction) must be complete.

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

| Metric                       | Before Phase 3 | After Phase 3 |
| ---------------------------- | -------------- | ------------- |
| Total webview JS files       | ~100+          | ~40           |
| Type coverage (all webviews) | ~50%           | 100%          |
| Lit components (total)       | ~15            | ~50           |
| Webviews using Lit           | 1              | 5             |

---

## Phase 3 Risks

### Medium: Pattern Drift

Each webview migration may deviate from established patterns.

**Mitigation**: Use Phase 2 shared infrastructure. Code review against ProgressView patterns.

### Low: Diminishing Returns

Smaller webviews may not benefit as much from Lit migration.

**Mitigation**: Keep migrations simple for small webviews. Don't over-engineer.

---

## References

- [Lit Documentation](https://lit.dev/)
- [Lit Reactive Controllers](https://lit.dev/docs/composition/controllers/)
- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [GitLens](https://github.com/gitkraken/vscode-gitlens) - Production Lit webviews in VS Code
- [Zod Documentation](https://zod.dev/)
