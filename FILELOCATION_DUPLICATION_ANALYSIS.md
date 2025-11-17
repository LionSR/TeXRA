# FileLocation Interface - Duplication Analysis

## Current Structure (Has Duplication!)

```typescript
export interface FileLocation {
  absolutePath: string;              // 1️⃣ The file's absolute path
  scope: FileLocationScope;          // workspace | runStorage | external
  relativePath: string;              // 2️⃣ A relative path (but relative to what?)
  relativeScope: FileRelativeScope;  // workspace | runStorage | absolute
  workspace: WorkspaceLocationInfo | null;
  runStorage: RunStorageLocationInfo | null;
}

export interface WorkspaceLocationInfo {
  absolutePath: string;              // 1️⃣ DUPLICATE! Same as FileLocation.absolutePath (if in workspace)
  relativePath: string;              // 2️⃣ DUPLICATE! Workspace-relative path
}

export interface RunStorageLocationInfo {
  absolutePath: string;              // 1️⃣ DUPLICATE! Same as FileLocation.absolutePath (if in runStorage)
  relativePath: string;              // 2️⃣ DUPLICATE! RunStorage-relative path
  storageRelativePath: string;       // 3️⃣ Path relative to storage root (includes taskRuns/<id>/)
}
```

## The Duplications

### 1. **`absolutePath` Stored 3 Times!**

```typescript
const location: FileLocation = {
  absolutePath: '/workspace/draft.tex',     // ← Here
  workspace: {
    absolutePath: '/workspace/draft.tex',   // ← Same value!
    relativePath: 'draft.tex'
  }
}
```

**Why duplicate?** The file only has ONE absolute path!

### 2. **`relativePath` Stored 3 Times!**

```typescript
const location: FileLocation = {
  relativePath: 'draft.tex',                // ← This could be workspace OR runStorage relative
  relativeScope: 'workspace',               // ← Need this to know what it means
  workspace: {
    relativePath: 'draft.tex'               // ← Duplicate of above!
  }
}
```

### 3. **Confusing "Which Relative Path?"**

The top-level `relativePath` changes meaning based on `relativeScope`:
- If `relativeScope = 'workspace'` → it's `workspace.relativePath`
- If `relativeScope = 'runStorage'` → it's `runStorage.relativePath`
- If `relativeScope = 'absolute'` → it's just `absolutePath`

**This is duplication via indirection!**

---

## Proposed Clean Structure

### Option A: Remove ALL Duplication

```typescript
export interface FileLocation {
  absolutePath: string;              // ✅ The ONE absolute path
  scope: 'workspace' | 'runStorage' | 'external';
  
  // Only store what's NOT already in absolutePath
  workspace: {
    relativePath: string;            // ✅ Only the relative part
  } | null;
  
  runStorage: {
    relativePath: string;            // ✅ Run-relative (e.g., 'r0/draft.tex')
    storageRelativePath: string;     // ✅ Storage-relative (e.g., 'taskRuns/<id>/r0/draft.tex')
  } | null;
}
```

**Remove:**
- ❌ `FileLocation.relativePath` (get from `workspace.relativePath` or `runStorage.relativePath`)
- ❌ `FileLocation.relativeScope` (use `scope` instead)
- ❌ `workspace.absolutePath` (use `FileLocation.absolutePath`)
- ❌ `runStorage.absolutePath` (use `FileLocation.absolutePath`)

---

### Option B: Keep Display Helper, Remove Sub-Object Duplication

```typescript
export interface FileLocation {
  absolutePath: string;              // ✅ The ONE absolute path
  scope: 'workspace' | 'runStorage' | 'external';
  displayPath: string;               // ✅ What to show user (workspace-relative if possible)
  
  workspace: {
    relativePath: string;            // ✅ Workspace-relative
  } | null;
  
  runStorage: {
    relativePath: string;            // ✅ Run-relative
    storageRelativePath: string;     // ✅ Storage-relative
  } | null;
}
```

