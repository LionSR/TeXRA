# Function Signature Analysis Report

Analysis of function signatures in the TeXRA codebase to identify opportunities for schema-based parameter handling.

## Executive Summary

| Category                    | Functions Found | Key Finding                                        |
| --------------------------- | --------------- | -------------------------------------------------- |
| Long Signatures (4+ params) | 20              | Boolean flags, parameters always passed together   |
| Manual Default Handling     | 18              | 32+ lines of boilerplate `??` chains               |
| Pseudo-Overloads            | 22              | `typeof`/`Array.isArray` dispatch patterns         |
| Repeated Parameters         | 15 patterns     | Logger+Channel (45 occurrences), ExecutionIDs (20) |

---

## Top 10 Functions for Schema-Based Refactoring

### 1. `resolveToolDefinitions` (CRITICAL)

**File:** `src/tools/registry.ts:128`

**Current Issues:**

- Union parameter with typeof dispatch
- Core tool system - affects all tool registrations

**Current:**

```typescript
export function resolveToolDefinitions(
  tools: RawToolConfig[], // Array of unions
  warnOnMissing?: (toolName: string) => void,
): ToolDefinition[] {
  return tools.map((item): ToolDefinition => {
    const name = typeof item === 'string' ? item : item.name;
    if (typeof item === 'string') {
      return { name };
    }
    return ToolDefinitionSchema.catch({ name }).parse(item);
  });
}
```

**Proposed:**

```typescript
const RawToolConfigSchema = z.union([z.string(), ToolDefinitionSchema]);

const ResolveToolsOptionsSchema = z.object({
  tools: z.array(RawToolConfigSchema),
  warnOnMissing: z.function().optional(),
});

export function resolveToolDefinitions(
  options: z.infer<typeof ResolveToolsOptionsSchema>,
): ToolDefinition[] {
  // Schema handles type narrowing
}
```

---

### 2. `executeCommand` (CRITICAL)

**File:** `src/utils/system/execUtils.ts:71`

**Current Issues:**

- 4+ lines of defaults at function start
- Encoding transform logic inline

**Current:**

```typescript
async function executeCommand(
  command: string | string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const workspacePath = options.cwd ?? WorkspaceFS.getPath();
  const logChannel = options.channel ?? CHANNEL;
  const shouldTruncate = options.truncate ?? false;
  const encodingOption: ExecaEncodingOption =
    options.encoding && options.encoding.toLowerCase() === 'utf-8'
      ? 'utf8'
      : ((options.encoding ?? 'utf8') as ExecaEncodingOption);
  // ...
}
```

**Proposed:**

```typescript
const ExecOptionsSchema = z.object({
  cwd: z.string().optional(),
  channel: z.string().default(CHANNEL),
  truncate: z.boolean().default(false),
  encoding: z
    .enum(['utf8', 'utf-8'])
    .transform((e) => (e === 'utf-8' ? 'utf8' : e))
    .default('utf8'),
  timeout: z.number().optional(),
  env: z.record(z.string()).optional(),
  stdin: z.string().optional(),
});
```

---

### 3. `prepareFilters` (HIGH)

**File:** `src/frontend/files/listing.ts:126`

**Current Issues:**

- 5 lines of nullish coalescing defaults

**Current:**

```typescript
function prepareFilters(
  patternRoot: string,
  options: ListingOptions,
): NormalizedListingOptions {
  const includeExtensions = options.includeExtensions ?? [];
  const excludeExtensions = options.excludeExtensions ?? [];
  const excludeDirectories = options.excludeDirectories ?? [];
  const excludeKeywords = options.excludeKeywords ?? [];
  const excludeFiles = options.excludeFiles ?? [];
  // ...
}
```

**Proposed:**

```typescript
const ListingOptionsSchema = z.object({
  includeExtensions: z.array(z.string()).default([]),
  excludeExtensions: z.array(z.string()).default([]),
  excludeDirectories: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  excludeFiles: z.array(z.string()).default([]),
});
```

---

### 4. `emitClearMissingOutputs` (HIGH)

**File:** `src/commands/housekeeping/streamEventUtils.ts:8`

**Current Issues:**

