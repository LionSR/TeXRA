# PRD: Lit-Native Improvements - Phase 8

> **Parent doc:** [prd-progressview-modernization.md](./prd-progressview-modernization.md)
> **Prior phase:** [prd-mainview-phase7.md](./prd-mainview-phase7.md)
> **Related:** [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md)

## Overview

Phase 8 focuses on making the codebase more idiomatically Lit-native by adopting Lit directives, reactive patterns, and modern component architecture. This phase addresses technical debt from the initial Lit migration where imperative patterns were preserved for expediency.

> **Status: Not Started**

## Prerequisites

- Phase 6: Component extraction complete
- Phase 7: Zod-native types complete (or in progress)
- All critical regressions fixed

## Status Summary

| Task                                    | Status      | Impact                     |
| --------------------------------------- | ----------- | -------------------------- |
| 8.1 styleMap directive adoption         | Not Started | Consistency, type safety   |
| 8.2 @lit-labs/virtualizer for LogList   | Not Started | Performance for 1000+ logs |
| 8.3 TaskGroupDomManager → Declarative   | Not Started | Architecture cleanup       |
| 8.4 @lit/context for state distribution | Not Started | Eliminate prop drilling    |
| 8.5 Light DOM → Shadow DOM migration    | Not Started | Style encapsulation        |
| 8.6 Additional directive opportunities  | Not Started | Code quality               |

---

## 8.1 styleMap Directive Adoption (HIGH Priority)

**Problem:** 6+ files use inline style template strings instead of the `styleMap` directive.

**Current (fragile):**

```typescript
style=${this.listVisible ? 'display: block' : 'display: none'}
```

**Target (type-safe):**

```typescript
import { styleMap } from 'lit/directives/style-map.js';

style=${styleMap({ display: this.listVisible ? 'block' : 'none' })}
```

**Benefits:**

- Type checking for CSS property names
- Cleaner syntax for multiple properties
- Consistent with Lit best practices

### Files to Update

| File                                                                                | Line          | Current Pattern    |
| ----------------------------------------------------------------------------------- | ------------- | ------------------ |
| `src/webview/frontend/components/FileSelectGroup.ts`                                | 627           | Visibility toggle  |
| `src/webview/frontend/components/OutputFilesSection.ts`                             | 232           | Expanded toggle    |
| `src/webview/frontend/components/LatexDiffsSection.ts`                              | 264           | Visible toggle     |
| `src/webview/frontend/components/InstructionPanel.ts`                               | 339, 347, 359 | Debug mode toggles |
| `src/progressView/frontend/formatters/logFormatters/messageFormatters.ts`           | 134           | Visibility style   |
| `src/progressView/frontend/formatters/logFormatters/contextManagementFormatters.ts` | 153           | Color styles       |

**Effort:** Low (30 minutes)

---

## 8.2 @lit-labs/virtualizer for LogList (HIGH Priority)

**Problem:** LogList renders all log entries regardless of viewport visibility. Performance degrades significantly with 1000+ log entries.

**Location:** `src/progressView/frontend/components/LogList.ts`

**Current state:**

- Uses `document.createDocumentFragment()` for batch DOM operations
- All entries rendered upfront
- No incremental rendering during streaming

**Target architecture:**

```typescript
import { virtualize } from '@lit-labs/virtualizer/virtualize.js';

render() {
  return html`
    <div class="log-container">
      ${virtualize({
        items: this.sortedMessages,
        renderItem: (msg) => this.renderLogEntry(msg),
      })}
    </div>
  `;
}
```

**Benefits:**

- Only visible entries rendered (O(viewport) vs O(n))
- Smooth scrolling with large datasets
- Memory efficiency

**Challenges:**

- Integration with existing `LogEntryManager` caching
- Streaming append pattern compatibility
- Group header positioning

**Effort:** Medium (2-3 hours)

---

## 8.3 TaskGroupDomManager → Declarative Component (CRITICAL)

**Problem:** `TaskGroupDomManager.ts` is the largest source of imperative DOM manipulation, mixing multiple concerns.

**Location:** `src/progressView/frontend/managers/TaskGroupDomManager.ts`

### Current Issues

| Concern                   | Lines                         | Coupling Issue              |
| ------------------------- | ----------------------------- | --------------------------- |
| DOM element management    | 74-165                        | Core responsibility         |
| Toggle state persistence  | 45-72                         | Should be in state manager  |
| Audio notifications       | 224-245 (`playSystemSound()`) | Should be dedicated service |
| Traversal/hierarchy logic | 180-220                       | Could be separate utility   |

### Current (Imperative)

```typescript
const fragment = document.createDocumentFragment();
for (const group of topLevel) {
  const element = this._createGroupElement(group);
  fragment.appendChild(element);
  traversalQueue.push(group.id);
}
container.appendChild(fragment);
```

