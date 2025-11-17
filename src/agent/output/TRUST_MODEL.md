# Trust Model for FileLocation

## 🎯 Core Principle

**FileLocation is created ONCE, correctly, by TaskRunFileService. After that, we TRUST it.**

## ✅ Legitimate "Resolve" (Create FileLocation)

These functions are at the **boundary** where we create FileLocation objects from strings:

```typescript
// TaskRunFileService - THE SOURCE OF TRUTH
class TaskRunFileService {
  metadata: {
    executionId?: ExecutionId; // ← Embedded in service
    mode: 'workspace' | 'taskRunStorage';
    runDirectory?: string;
  };

  // Creates FileLocation from relative path
  resolveRelativePath(relative: string): FileLocation {
    // Returns trusted, complete FileLocation with:
    // - absolutePath
    // - relativePath
    // - scope ('workspace' | 'runStorage' | 'external')
    // - workspace info (if in workspace)
    // - runStorage info (if in run storage, includes executionId!)
  }

  // Resolves expected output paths
  resolveExpectedPath(file: string): string {
    // Returns absolute path for validation
  }
}
```

**These are GOOD** - they create the trusted data structure.

## ❌ Unnecessary "Resolve" (Extract from FileLocation)

Once FileLocation exists, these functions are **defensive code smell**:

### Before (Defensive, Distrustful):

```typescript
// ❌ Checking if location exists before using it
function resolveInfoPath(info: OutputFileInfo): string | null {
  if (info.location?.absolutePath) {
    return info.location.absolutePath;
  }
  return null;
}

// ❌ Checking multiple places for same info
function resolveBasePath(info: OutputFileInfo): string | null {
  const location = info.lineage?.base ?? info.lineage?.original;
  if (location?.absolutePath) {
    return location.absolutePath;
  }
  if (info.location?.workspace?.absolutePath) {
    return info.location.workspace.absolutePath;
  }
  return null;
}

// ❌ Extracting executionId from multiple places
function resolveExecutionId(info: OutputFileInfo): ExecutionId | undefined {
  const candidates = [
    info.rawLocation?.runStorage?.storageRelativePath,
    info.location.runStorage?.storageRelativePath,
    info.originalLocation?.runStorage?.storageRelativePath,
    info.baseLocation?.runStorage?.storageRelativePath,
    info.prevLocation?.runStorage?.storageRelativePath,
  ];

  for (const path of candidates) {
    const id = extractFromPath(path);
    if (id) return id;
  }
  return undefined;
}
```

### After (Trusting, Clean):

```typescript
// ✅ Trust the data
function getOutputPath(info: OutputFileInfo): string {
  return info.location.absolutePath;
}

// ✅ Trust the lineage
function getBasePath(info: OutputFileInfo): string | undefined {
  return info.lineage?.base?.absolutePath;
}

// ✅ Trust the executionId from location
function getExecutionId(info: OutputFileInfo): ExecutionId | undefined {
  const storagePath = info.location.runStorage?.storageRelativePath;
  if (!storagePath) return undefined;

  // Extract once, trust it
  const segments = storagePath.split(path.sep);
  const idx = segments.indexOf('taskRuns');
  return idx !== -1 ? segments[idx + 1] : undefined;
}
```

## 🔥 Anti-Patterns to Eliminate

### 1. Optional Chaining Paranoia

```typescript
// ❌ BEFORE: Defensive
if (info.location?.absolutePath) {
  const path = info.location.absolutePath;
}

// ✅ AFTER: Trust (location always exists on OutputFileInfo)
const path = info.location.absolutePath;
```

### 2. Multi-Way Fallback Chains

```typescript
// ❌ BEFORE: Checking 5 places!
const workspacePath =
  info.rawLocation?.workspace?.absolutePath ??
  info.workspacePath ??
  info.location.workspace?.absolutePath ??
  info.original ??
  (path.isAbsolute(info.path) ? info.path : undefined);

// ✅ AFTER: One place
const workspacePath = info.location.workspace?.absolutePath;
```

