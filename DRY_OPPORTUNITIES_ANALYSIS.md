# DRY Opportunities Analysis: Cycle Flows

## Overview

Deep analysis of code duplication between `ToolUseCycleFlow.ts` and `ResponseCycleFlow.ts`.

## Current Shared Abstractions ✅

Already extracted to `CommonCycleTypes.ts`:
- ✅ `BaseCycleState` interface
- ✅ `CycleDebugContext` interface  
- ✅ `CycleDebugFileOptions` interface
- ✅ `SkippableNodeResult<T>` type
- ✅ `resetCycleState()` function

## Duplication Analysis

### 1. 🟡 Debug Context Creation (BORDERLINE)

**ToolUseCycle** (appears 2x):
```typescript
const debugContext: CycleDebugContext = {
  logger: options.logger,
  modelName: options.modelName,
  executionId: options.context.executionId,
};
```

**ResponseCycle**:
```typescript
const debugContext: CycleDebugContext = {
  logger,
  modelName: agentConfig.model,
  executionId: options.context.executionId,
};
```

**Differences**:
- ToolUseCycle: uses `options.logger` and `options.modelName`
- ResponseCycle: uses destructured `logger` and `agentConfig.model`

**Recommendation**: 
- **Leave as-is** - The differences in option structure mean we'd need to pass 3 parameters to extract this
- Only 3 lines each time
- **Cost of abstraction > benefit**

### 2. 🟢 Abort Controller Pattern (GOOD CANDIDATE)

**ToolUseCycle**:
```typescript
const abortController = new AbortController();
options.setAbortController(abortController);

let response: unknown;
const start = Date.now();
try {
  options.modelHandler.setOutputStreaming(true);
  response = await options.modelHandler.createResponse(
    options.client,
    state.messages,
    options.agentSetting.temperature ?? 0,
    undefined,
    undefined,
    abortController.signal,
    options.agentSetting.tools as ToolDefinition[] | undefined,
  );
} finally {
  options.setAbortController(null);
}
const responseTime = (Date.now() - start) / 1000;
```

**ResponseCycle**:
```typescript
const abortController = new AbortController();
options.setAbortController(abortController);
options.modelHandler.setOutputStreaming(false);

const stage = await options.logger.stage('Model invocation', {
  skip: true,
});

try {
  const { response, responseTime } = await stage.run(async () => {
    const invocation = await options.modelHandler.createResponse(
      options.client,
      state.messages,
      options.agentSetting.temperature || 0.0,
      state.systemPrompt,
      options.agentSetting.endTag,
      abortController.signal,
      options.modelHandler.capabilities.supportsFunctionCalling
        ? options.agentSetting.tools
        : undefined,
    );

    const elapsed = state.startTime
      ? (Date.now() - state.startTime) / 1000
      : undefined;

    return { response: invocation, responseTime: elapsed };
  });

  return { skipped: false, value: { response, responseTime } };
} catch (error) {
  const formattedError = formatProviderHttpError(error);
  const message = `Model invocation failed: ${formattedError.message}`;
  options.logger.error(
    message,
    undefined,
    MESSAGE_TYPES.PROGRESS_STATUS,
    formattedError,
  );
  state.shouldStop = true;
  state.endTurn = false;
  throw error;
} finally {
  options.setAbortController(null);
}
```

**Common Pattern**:
- Create abort controller
- Set it in options
- Execute model call
- Clear it in finally

**Differences**:
- ResponseCycle has comprehensive error handling and logging
- Different streaming settings
- Different parameters to `createResponse`
- ResponseCycle wraps in logger.stage

**Recommendation**:
- **Extract abort controller lifecycle** to a helper:
  ```typescript
  export async function withAbortController<T>(
    options: { setAbortController: (controller: AbortController | null) => void },
    callback: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abortController = new AbortController();
    options.setAbortController(abortController);
    try {
      return await callback(abortController.signal);
    } finally {
      options.setAbortController(null);
    }
  }
  ```

### 3. 🟢 Model Response Timing (GOOD CANDIDATE)

**Pattern**: Both measure response time with `Date.now()`

**ToolUseCycle**:
```typescript
const start = Date.now();
try {
  // ... model call
} finally {
  // ...
}
const responseTime = (Date.now() - start) / 1000;
```

**ResponseCycle**:
```typescript
state.startTime = Date.now();
// ... later
const elapsed = state.startTime
  ? (Date.now() - state.startTime) / 1000
  : undefined;
```

**Recommendation**:
- **Extract timing utility**:
  ```typescript
  export function measureDuration<T>(
    callback: () => Promise<T>
  ): Promise<{ result: T; durationSeconds: number }> {
    const start = Date.now();
    return callback().then(result => ({
      result,
      durationSeconds: (Date.now() - start) / 1000
    }));
  }
  ```

### 4. 🔴 Debug Object Saving (NO - ALREADY DRY)