- 5 positional parameters
- First 3 always passed together (stream identifier)
- Boolean flag without semantic clarity

**Current:**

```typescript
export function emitClearMissingOutputs(
  agent: string,
  model: string,
  inputFile: string,
  useMultipleOutputs: boolean,
  streamId?: string,
): void;
```

**Proposed:**

```typescript
const ClearMissingOutputsParamsSchema = z.object({
  streamConfig: z.object({
    agent: z.string(),
    model: z.string(),
    inputFile: z.string(),
  }),
  options: z.object({
    useMultipleOutputs: z.boolean(),
    streamIdOverride: z.string().optional(),
  }),
});
```

---

### 5. `applyReplacements` (HIGH)

**File:** `src/replacement/engine.ts:252`

**Current Issues:**

- Union parameter with Array.isArray dispatch
- Core text replacement engine

**Current:**

```typescript
export function applyReplacements(
  text: string,
  replacements: ReplacementCategory | ReplacementCategory[],
  options?: { processMathUnicode?: boolean },
): string {
  const replacementArray = Array.isArray(replacements)
    ? replacements
    : [replacements];
  // ...
}
```

**Proposed:**

```typescript
const ApplyReplacementsOptionsSchema = z.object({
  text: z.string(),
  replacements: z.array(ReplacementCategorySchema), // Always array
  processMathUnicode: z.boolean().optional(),
});
```

---

### 6. `formatToolUse` / `formatWebSearch` (HIGH)

**File:** `src/progressView/modules/formatters/logFormatters/toolFormatters.js:79,183`

**Current Issues:**

- 4 parameters always passed together
- logId, groupId, timestamp form a context tuple

**Current:**

```javascript
export function formatToolUse(normalizedPayload, logId, groupId, timestamp)
export function formatWebSearch(normalizedPayload, logId, groupId, timestamp)
```

**Proposed:**

```typescript
const FormatterContextSchema = z.object({
  logId: z.string(),
  groupId: z.string(),
  timestamp: z.string(),
});

const FormatToolUseParamsSchema = z.object({
  normalizedPayload: z.object({ structured: z.unknown() }).optional(),
  context: FormatterContextSchema,
});
```

---

### 7. `compileLatex2Pdf` (MEDIUM)

**File:** `src/latex/texTools.ts:24`

**Current Issues:**

- 4 parameters with multiple defaults
- Boolean `useLatexmk` lacks semantic clarity

**Current:**

```typescript
export async function compileLatex2Pdf(
  latexLocation: FileLocation,
  channel: string = CHANNEL,
  outputDirectory?: string,
  useLatexmk: boolean = false,
): Promise<boolean>;
```

**Proposed:**

```typescript
const CompileLatex2PdfOptionsSchema = z.object({
  latexLocation: FileLocationSchema,
  options: z.object({
    channel: z.string().optional(),
    outputDirectory: z.string().optional(),
    compiler: z.enum(['pdflatex', 'latexmk']).default('pdflatex'),
  }),
});
```

---

### 8. `createStream` (HIGH)

**File:** `src/logger/AgentLogger.ts:612`

**Current Issues:**

- 3 defaults at function start
- High-use logging method

**Current:**

```typescript
createStream(type: MessageType, options: AgentLogStreamOptions = {}): AgentLogStream {
  const level = options.level ?? 'info';
  const progressEnabled = options.progressViewEnabled ?? true;
  const groupId = options.groupId ?? this.resolveActiveGroupId();
  // ...
}
```

**Proposed:**

```typescript
const AgentLogStreamOptionsSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  progressViewEnabled: z.boolean().default(true),
  groupId: z.string().optional(),
});
```

---

### 9. `handlePackLatexdiffvc` (MEDIUM)

**File:** `src/commands/latex/latexdiffCommands.ts:255`

**Current Issues:**

- 4 parameters with boolean flag
- Confusing clean mode semantics

**Current:**

```typescript
async function handlePackLatexdiffvc(
  inputFile: string,
  baseFile: string,
  commitHash: string,
  clean: boolean,
);
```

**Proposed:**

