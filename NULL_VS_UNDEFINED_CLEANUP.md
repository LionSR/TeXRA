# Null vs Undefined Consistency Cleanup

## Decision: Use `null` Everywhere ✅

**Rationale:**

- `null` is explicit ("intentionally empty")
- `undefined` is ambiguous ("not set yet" vs "doesn't exist")
- JSON serialization drops `undefined`, keeps `null`
- Workspace state persistence requires consistent serialization
- Optional chaining `?.` handles both, so checking code doesn't need to change

---

## Changes Made

### 1. Schemas: Changed `.nullish()` → `.nullable()`

**Before:**

```typescript
workspace: WorkspaceLocationSchema.nullish(); // Allows null | undefined
runStorage: RunStorageLocationSchema.nullish();
lineage: FileLineageSchema.nullish();
diff: DiffStatsSchema.nullish();
```

**After:**

```typescript
workspace: WorkspaceLocationSchema.nullable(); // Only allows null
runStorage: RunStorageLocationSchema.nullable();
lineage: FileLineageSchema.nullable();
diff: DiffStatsSchema.nullable();
```

**Files changed:**

- `src/agent/output/types.ts` - All schemas now use `.nullable()`

---

### 2. Interface: Removed Optional Fields `?:`

**Before:**

```typescript
export interface FileLocation {
  workspace?: WorkspaceLocationInfo | null; // Could be missing OR null
  runStorage?: RunStorageLocationInfo | null;
}
```

**After:**

```typescript
export interface FileLocation {
  workspace: WorkspaceLocationInfo | null; // Explicit null, always present
  runStorage: RunStorageLocationInfo | null;
}
```

**Why this matters:**

- `?:` allows three states: present, missing (undefined), or null
- `: T | null` allows two states: present or null
- Simpler mental model, clearer intent

**Files changed:**

- `src/utils/files/taskRunStorage.ts` - Removed `?` from workspace and runStorage fields

---

### 3. Code: Changed `undefined` → `null`

**Before:**

```typescript
lineage: undefined,
diff: undefined,
```

**After:**

```typescript
lineage: null,
diff: null,
```

**Files changed:**

- `src/agent/output/OutputHandler.ts`
- `src/test/output/LatexDiffManager.test.ts`

---

### 4. Removed Defensive Helper Methods

These methods were re-extracting data from multiple sources and normalizing:

**Removed:**

- `resolveExecutionIdFromInfo()` - Extracted executionId from 5 different path sources
- `findPreferredOutputDirectory()` - Checked 5+ fields to find a directory

**Replaced with:**

- Inline logic that trusts `info.location.runStorage?.storageRelativePath`
- Direct field access to `info.location.runStorage?.absolutePath`

**Impact:**

- ~50 lines of defensive code removed
- Single source of truth (FileLocation) trusted
- Cleaner, more maintainable code

**Files changed:**

- `src/progressView/ProgressViewMessageHandler.ts`

---

## Workspace State Persistence ✅

**Question:** Do we need migration for old persisted data?

**Answer:** No migration needed!

**Why:**

- `OutputFilesManager` uses `OutputFileInfoListSchema.parse()` to validate persisted data
- Zod's `.nullable()` accepts both `null` and `undefined` during **parsing**
- During **runtime/creation**, we enforce `null` only
- Old data with `undefined` will be normalized to `null` automatically on load
- JSON serialization naturally drops `undefined`, so all new saves use `null`

**Migration Path:**

1. Old persisted data loads (may have undefined fields)
2. Zod schema parses and normalizes to null
3. Next save writes only null (no undefined)
4. Gradual migration without breaking changes

---

## Consistency Rules Going Forward

### ✅ DO:

```typescript
// Use null for "intentionally empty"
const file: OutputFileInfo = {
  source: 'file.tex',
  location: {...},
  lineage: null,  // No lineage
  diff: null,     // No diff stats
};

// Use .nullable() in schemas
const MySchema = z.object({
  field: SomeSchema.nullable(),
});

// Remove ? from interface fields when they should always be present
interface MyType {
  field: string | null;  // Always present, might be null
}
```

### ❌ DON'T:

```typescript
// Don't use undefined
lineage: undefined; // ❌

// Don't use .nullish()
field: SomeSchema.nullish(); // ❌

// Don't use optional fields for things that should always be present
interface MyType {
  field?: string | null; // ❌ Three states is confusing
}
```

---

## Impact Summary

**Lines of code removed:** ~60 (defensive methods, unnecessary optional markers)  
**Schemas updated:** 6  
**Interfaces updated:** 1  
**Type complexity reduced:** Eliminated ambiguous three-state optionals  
**Compilation:** ✅ Passing  
**Linting:** ✅ Passing  
**Migration needed:** ❌ No (automatic via Zod)

---

## Benefits

1. **Clearer Intent**: `null` explicitly means "no value", not "maybe forgot to set"
2. **Simpler Types**: Two states (value | null) instead of three (value | null | undefined)
3. **Better Serialization**: JSON round-trips correctly
4. **Fewer Bugs**: Can't accidentally forget to set a field (TypeScript enforces presence)
5. **Trust Model**: Code can trust that fields exist, even if value is null

---

## Example: Before vs After

### Before (Inconsistent):

```typescript
// Schema allows both
workspace: WorkspaceLocationSchema.nullish()

// Interface allows three states
workspace?: WorkspaceLocationInfo | null;

// Code creates undefined
const info = { location: { workspace: undefined } };

// Checking code must handle all three
if (info.location.workspace !== null &&
    info.location.workspace !== undefined) {
  // use it
}
```

### After (Consistent):

```typescript
// Schema allows only null
workspace: WorkspaceLocationSchema.nullable();

// Interface enforces presence
workspace: WorkspaceLocationInfo | null;

// Code creates null
const info = { location: { workspace: null } };

// Checking code is simple
if (info.location.workspace) {
  // use it
}
```

Much cleaner! 🎯