### Target (Declarative Lit Component)

```typescript
// TaskGroupList.ts (new Lit component)
@customElement('task-group-list')
export class TaskGroupList extends LitElement {
  @property({ type: Array }) groups: TaskGroup[] = [];
  @state() private expandedGroups = new Set<string>();

  render() {
    return html`
      ${repeat(
        this.getTopLevelGroups(),
        (g) => g.id,
        (group) => this.renderGroup(group),
      )}
    `;
  }

  private renderGroup(group: TaskGroup): TemplateResult {
    return html`
      <details
        ?open=${this.expandedGroups.has(group.id)}
        @toggle=${() => this.toggleGroup(group.id)}
      >
        <summary>${this.renderGroupHeader(group)}</summary>
        ${this.renderGroupChildren(group)}
      </details>
    `;
  }
}
```

### Extraction Plan

1. **Extract AudioNotificationService**

   ```typescript
   // src/progressView/frontend/services/AudioNotificationService.ts
   export class AudioNotificationService {
     playCompletionSound(): void {
       const ctx = new AudioContext();
       const osc = ctx.createOscillator();
       osc.type = 'sine';
       osc.frequency.value = 880;
       osc.connect(ctx.destination);
       osc.start();
       setTimeout(() => {
         osc.stop();
         ctx.close();
       }, 150);
     }
   }
   ```

2. **Extract ToggleStateManager**

   ```typescript
   // src/progressView/frontend/state/ToggleStateManager.ts
   export class ToggleStateManager {
     private states = new Map<string, boolean>();

     toggle(id: string): boolean { ... }
     isExpanded(id: string): boolean { ... }
     persist(): void { ... }
   }
   ```

3. **Create declarative TaskGroupList component**

4. **Delete TaskGroupDomManager.ts**

**Effort:** High (4-6 hours)

---

## 8.4 @lit/context for State Distribution (MEDIUM Priority)

**Problem:** Prop drilling through multiple component levels creates verbose, fragile code.

### MainApp → FileSelectGroup (11+ props)

**Current:**

```typescript
<file-select-group
  .config=${config}
  .selectedValue=${this.getFileValue(config.type)}
  .options=${this.getFileOptions(config.type)}
  .listVisible=${this.getFilesVisible(config.type)}
  .files=${this.getFiles(config.type)}
  .checkboxValues=${this.checkboxValues}
  .isToolUse=${isToolUse}
  @file-change=${this.handleComponentFileChange}
  @panel-action=${this.handleComponentPanelAction}
  ...
></file-select-group>
```

**Target with Context:**

```typescript
// Define contexts
export const fileStateContext = createContext<FileState>('file-state');
export const sessionContext = createContext<SessionInfo>('session');

// Provider (MainApp)
<context-provider .context=${fileStateContext} .value=${this.fileState}>
  <context-provider .context=${sessionContext} .value=${this.sessionInfo}>
    ${repeat(FILE_SELECT_CONFIGS, (config) => config.type, (config) => html`
      <file-select-group .config=${config}></file-select-group>
    `)}
  </context-provider>
</context-provider>

// Consumer (FileSelectGroup)
@consume({ context: fileStateContext }) fileState!: FileState;
@consume({ context: sessionContext }) session!: SessionInfo;
```

### Context Candidates

| Context              | Provider       | Consumers                                      |
| -------------------- | -------------- | ---------------------------------------------- |
| `FileStateContext`   | MainApp        | FileSelectGroup, OutputFilesSection            |
| `SessionContext`     | MainApp        | InstructionPanel, FileSelectGroup, BannerGroup |
| `StreamStateContext` | ProgressApp    | ToolUseStreamContent, WorkflowStreamContent    |
| `PromptsContext`     | ProgressApp    | PromptOverlay                                  |
| `ThemeContext`       | BaseWebviewApp | All components                                 |

**Effort:** Medium (2-3 hours per context)

---

## 8.5 Light DOM → Shadow DOM Migration (MEDIUM Priority)

**Problem:** Three components use Light DOM intentionally but could potentially migrate to Shadow DOM for better encapsulation.

### Current Light DOM Components

| Component                  | Reason for Light DOM                      |
| -------------------------- | ----------------------------------------- |
| `LogList.ts`               | Imperative DOM manipulation, external CSS |
| `ToolUseStreamContent.ts`  | `display: contents` pass-through          |
| `WorkflowStreamContent.ts` | `display: contents` pass-through          |

### Migration Feasibility

**LogList.ts** - Medium difficulty

- Requires refactoring to use Lit templates instead of `appendChild()`
- Formatters already return `TemplateResult` via `renderToElement()` bridge
- Could adopt virtualizer (8.2) as part of this migration

**StreamContent components** - Low difficulty

- Primary reason is CSS pass-through to nested formatters
- Formatters now use Lit templates internally
- Could move to Shadow DOM with `:host { display: contents; }`

