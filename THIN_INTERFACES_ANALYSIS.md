# Thin Interfaces Analysis - Did We Go Too Far?

## Current State After Removing Duplication

```typescript
export interface WorkspaceLocationInfo {
  relativePath: string;  // ← Just ONE field!
}

export interface RunStorageLocationInfo {
  relativePath: string;         // Run-relative
  storageRelativePath: string;  // Storage-relative (2 fields)
}

export interface FileLocation {
  absolutePath: string;
  scope: 'workspace' | 'runStorage' | 'external';
  workspace: WorkspaceLocationInfo | null;
  runStorage: RunStorageLocationInfo | null;
}
```

## The Problem: Over-Engineering?

**WorkspaceLocationInfo is ridiculously thin:**
```typescript
// Current (over-engineered?)
workspace: { relativePath: string } | null

// Could just be:
workspace: string | null  // The relative path itself
```

**Is this interface adding value or just ceremony?**

---

## Options to Consider

### Option 1: Inline the Simple One (WorkspaceLocationInfo)

```typescript
export interface RunStorageLocationInfo {
  relativePath: string;
  storageRelativePath: string;
}

export interface FileLocation {
  absolutePath: string;
  scope: 'workspace' | 'runStorage' | 'external';
  workspaceRelativePath: string | null;  // ← Just a string!
  runStorage: RunStorageLocationInfo | null;  // ← Keep as object (has 2 fields)
}
```

**Pros:**
- ✅ No over-engineering for single-field wrapper
- ✅ Still clear what `workspaceRelativePath` means
- ✅ RunStorage keeps structure (has 2 distinct paths)

**Cons:**
- ❌ Asymmetry (workspace is string, runStorage is object)

---

### Option 2: Inline Both (Flatten Everything)

```typescript
export interface FileLocation {
  absolutePath: string;
  scope: 'workspace' | 'runStorage' | 'external';
  
  // Workspace info (null if not in workspace)
  workspaceRelativePath: string | null;
  
  // Run storage info (both null if not in runStorage)
  runStorageRelativePath: string | null;
  runStorageFullPath: string | null;  // includes taskRuns/<id>/
}
```

**Pros:**
- ✅ Simple, flat structure
- ✅ No wrapper objects
- ✅ Clear field names

**Cons:**
- ❌ Harder to check "is in workspace?" (need null check on field)
- ❌ Two runStorage fields must always be null together (not enforced)
- ❌ More nullable fields to check

---

### Option 3: Keep Current Structure (Thin but Consistent)

```typescript
// Keep as-is
export interface WorkspaceLocationInfo {
  relativePath: string;
}

export interface RunStorageLocationInfo {
  relativePath: string;
  storageRelativePath: string;
}

export interface FileLocation {
  absolutePath: string;
  scope: 'workspace' | 'runStorage' | 'external';
  workspace: WorkspaceLocationInfo | null;
  runStorage: RunStorageLocationInfo | null;
}
```

**Pros:**
- ✅ Consistent structure (both are objects)
- ✅ Easy to check: `if (location.workspace)` → is in workspace
- ✅ Extensible (can add fields to WorkspaceLocationInfo later)

**Cons:**
- ❌ Over-engineered for single-field wrapper
- ❌ More ceremony than needed

---

### Option 4: Union Type (Discriminated)

```typescript
export type FileLocation =
  | {
      absolutePath: string;
      scope: 'workspace';
      workspaceRelativePath: string;
    }
  | {
      absolutePath: string;
      scope: 'runStorage';
      runStorageRelativePath: string;
      runStorageFullPath: string;
    }
  | {
      absolutePath: string;
      scope: 'external';
    };
```

**Pros:**
- ✅ Type-safe: TypeScript knows which fields exist based on scope
- ✅ No nullable fields (each variant has exactly what it needs)
- ✅ Can't access wrong fields

**Cons:**
- ❌ Harder to work with (need type narrowing)
- ❌ Can't easily check "is in workspace?" without type guard
- ❌ More complex for common cases

---

## Usage Comparison

### Current (Option 3):
```typescript
// Check if in workspace
if (location.workspace) {
  const rel = location.workspace.relativePath;  // ceremony
}

// Get relative path
const rel = location.workspace?.relativePath;
```

### Option 1 (Inline workspace):
```typescript
// Check if in workspace
if (location.workspaceRelativePath) {
  const rel = location.workspaceRelativePath;  // simpler!
}

// Get relative path
const rel = location.workspaceRelativePath;  // direct!
```

### Option 4 (Union):
```typescript
// Check if in workspace
if (location.scope === 'workspace') {
  const rel = location.workspaceRelativePath;  // type-safe!
}

// Get relative path (need narrowing)
const rel = location.scope === 'workspace' 
  ? location.workspaceRelativePath 
  : null;
```

---

## My Recommendation

**Option 1: Inline WorkspaceLocationInfo, keep RunStorageLocationInfo**

```typescript
export interface RunStorageLocationInfo {
  relativePath: string;
  storageRelativePath: string;
}

export interface FileLocation {
  absolutePath: string;
  scope: 'workspace' | 'runStorage' | 'external';
  workspaceRelativePath: string | null;
  runStorage: RunStorageLocationInfo | null;
}
```

**Why:**
- Single-field wrappers don't justify existence
- RunStorage has 2 fields → keep as structured object
- Workspace is just one path → inline it
- Simpler to use: `location.workspaceRelativePath` vs `location.workspace?.relativePath`
- Still clear and maintainable

**Alternative names:**
- `workspaceRelative`
- `workspacePath`
- `relativeToWorkspace`

---

## Question for User

Which approach makes more sense architecturally?

1. **Inline workspace only** (my recommendation)
2. **Flatten everything** (simplest)
3. **Keep thin interfaces** (most consistent)
4. **Union type** (most type-safe)

Or is there another structure that would be cleaner?
