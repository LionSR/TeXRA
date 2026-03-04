# Plan: Auto-Focus Approval Panel + Pending Indicator

## Two changes, two commits. No essays.

---

### Commit 1: Auto-focus stream tab on proposal approval

Already done correctly. `AgentProposalCoordinator.ts` emits `setActiveStream` before
`waitForUserAction()`. The existing `ProgressEventHandler.handleSetActiveStream()` guard
prevents switching away from a stream with pending permissions. No changes needed.

**Files:** `src/agent/runtime/AgentProposalCoordinator.ts` (already committed)

---

### Commit 2: Signal-derived pending-approval tab indicator

#### Problem with current code

`computePendingApprovalStreamIds()` in `willUpdate()` is manual memoization bolted onto
a Lit `@state()` property. The plan we committed said this was wrong. It is. Fix it.

#### What to do

**`src/progressView/frontend/ProgressApp.ts`:**

1. Replace `@state() private permissions` with a `Signal.State`:
   ```typescript
   private permissions$ = signal<PermissionState[]>([]);
   ```

2. Add a derived computed for pending approval stream IDs:
   ```typescript
   private pendingApprovalIds$ = new Signal.Computed(() => {
     const ids = new Set<string>();
     for (const p of this.permissions$.get()) {
       const streamId = p.data.streamId;
       if (streamId) ids.add(streamId);
     }
     return ids;
   });
   ```

3. Update `createMessageHandlerContext()`:
   ```typescript
   getPermissions: () => this.permissions$.get(),
   setPermissions: (permissions) => { this.permissions$.set(permissions); },
   ```

4. Update `willUpdate()` — replace `this.permissions` line with signal read:
   ```typescript
   this.permissionsContextValue = this.permissions$.get();
   ```
   Delete the `this.pendingApprovalStreamIds = this.computePendingApprovalStreamIds();` line.

5. Update `render()` — read the computed directly:
   ```html
   .pendingApprovalStreamIds=${this.pendingApprovalIds$.get()}
   ```

6. Delete: `computePendingApprovalStreamIds()`, `_prevApprovalIds`, `pendingApprovalStreamIds` field.

**`src/progressView/frontend/components/StreamTabs.ts`:**

7. Fix CSS: Use `--vscode-charts-orange` directly instead of `--color-warning` (which is
   identical to `status-initializing`). Add a pulse animation so the indicator is
   unambiguously "needs attention", not "loading":
   ```css
   @keyframes pulse-border {
     0%, 100% { border-left-color: var(--vscode-charts-orange, #d18616); }
     50% { border-left-color: transparent; }
   }

   .tab-container.has-pending-approval {
     animation: pulse-border 2s ease-in-out infinite;
   }
   ```
   This overrides any status color via the animation (no specificity games), and is
   visually distinct from every other state.

#### What NOT to change

- `permissionSlice.ts` — unchanged. `removePrompt()` calls `setPermissions()` which now does `permissions$.set()`.
- `eventHandlers.ts` — unchanged. Same reason.
- `streamLifecycleSlice.ts` — unchanged. `DELETE_STREAM` and `DELETE_ALL` go through `setPermissions()`.
- `store.ts` — unchanged. `pendingApprovalStreamIds` is not stored state.

---

### Commit 3: Delete PLAN.md

This file. It doesn't belong in the repo. Delete it after the work is done.