### 3. Re-Normalization

```typescript
// ❌ BEFORE: Normalizing already-normalized data
function normalizeOutputInfo(info: OutputFileInfo): NormalizedInfo {
  const path = info.path || info.location?.absolutePath || '';
  const relative = info.relativePath || info.location?.relativePath || path;
  // ... more normalization
}

// ✅ AFTER: Trust the structure
function getDisplayInfo(info: OutputFileInfo): DisplayInfo {
  return {
    label: info.source,
    path: info.location.relativePath,
  };
}
```

### 4. ExecutionId Re-Extraction

```typescript
// ❌ BEFORE: Extracting from multiple sources, normalizing, validating
function resolveExecutionIdFromInfo(
  info: OutputFileInfo,
): ExecutionId | undefined {
  // Check rawLocation
  const raw = extractFromPath(
    info.rawLocation?.runStorage?.storageRelativePath,
  );
  if (raw) return normalizeExecutionId(raw);

  // Check location
  const loc = extractFromPath(info.location.runStorage?.storageRelativePath);
  if (loc) return normalizeExecutionId(loc);

  // Check originalLocation
  // ... and so on
}

// ✅ AFTER: Trust TaskRunFileService metadata
class TaskRunFileService {
  getExecutionId(): ExecutionId | undefined {
    return this.metadata.executionId; // ← Already normalized, already correct
  }
}

// Or extract once from location
function getExecutionId(location: FileLocation): ExecutionId | undefined {
  return location.runStorage?.storageRelativePath.split('/')[1];
}
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│ TaskRunFileService                                      │
│ - executionId in metadata                               │
│ - Creates FileLocation objects                          │
│ - Single source of truth                                │
└────────────────┬────────────────────────────────────────┘
                 │ resolveRelativePath()
                 │
                 ▼
         ┌──────────────┐
         │ FileLocation │ ← TRUSTED, COMPLETE, IMMUTABLE
         │ - absolutePath
         │ - relativePath
         │ - scope
         │ - workspace info
         │ - runStorage info (with executionId!)
         └──────┬───────┘
                │
                │ Used everywhere
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
OutputHandler  WebView  Commands
 (trust it)  (trust it) (trust it)
```

## 📋 Refactoring Checklist

### Files to Clean Up:

- [ ] `src/commands/latex/latexdiffCommands.ts`
  - Remove: `resolveInfoPath`, `resolveBasePath`
  - Replace with: `getOutputPath`, `getBasePath`

- [ ] `src/progressView/ProgressViewMessageHandler.ts`
  - Remove: `resolveExecutionIdFromInfo` (check 5 fields)
  - Remove: `findPreferredOutputDirectory` (check 5+ fields)
  - Replace with: Simple field access

- [ ] `src/progressView/managers/OutputFilesManager.ts`
  - Simplify: `collectWorkspacePaths` (checks location twice)
  - Simplify: `getRunByExecution` (extracts ID from paths)

- [ ] `src/agent/output/OutputHandler.ts`
  - Keep: `resolveRelativePath` calls (these CREATE FileLocation)
  - Remove: Any defensive checks AFTER FileLocation created

### Pattern to Follow:

1. **At boundaries**: Use `TaskRunFileService.resolveRelativePath()` to CREATE FileLocation
2. **Everywhere else**: TRUST the FileLocation, access fields directly
3. **ExecutionId**: Get from `TaskRunFileService.metadata.executionId` or extract ONCE from location
4. **No fallbacks**: If `location.workspace` is undefined, the file isn't in workspace. Period.

## 🎁 Benefits

1. **No defensive code** - Trust construction, not runtime
2. **No normalization** - Data created correctly once
3. **No extraction** - ExecutionId is embedded, not computed
4. **No fallbacks** - One source of truth, not five
5. **Type safety** - FileLocation structure enforced by Zod
6. **Performance** - No repeated parsing/validation
7. **Simplicity** - Code reads like the data flow it represents