**Remove:**
- ❌ `FileLocation.relativePath` (use `displayPath` instead - clearer intent)
- ❌ `FileLocation.relativeScope` (implicit from what `displayPath` is)
- ❌ `workspace.absolutePath` (use `FileLocation.absolutePath`)
- ❌ `runStorage.absolutePath` (use `FileLocation.absolutePath`)

---

## Usage Patterns - Before vs After

### Getting Absolute Path

**Before (Defensive Spaghetti):**
```typescript
// Which one?!
const abs = info.location.absolutePath;
const abs2 = info.location.workspace?.absolutePath;
const abs3 = info.location.runStorage?.absolutePath;

// People write defensive code:
const abs = info.location.absolutePath 
  ?? info.location.workspace?.absolutePath 
  ?? info.location.runStorage?.absolutePath;
```

**After (Clean):**
```typescript
// Only one place!
const abs = info.location.absolutePath;
```

### Getting Workspace-Relative Path

**Before (Confusing):**
```typescript
// Is this workspace-relative? Need to check relativeScope!
const rel = info.location.relativePath;  // Maybe?
if (info.location.relativeScope === 'workspace') {
  // Now we know
}

// Or go directly to sub-object
const rel = info.location.workspace?.relativePath;
```

**After (Clear):**
```typescript
// Always workspace-relative, or null if not in workspace
const rel = info.location.workspace?.relativePath;
```

### Getting Display Path

**Before:**
```typescript
// Which relative path to display?
const display = info.location.relativeScope === 'workspace'
  ? info.location.relativePath
  : info.location.workspace?.relativePath ?? info.location.absolutePath;
```

**After (Option B):**
```typescript
const display = info.location.displayPath;
```

---

## Migration Impact

### Code That Would Need Changes

**Direct access to duplicate fields:**
```typescript
// ❌ These would break
location.workspace.absolutePath
location.runStorage.absolutePath
location.relativePath (when relativeScope !== 'workspace')
location.relativeScope
```

**Defensive duplication checks:**
```typescript
// ❌ These patterns would need cleanup
location.absolutePath ?? location.workspace?.absolutePath
location.workspace?.relativePath ?? location.relativePath
```

### Code That Would Be Cleaner

```typescript
// ✅ Before: Confusing
const workspacePath = info.location.workspace?.absolutePath 
  ?? info.location.absolutePath;

// ✅ After: Clear
const absolutePath = info.location.absolutePath;
const isInWorkspace = info.location.workspace !== null;
```

---

## Recommendation

**Start with Option A** (remove all duplication):

1. **Remove duplicate `absolutePath` fields** from sub-objects
2. **Remove `relativePath` and `relativeScope`** from top level
3. **Keep sub-object `relativePath` fields** (they're the only non-duplicate data)

**Benefits:**
- ✅ Single source of truth for absolute path
- ✅ Clear semantics: `workspace.relativePath` is always workspace-relative
- ✅ No ambiguity about which field to use
- ✅ Smaller objects (less data to serialize/deserialize)

**Migration:**
- Update `createFileLocation()` to not set duplicate fields
- Update consumers to use `location.absolutePath` (not sub-object)
- Update consumers to use `location.workspace?.relativePath` directly

---

## Questions to Answer

1. **Do we need `relativePath` at the top level at all?**
   - It's always derivable from `workspace.relativePath` or `runStorage.relativePath`
   - If not in workspace/runStorage, should we show absolute path

2. **What's the difference between `runStorage.relativePath` and `runStorage.storageRelativePath`?**
   - `relativePath`: Relative to run directory (e.g., `r0/draft.tex`)
   - `storageRelativePath`: Relative to storage root (e.g., `taskRuns/abc123/r0/draft.tex`)
   - We need both (different use cases)

3. **Do we need `relativeScope` if we remove top-level `relativePath`?**
   - No! The scope is already in the `scope` field
   - `relativeScope` was only needed to disambiguate what `relativePath` meant

---

## Next Steps

1. Decide on Option A or B
2. Update `createFileLocation()` to not create duplicate fields
3. Update schemas to match
4. Find and fix all consumers
5. Test serialization/deserialization still works
6. Update documentation

Would you like me to implement Option A (remove all duplication)?
