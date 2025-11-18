# Tuple Return Anti-Patterns Found

## Problem

Several functions return tuples (arrays) where the order matters, making the code error-prone and hard to read.

## Anti-Patterns Identified

### 1. 🔴 CRITICAL: `extractResponse()` - Returns 3-element tuple

**Current Signature:**
```typescript
extractResponse(
  responseObject: any,
  endTag: string,
): [string, any, ProviderStopReason];
```

**Usage Pattern:**
```typescript
const [newResponse, responseUsage, stopReason] =
  options.modelHandler.extractResponse(
    state.responseObject,
    options.agentSetting.endTag,
  );
```

**Problems:**
- ❌ Order must be memorized: [response text, usage, stop reason]
- ❌ Easy to swap usage and stopReason
- ❌ Not self-documenting
- ❌ Hard to extend (adding 4th value = breaking change)

**Files Affected:**
- Interface: `src/agent/modelHandlers/types/IModelHandler.ts:119`
- Implementations: 6 model handlers
- Call sites: 
  - `src/agent/core/flows/ResponseCycleFlow.ts:326`
  - `src/agent/core/flows/ToolUseCycleFlow.ts:419`

**Proposed Fix:**
```typescript
interface ExtractResponseResult {
  response: string;
  usage: any;  // or specific usage type
  stopReason: ProviderStopReason;
}

extractResponse(
  responseObject: any,
  endTag: string,
): ExtractResponseResult;
```

**New Usage:**
```typescript
const { response: newResponse, usage: responseUsage, stopReason } =
  options.modelHandler.extractResponse(
    state.responseObject,
    options.agentSetting.endTag,
  );
```

---

### 2. 🔴 CRITICAL: `checkStopConditions()` - Returns 2 booleans

**Current Signature:**
```typescript
checkStopConditions(
  stopReason: ProviderStopReason,
  newResponse: string,
  stateRound: ConversationRoundState,
  stateGlobal: AgentRunState,
  agentSetting: AgentSetting,
): [boolean, boolean];  // ❌ Which boolean is which?
```

**Problems:**
- ❌ `[endTurn, shouldStop]` - order not obvious
- ❌ Two booleans look identical
- ❌ Very easy to swap them

**Proposed Fix:**
```typescript
interface StopConditionsResult {
  endTurn: boolean;
  shouldStop: boolean;
}

checkStopConditions(
  stopReason: ProviderStopReason,
  newResponse: string,
  stateRound: ConversationRoundState,
  stateGlobal: AgentRunState,
  agentSetting: AgentSetting,
): StopConditionsResult;
```

**New Usage:**
```typescript
const { endTurn, shouldStop } = handler.checkStopConditions(
  stopReason,
  newResponse,
  stateRound,
  stateGlobal,
  agentSetting,
);
```

---

## Lower Priority (Acceptable Tuples)

### ✅ OK: Parallel array loading

```typescript
const [customDir, builtInDir, builtInToolUseDir] = await Promise.all([
  agentDirectories.custom(),
  agentDirectories.builtIn(),
  agentDirectories.builtInToolUse(),
]);
```

**Why OK:** Clear 1:1 correspondence with Promise.all array

### ✅ OK: Related string building

```typescript
const [systemPrompt, userRequest, userPrefix] = await Promise.all([
  getSystemPromptWithRules(this.agentPrompt.systemPrompt, this.userVars),
  this.buildUserRequest(0),
  this.buildUserPrefix(),
]);
```

**Why OK:** Clear correspondence, all strings for building messages

---

## Priority Ranking

1. **HIGH**: `extractResponse()` - Used in 2 critical cycle flows, 6 implementations
2. **HIGH**: `checkStopConditions()` - Two identical-looking booleans
3. **MEDIUM**: Review other model handler methods for similar patterns

---

## Recommendation

Should we refactor these to use objects like we did with `createResponse`?

**Benefits:**
- ✅ Self-documenting
- ✅ Impossible to swap values
- ✅ Easy to extend
- ✅ Consistent with the `createResponse` refactoring we just did

**Scope:**
- 2 interface methods
- ~8 model handler implementations
- 2 call sites in flows

**Similar effort to `createResponse` refactoring we just completed.**