Both use `maybeSaveDebugObject` helper - **already DRY** ✅

### 5. 🟡 Interruption Check Pattern (BORDERLINE)

**Both**:
```typescript
const interrupted = Boolean(await options.checkInterruption());
if (prepRes.interrupted) {
  state.shouldStop = true;
  return FlowTransition.COMPLETE;
}
```

**Recommendation**: 
- **Leave as-is** - Only 2 lines, very simple
- No complex logic to extract

### 6. 🟢 Usage Provider Resolution (GOOD CANDIDATE - ALREADY DRY?)

**Both use**: `resolveUsageProvider(options.modelHandler)`

**Check if already extracted**: Yes! It's in `UsageProviderUtils.ts` ✅

### 7. 🟡 Error State Setting Pattern (BORDERLINE)

**Common pattern**:
```typescript
state.shouldStop = true;
// ... sometimes with other state updates
return FlowTransition.COMPLETE;
```

**Recommendation**: 
- **Leave as-is** - Context-specific (sometimes sets endTurn, sometimes not)
- Too simple to warrant extraction

## Summary: Actionable DRY Opportunities

### ✅ Worth Extracting

1. **Abort Controller Lifecycle** → `CommonCycleUtils.ts`
   - ~10 lines duplicated
   - Clear separation of concerns
   - Eliminates try/finally boilerplate

2. **Response Timing Measurement** → `CommonCycleUtils.ts`
   - Used in multiple places
   - Consistent pattern worth abstracting

### ❌ Not Worth Extracting

1. **Debug Context Creation** - too context-specific, only 3 lines
2. **Interruption Check** - only 2 lines, very simple
3. **Error State Setting** - context-specific logic
4. **Debug Object Saving** - already using helper function ✅
5. **Usage Provider Resolution** - already extracted ✅

## Recommended Implementation

### Create: `src/agent/core/flows/CommonCycleUtils.ts`

```typescript
import type { AgentCycleBaseOptions } from '@agent/core/AgentCycleOptions';

/**
 * Executes a callback with an abort controller lifecycle.
 * Ensures the controller is properly cleaned up in all cases.
 * 
 * @param options - Options object with setAbortController method
 * @param callback - Async callback receiving the abort signal
 * @returns Result of the callback
 */
export async function withAbortController<T, C>(
  options: AgentCycleBaseOptions<C>,
  callback: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  options.setAbortController(abortController);
  try {
    return await callback(abortController.signal);
  } finally {
    options.setAbortController(null);
  }
}

/**
 * Measures the duration of an async operation in seconds.
 * 
 * @param callback - Async operation to measure
 * @returns Object with result and duration
 */
export async function measureDuration<T>(
  callback: () => Promise<T>,
): Promise<{ result: T; durationSeconds: number }> {
  const start = Date.now();
  const result = await callback();
  return {
    result,
    durationSeconds: (Date.now() - start) / 1000,
  };
}
```

### Usage Example

**Before** (ToolUseCycle):
```typescript
const abortController = new AbortController();
options.setAbortController(abortController);

let response: unknown;
const start = Date.now();
try {
  options.modelHandler.setOutputStreaming(true);
  response = await options.modelHandler.createResponse(
    options.client,
    state.messages,
    options.agentSetting.temperature ?? 0,
    undefined,
    undefined,
    abortController.signal,
    options.agentSetting.tools as ToolDefinition[] | undefined,
  );
} finally {
  options.setAbortController(null);
}
const responseTime = (Date.now() - start) / 1000;
```

**After**:
```typescript
const { result: response, durationSeconds: responseTime } = 
  await measureDuration(() => 
    withAbortController(options, (signal) => {
      options.modelHandler.setOutputStreaming(true);
      return options.modelHandler.createResponse(
        options.client,
        state.messages,
        options.agentSetting.temperature ?? 0,
        undefined,
        undefined,
        signal,
        options.agentSetting.tools as ToolDefinition[] | undefined,
      );
    })
  );
```

**Impact**: 
- Reduces ~13 lines to ~12 lines (marginal line savings)
- **Main benefit**: Eliminates manual abort controller cleanup boilerplate
- Makes error handling automatic
- More declarative code

## Verdict

**Current DRY Status**: 🟢 **Already Pretty Good**

- Common types already extracted ✅
- Most "duplication" is actually intentional variation
- Only 2 helpers worth adding

**Recommended Action**:
1. Extract `withAbortController` and `measureDuration` to `CommonCycleUtils.ts`
2. Update both flows to use these helpers
3. Everything else is fine as-is

**Expected Benefit**: 
- Modest (~5% reduction in boilerplate)
- Better error handling guarantees
- Slightly more maintainable abort controller lifecycle

**Is it worth it?** 
- ✅ Yes, but **low priority**
- The flows are already well-factored
- This is polish, not critical refactoring
