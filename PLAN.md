# Plan: Signal-Derived Pending Approval Indicator

## Problem with the Event-Driven Approach

The original plan tried to make `pendingApprovalStreamIds` event-driven state inside `appState`, updated at every permission show/resolve boundary. This is fragile because:

1. **`permissions` lives outside `appState`** — it's a Lit `@state()` property, not part of the Signal.State. Two parallel state systems tracking overlapping concerns.

2. **`removePrompt()` is blind to `appState`** — it only accesses `ctx.getPermissions()/setPermissions()`. It cannot update a Set inside `appState`. Yet it's the shared code path for **both** removal paths:
   - Backend resolve: `permissionSlice.UPDATE_PERMISSION` (action !== 'show') → `removePrompt(ctx, ...)`
   - Optimistic frontend: `eventHandlers.handlePermissionAction()` → `removePrompt(ctx, ...)`

3. **Manual sync is fragile** — every code path that touches permissions (show, resolve, optimistic remove, stream delete, delete-all) must also manually update the Set. Miss one and the indicator sticks.

## Correct Architecture: Pure Derivation via Signal

`pendingApprovalStreamIds` is a **pure function of `permissions`**. It should be a computed signal, not maintained state. The fix: promote `permissions` from `@state()` to `Signal.State`, then derive the indicator as a `Signal.Computed`.

```
permissions (Signal.State<PermissionState[]>)
  │
  ├─► permissionsContext$ (Computed → @provide context)
  │
  └─► pendingApprovalIds$ (Computed<Set<string>>)
        └─► passed to <stream-tabs .pendingApprovalStreamIds=${}>
```

All existing mutation code paths (`removePrompt`, `upsertProposalPermission`, `setPermissions` in slice handlers, optimistic removal in `handlePermissionAction`) continue to work unchanged — they call `ctx.setPermissions(next)` which now does `this.permissions$.set(next)`. The computed auto-updates.

No `willUpdate()`. No manual memoization. No event-boundary bookkeeping. No second state system to keep in sync.

## Changes by File

### 1. `src/progressView/frontend/ProgressApp.ts`

**Remove:**
- `@state() private permissions: PermissionState[] = [];`
- `private pendingApprovalStreamIds: Set<string> = new Set();`
- `private _prevApprovalIds: Set<string> = new Set();`
- `computePendingApprovalStreamIds()` method
- Both lines in `willUpdate()`:
  - `this.permissionsContextValue = this.permissions;`
  - `this.pendingApprovalStreamIds = this.computePendingApprovalStreamIds();`

**Add:**

```typescript
// Signal-based permissions (replaces @state)
private permissions$ = signal<PermissionState[]>([]);

// Derived: stream IDs with pending approvals
private pendingApprovalIds$ = new Signal.Computed(() => {
  const ids = new Set<string>();
  for (const p of this.permissions$.get()) {
    const streamId = p.data.streamId;
    if (streamId) ids.add(streamId);
  }
  return ids;
});
```

**Update `createMessageHandlerContext()`:**

```typescript
getPermissions: () => this.permissions$.get(),
setPermissions: (permissions) => { this.permissions$.set(permissions); },
```

**Update `willUpdate()`:**

```typescript
protected override willUpdate(): void {
  this.streamContextValue = this.streamContext$.get();
  this.streamLogContextValue = this.logContext$.get();
  this.permissionsContextValue = this.permissions$.get();
  // pendingApprovalStreamIds — no longer here, it's a signal read in render()
}
```

**Update render:**

```html
<stream-tabs
  .pendingApprovalStreamIds=${this.pendingApprovalIds$.get()}
  ...
>
```

### 2. `src/progressView/frontend/store.ts` — No changes

`pendingApprovalStreamIds` is NOT added to `ProgressState`. It's a derived computed on `ProgressApp`, not stored state.

### 3. `src/progressView/frontend/slices/permissionSlice.ts` — No changes

`removePrompt()`, `upsertProposalPermission()`, and all handlers continue calling `ctx.setPermissions()` exactly as before. The signal propagation handles the rest.

### 4. `src/progressView/frontend/eventHandlers.ts` — No changes

`handlePermissionAction()` continues calling `removePrompt(ctx, ...)`. The signal computed auto-derives the new Set from the updated permissions array.

### 5. `src/progressView/frontend/slices/streamLifecycleSlice.ts` — No changes

`DELETE_STREAM` already calls `ctx.setPermissions(cleaned)` where `cleaned = removePermissionsForStream(...)`. The computed picks up the new permissions array automatically.

`DELETE_ALL` already calls `ctx.setPermissions([])`. Empty array → empty Set.

### 6. `src/progressView/frontend/components/StreamTabs.ts` — No changes

Already has the `.pendingApprovalStreamIds` prop. Untouched.

## Why This Is Lit-Native Reactive

1. **`permissions$` is a `Signal.State`** — mutations via `.set()` trigger signal propagation
2. **`pendingApprovalIds$` is a `Signal.Computed`** — re-derives only when `permissions$` changes, returns a new `Set` only when contents differ
3. **`SignalWatcher` on ProgressApp** — calls `requestUpdate()` when any read signal propagates
4. **`.get()` in `render()`** — registers the signal dependency so the component only re-renders when the derived Set actually changes
5. **No `willUpdate()` needed** for this concern — the signal system handles dependency tracking and memoization natively

## Memoization Detail

The computed creates a new `Set` on every `permissions$` change. Since `Set` instances aren't structurally compared by `Object.is()`, even an unchanged set of IDs produces a new reference → StreamTabs re-renders. For the current scale (few permissions at any time), this is negligible. If needed later, add reference-equality optimization inside the computed:

```typescript
private _prevApprovalIds = new Set<string>();
private pendingApprovalIds$ = new Signal.Computed(() => {
  const ids = new Set<string>();
  for (const p of this.permissions$.get()) {
    if (p.data.streamId) ids.add(p.data.streamId);
  }
  // Stable reference when content unchanged
  if (setsEqual(ids, this._prevApprovalIds)) return this._prevApprovalIds;
  this._prevApprovalIds = ids;
  return ids;
});
```

But this is optional — the simpler version is correct and sufficient.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Multiple permissions for same stream | `Set.add()` is idempotent in the derivation |
| Stream deleted while approval pending | `DELETE_STREAM` removes permissions for stream → computed auto-clears |
| All streams deleted | `DELETE_ALL` sets `permissions = []` → computed returns empty Set |
| Permission show/resolve race | Existing `resolvedProposalIds` guard handles this; derivation is always consistent with current permissions |
| Optimistic removal in handlePermissionAction | `removePrompt` calls `setPermissions` → signal fires → computed updates |

## Summary of Why This Is Better

| Aspect | Event-Driven (original plan) | Signal-Derived (this plan) |
|--------|------------------------------|---------------------------|
| Code paths to maintain | Every show, resolve, optimistic remove, stream delete, delete-all must update the Set | Zero — derived automatically |
| Risk of stale indicator | High (miss one path → stuck orange dot) | Zero (pure function of permissions) |
| Changes to permissionSlice | Yes (add Set management) | None |
| Changes to eventHandlers | Yes (add Set cleanup after removePrompt) | None |
| Changes to store.ts | Yes (new field + initializer) | None |
| Complexity | Split-brain: permissions in @state + Set in appState | Single source: permissions$ signal → computed |