### Benefits

- Style encapsulation
- Cleaner component boundaries
- Elimination of global CSS coupling

**Effort:** Medium-High (depends on 8.2 and 8.3 completion)

---

## 8.6 Additional Directive Opportunities (LOW Priority)

### Currently Used Directives

| Directive      | Files | Status             |
| -------------- | ----- | ------------------ |
| `repeat()`     | 12+   | Good coverage      |
| `when()`       | 8     | Good coverage      |
| `classMap()`   | 7     | Good coverage      |
| `ifDefined()`  | 7     | Good coverage      |
| `unsafeHTML()` | 5     | Used appropriately |
| `live()`       | 2     | Form inputs        |
| `ref()`        | 3     | Element references |

### Missing Directive Opportunities

#### cache() - Expensive Conditional Templates

**Use case:** Preserve DOM state for conditionally rendered expensive templates

```typescript
import { cache } from 'lit/directives/cache.js';

render() {
  return html`
    ${cache(this.showAdvanced
      ? html`<advanced-settings></advanced-settings>`
      : html`<basic-settings></basic-settings>`
    )}
  `;
}
```

#### until() - Async Data Loading

**Use case:** Show loading state while awaiting data

```typescript
import { until } from 'lit/directives/until.js';

render() {
  return html`
    ${until(
      this.loadOptions().then(opts => html`<select>${opts.map(...)}</select>`),
      html`<span class="loading">Loading...</span>`
    )}
  `;
}
```

#### keyed() - Force Re-render

**Use case:** Force complete re-render when identity changes

```typescript
import { keyed } from 'lit/directives/keyed.js';

render() {
  return html`
    ${keyed(this.streamId, html`
      <stream-content .streamId=${this.streamId}></stream-content>
    `)}
  `;
}
```

#### asyncAppend() - Streaming Content

**Use case:** Append items as they arrive from async source

```typescript
import { asyncAppend } from 'lit/directives/async-append.js';

render() {
  return html`
    <div class="log-container">
      ${asyncAppend(this.logStream)}
    </div>
  `;
}
```

**Effort:** Low (add as needed)

---

## Implementation Plan

### Phase 8a: Quick Wins (1-2 hours)

1. Add `styleMap` to all 6+ files
2. Audit `unsafeHTML` usage for security

### Phase 8b: Performance (3-4 hours)

1. Evaluate `@lit-labs/virtualizer` for LogList
2. Prototype integration
3. Measure performance improvement

### Phase 8c: Architecture (6-8 hours)

1. Extract AudioNotificationService from TaskGroupDomManager
2. Extract ToggleStateManager
3. Create declarative TaskGroupList component
4. Delete TaskGroupDomManager.ts

### Phase 8d: State Management (4-6 hours)

1. Install `@lit/context`
2. Define context types
3. Implement FileStateContext
4. Implement SessionContext
5. Migrate MainApp → FileSelectGroup prop chain

### Phase 8e: Shadow DOM Migration (4-6 hours)

1. Migrate StreamContent components (depends on 8c)
2. Migrate LogList (depends on 8b and 8c)

---

## Success Metrics

| Metric                                 | Before | Target                       |
| -------------------------------------- | ------ | ---------------------------- |
| Inline style strings                   | 6+     | 0                            |
| Imperative DOM files                   | 2      | 0                            |
| Props passed MainApp → FileSelectGroup | 11     | 3 (config only)              |
| Light DOM components                   | 3      | 0 (or documented exceptions) |
| LogList render time (1000 items)       | ~500ms | <50ms                        |
| TaskGroupDomManager lines              | ~400   | 0 (deleted)                  |

---

## Risks

### Medium: Virtualizer Compatibility

LogList has complex streaming/append patterns that may conflict with virtualizer.

**Mitigation:**

- Prototype with simple list first
- Keep imperative fallback for edge cases
- Measure actual performance before committing

### Medium: Context Overhead

Adding context providers increases component tree depth.

**Mitigation:**

- Only use context for truly shared state
- Benchmark re-render performance
- Consider signals if context is too heavy

### Low: Shadow DOM CSS Migration

Moving to Shadow DOM requires CSS restructuring.

**Mitigation:**

- Formatters already use Lit templates
- Incremental migration (one component at a time)
- Keep external CSS for truly global styles

---

## References

- [Lit Directives Documentation](https://lit.dev/docs/templates/directives/)
- [@lit-labs/virtualizer](https://github.com/lit/lit/tree/main/packages/labs/virtualizer)
- [@lit/context](https://lit.dev/docs/data/context/)
- [ui-regressions-lit-migration.md](./ui-regressions-lit-migration.md) - CSS regression tracking
- [prd-progressview-phase6.md](./prd-progressview-phase6.md) - Component extraction patterns