```typescript
const PackLatexdiffVcOptionsSchema = z.object({
  files: z.object({
    inputFile: z.string(),
    baseFile: z.string(),
  }),
  commitHash: z.string(),
  mode: z.enum(['pack', 'clean']).default('pack'),
});
```

---

### 10. `ArxivSearchTool.execute` (MEDIUM)

**File:** `src/tools/arxiv/ArxivSearchTool.ts:59`

**Current Issues:**

- 4 defaults scattered through function body
- Repeated default application

**Current:**

```typescript
protected async execute(input: ArxivSearchInput) {
  const searchField = input.field ?? 'all';
  // ...
  let client = createArxivClient()
    .query(query)
    .start(input.start ?? 0)
    .maxResults(input.maxResults ?? ARXIV_CONSTANTS.DEFAULT_RESULTS);
}
```

**Proposed:**

```typescript
const ArxivSearchInputSchema = z.object({
  query: z.string().min(1),
  field: z.enum(['author', 'title', 'abstract', 'all']).default('all'),
  start: z.number().int().min(0).default(0),
  maxResults: z.number().int().min(1).default(ARXIV_CONSTANTS.DEFAULT_RESULTS),
  categories: z.array(z.string()).optional(),
});
```

---

## Proposed Shared Schemas

These base schemas would eliminate duplication across many functions:

### LoggerContext (45 occurrences)

```typescript
export const LoggerContextSchema = z.object({
  logger: z.instanceof(AgentLogger),
  channel: z.string(),
});
```

### ExecutionContext (20 occurrences)

```typescript
export const ExecutionContextSchema = z.object({
  streamId: z.string().brand<'StreamTabId'>(),
  executionId: z.string().brand<'ExecutionId'>(),
});
```

### GuardContext (15 functions)

```typescript
export const GuardContextSchema = z.object({
  channel: z.string(),
  action: z.string(),
  saveDocument: z.boolean().optional(),
});
```

### FormatterContext (formatter functions)

```typescript
export const FormatterContextSchema = z.object({
  logId: z.string(),
  groupId: z.string(),
  timestamp: z.string(),
});
```

---

## Implementation Priority

### Phase 1 - Foundation (Highest Impact)

1. Create `LoggerContextSchema` - eliminates 45 parameter pairs
2. Create `ExecutionContextSchema` - eliminates 20 parameter pairs
3. Refactor `executeCommand` - heavily used utility

### Phase 2 - Core Functions

4. `resolveToolDefinitions` - affects entire tool system
5. `prepareFilters` - file listing foundation
6. `applyReplacements` - replacement engine

### Phase 3 - Command Layer

7. `emitClearMissingOutputs` - stream management
8. `formatToolUse`/`formatWebSearch` - formatter pattern
9. `createStream` - logging infrastructure

### Phase 4 - Domain-Specific

10. `compileLatex2Pdf`, `handlePackLatexdiffvc`, `ArxivSearchTool.execute`

---

## Detailed Findings by Category

### Long Signatures (20 functions)

- `emitClearMissingOutputs` - 5 params
- `handlePackLatexdiffvc` - 4 params with boolean
- `compileLatex2Pdf` - 4 params with defaults
- `formatToolUse` / `formatWebSearch` - 4 params each
- `mapHttpError` - 5 params representing context groups
- `handleCleanSingle` / `handleCleanMultiple` - 3-4 params
- `runPackLatexdiffvc` / `runPackLatexdiffvcMultiple` - 3 params with boolean

### Default Dance (18 functions, 32+ lines)

- `prepareFilters` - 5 defaults
- `executeCommand` - 4+ defaults
- `ArxivSearchTool.execute` - 4 defaults
- `buildStreamInfo` - 3 chained `??` operators
- `createStream` - 3 defaults
- `selectFiles` - 2 defaults

### Pseudo-Overloads (22 functions)

- `typeof` dispatch: 11 functions
- `Array.isArray` dispatch: 12 functions
- `instanceof` dispatch: 5 functions
- `'in'` operator: 4 functions

### Repeated Parameter Patterns (15 patterns)

- Logger + Channel: 45 occurrences
- ExecutionIDs (streamId + executionId): 20 occurrences
- Guard Options: 15 functions
- Error + Context: 8 functions
- Processing Context: 5 constructors
