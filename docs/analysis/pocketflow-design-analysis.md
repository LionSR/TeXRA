# PocketFlow Design Principles Analysis

## 1. Core PocketFlow Design Principles

### 1.1 The Node Lifecycle: `prep → exec → post`

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          NODE LIFECYCLE                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐                       │
│  │   prep   │──────│   exec   │──────│   post   │                       │
│  │  (read)  │      │(compute) │      │ (write)  │                       │
│  └──────────┘      └──────────┘      └──────────┘                       │
│       │                 │                 │                              │
│       ▼                 ▼                 ▼                              │
│  ┌──────────┐      ┌──────────┐      ┌──────────┐                       │
│  │ Extract  │      │ Pure LLM │      │ Update   │                       │
│  │ from     │      │ call or  │      │ shared & │                       │
│  │ shared   │      │ compute  │      │ return   │                       │
│  │ store    │      │ logic    │      │ action   │                       │
│  └──────────┘      └──────────┘      └──────────┘                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Principles:**

| Step | Purpose | Access | Returns |
|------|---------|--------|---------|
| `prep(shared)` | Read & preprocess data | Reads from shared | `prepRes` |
| `exec(prepRes)` | Pure compute/LLM call | **NO shared access** | `execRes` |
| `post(shared, prepRes, execRes)` | Write results & decide next | Writes to shared | `action` string |

### 1.2 Built-in Retry Mechanism

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    POCKETFLOW NODE RETRY LOOP                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│    Node._exec(prepRes)                                                   │
│    ┌──────────────────────────────────────────────────────────────────┐ │
│    │  for currentRetry = 0; currentRetry < maxRetries; currentRetry++ │ │
│    │  ┌───────────────────────────────────────────────────────────┐   │ │
│    │  │  try {                                                     │   │ │
│    │  │    return await this.exec(prepRes)  ← SUCCESS → exit loop │   │ │
│    │  │  } catch (e) {                                             │   │ │
│    │  │    if (lastAttempt || aborted)                             │   │ │
│    │  │      return execFallback(prepRes, e)  ← FALLBACK           │   │ │
│    │  │    if (wait > 0) await sleep(wait)  ← BACKOFF              │   │ │
│    │  │  }                                                         │   │ │
│    │  └───────────────────────────────────────────────────────────┘   │ │
│    └──────────────────────────────────────────────────────────────────┘ │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Retry Parameters:**
- `maxRetries`: Total attempts (default: 1 = no retry)
- `wait`: Backoff in seconds between retries (default: 0)
- `execFallback(prepRes, error)`: Override for graceful degradation

---

## 2. TeXRA's Three-Tier Retry Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    TeXRA RETRY ARCHITECTURE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ TIER 1: PocketFlow Auto-Retry (Node._exec)                             │ │
│  │ ┌────────────────────────────────────────────────────────────────────┐ │ │
│  │ │  • Transparent retry loop in framework                             │ │ │
│  │ │  • Configured via getNodeRetryConfig() from user settings          │ │ │
│  │ │  • Exponential backoff support                                     │ │ │
│  │ │  • AbortSignal detection for user cancellation                     │ │ │
│  │ └────────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              │                                               │
│                              ▼ (auto-retries exhausted)                      │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ TIER 2: Manual Retry UI (RetryWaitNode)                                │ │
│  │ ┌────────────────────────────────────────────────────────────────────┐ │ │
│  │ │  • User-facing retry dialog                                        │ │ │
│  │ │  • 5-minute timeout for user decision                              │ │ │
│  │ │  • Flow transition: AWAIT_RETRY → wait → MANUAL_RETRY or COMPLETE  │ │ │
│  │ │  • RetryRequestCoordinator for async UI coordination               │ │ │
│  │ └────────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                              │                                               │
│                              ▼ (tracks error for caller)                     │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ TIER 3: Retry State (RetryState.ts)                                    │ │
│  │ ┌────────────────────────────────────────────────────────────────────┐ │ │
│  │ │  • Error tracking (retryable/non-retryable)                        │ │ │
│  │ │  • determineFallbackAction() decides flow transition               │ │ │
│  │ │  • applyFallbackResult() logs error and updates state              │ │ │
│  │ │  • Single source of truth for error reporting                      │ │ │
│  │ └────────────────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Flow Composition Analysis

### ResponseCycleFlow Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       RESPONSE CYCLE FLOW                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────┐                                                            │
│  │ResponsePrep  │  Prepares prompts, debug context                           │
│  │    Node      │                                                            │
│  └──────┬───────┘                                                            │
│         │ default                                                            │
│         ▼                                                                    │
│  ┌──────────────┐       ┌─────────────┐                                     │
│  │  Response    │       │             │                                     │
│  │   Model      │──────▶│ RetryWait   │  AWAIT_RETRY (manual retry UI)      │
│  │ Invocation   │       │    Node     │                                     │
│  │    Node      │       └──────┬──────┘                                     │
│  │              │◀─────────────┘                                            │
│  │  (extends    │    MANUAL_RETRY                                           │
│  │   Node with  │                                                           │
│  │ auto-retry)  │                                                           │
│  └──────┬───────┘                                                            │
│         │ default                                                            │
│         ▼                                                                    │
│  ┌──────────────┐                                                            │
│  │  Response    │  Transforms response to output text                        │
│  │  Process     │                                                            │
│  │    Node      │                                                            │
│  └──────┬───────┘                                                            │
│         │ default                                                            │
│         ▼                                                                    │
│  ┌──────────────┐                                                            │
│  │  Response    │  Decides: CONTINUE (loop) or COMPLETE (end)               │
│  │ Continuation │                                                            │
│  │    Node      │                                                            │
│  └──────────────┘                                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Disharmony Analysis

### 4.1 FOUND: Manual Retry Loop Outside PocketFlow

**Location:** `src/commands/agent/agentCreatorCommands.ts:252`

```typescript
// ❌ DISHARMONY: Manual retry loop bypasses PocketFlow framework
for (let attempt = 0; attempt < 2; attempt++) {
  const params: MessageCreateParams = {
    model: ANTHROPIC_MODELS.opus41.fullName,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 2048,
  };
  const response = await anthropic.messages.create(params);
  // ... validation and retry logic
}
```

**Issue:** This command uses a manual `for` loop for retry instead of leveraging PocketFlow's `Node` class with `maxRetries`.

**Recommendation:** Refactor to use a PocketFlow Node:

```typescript
// ✅ HARMONIOUS: Use PocketFlow Node with built-in retry
class AgentYamlGeneratorNode extends Node {
  constructor() {
    super(2, 1); // maxRetries=2, wait=1s
  }

  async exec(prepRes: { prompt: string }): Promise<string> {
    const response = await anthropic.messages.create({...});
    const yaml = extractYaml(response);
    const error = validateAgentYamlString(yaml);
    if (error) throw new Error(error); // triggers retry
    return yaml;
  }

  async execFallback(prepRes: unknown, error: Error): Promise<string> {
    throw new Error('Failed to generate valid YAML after retries');
  }
}
```

### 4.2 ACCEPTABLE: Fallback Pattern (Not Retry)

**Location:** `src/latex/latexdiff/diffCommandExecutor.ts`

```typescript
// ✓ ACCEPTABLE: This is a FALLBACK pattern, not retry
// Tries with --flatten, falls back to without on specific error
async executeWithFallback(commandBuilder, commandType, cwd) {
  let result = await executeCommand(commandBuilder(true)); // with --flatten
  if (!result.success && this.isBibliographyError(result.stderr)) {
    result = await executeCommand(commandBuilder(false)); // without --flatten
  }
}
```

**Analysis:** This is a **strategy fallback**, not retry. It's trying a *different approach* on failure, which is a valid pattern outside PocketFlow's retry mechanism.

### 4.3 HARMONIOUS: Model Handler Request Executor

**Location:** `src/agent/modelHandlers/utils/requestExecutor.ts`

```typescript
// ✓ HARMONIOUS: Explicit delegation to flow level
/**
 * NOTE: Retry logic is handled at the flow level (ResponseCycleFlow/ToolUseCycleFlow).
 * This function only enriches errors with context.
 */
export async function executeRequest<T>(options, request): Promise<T> {
  // No retry here - errors propagate to PocketFlow Node._exec() retry loop
  try {
    return await request();
  } catch (error) {
    throw enrichError(error, { operation, model });
  }
}
```

---

## 5. Harmony Score Card

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POCKETFLOW HARMONY SCORECARD                          │
├────────────────────────────────────────┬─────────────────┬──────────────────┤
│ Principle                              │ Status          │ Notes            │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ prep→exec→post lifecycle               │ ✅ HARMONIOUS   │ All nodes comply │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ exec() doesn't access shared           │ ⚠️ DOCUMENTED   │ Intentional for  │
│                                        │    EXCEPTION    │ streaming*       │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ Retry via Node maxRetries/wait         │ ✅ HARMONIOUS   │ All model calls  │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ No manual retry loops                  │ ❌ DISHARMONY   │ agentCreator     │
│                                        │                 │ Commands.ts:252  │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ execFallback() for graceful degrade    │ ✅ HARMONIOUS   │ Used properly    │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ Action-based flow transitions          │ ✅ HARMONIOUS   │ FlowTransition   │
│                                        │                 │ constants        │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ Nested flow composition                │ ✅ HARMONIOUS   │ Cycle flows nest │
│                                        │                 │ in Run flows     │
├────────────────────────────────────────┼─────────────────┼──────────────────┤
│ Clone for isolation                    │ ✅ HARMONIOUS   │ Resets signal &  │
│                                        │                 │ currentRetry     │
└────────────────────────────────────────┴─────────────────┴──────────────────┘

* Documented exception: ResponseProcessNode, ResponseContinuationNode, etc.
  pass shared through prep→exec for streaming/accumulation. See ResponseCycleFlow.ts:100-103
```

---

## 6. Recommendations

### 6.1 Fix Disharmony: Refactor agentCreatorCommands.ts

Convert the manual retry loop to a proper PocketFlow Node or use the existing flow infrastructure:

```typescript
// Option A: Create a reusable YamlGeneratorNode
// Option B: Use existing retry infrastructure with determineFallbackAction()
```

### 6.2 Documentation Enhancement

Add a PocketFlow compliance checklist to AGENTS.md:

```markdown
## PocketFlow Node Checklist
- [ ] exec() only uses prepRes, not shared (or document exception)
- [ ] No try/catch in exec() (let framework handle retry)
- [ ] No manual for/while retry loops (use maxRetries parameter)
- [ ] Use execFallback() for graceful degradation
- [ ] Return action strings from post() for flow transitions
```

### 6.3 Consider: Runtime Config Validation

The current pattern of reading config at `_exec` time is an enhancement, but consider adding validation:

```typescript
async _exec(prepRes: unknown): Promise<unknown> {
  const config = getNodeRetryConfig();
  if (config.maxRetries < 1) {
    console.warn('maxRetries must be >= 1, using 1');
    config.maxRetries = 1;
  }
  this.maxRetries = config.maxRetries;
  this.wait = config.wait;
  return super._exec(prepRes);
}
```

---

## 7. Visual Summary: Complete Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      TeXRA PocketFlow ARCHITECTURE                               │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                           AGENT LAYER                                        ││
│  │  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  ││
│  │  │   Direct    │    │    CoT      │    │   Merge     │    │  Workflow   │  ││
│  │  │   Agent     │    │   Agent     │    │   Agent     │    │   Agent     │  ││
│  │  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘  ││
│  └─────────┼──────────────────┼──────────────────┼──────────────────┼──────────┘│
│            │                  │                  │                  │           │
│            ▼                  ▼                  ▼                  ▼           │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                           RUN FLOW LAYER                                     ││
│  │  ┌─────────────────────────────┐    ┌─────────────────────────────┐         ││
│  │  │      ReflectionRunFlow      │    │       ToolUseRunFlow        │         ││
│  │  │   (manages agent rounds)    │    │   (manages tool sessions)   │         ││
│  │  └──────────────┬──────────────┘    └──────────────┬──────────────┘         ││
│  └─────────────────┼──────────────────────────────────┼────────────────────────┘│
│                    │                                  │                         │
│                    ▼                                  ▼                         │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                          CYCLE FLOW LAYER                                    ││
│  │  ┌─────────────────────────────┐    ┌─────────────────────────────┐         ││
│  │  │     ResponseCycleFlow       │    │      ToolUseCycleFlow       │         ││
│  │  │                             │    │                             │         ││
│  │  │  PrepNode → InvocationNode  │    │  PrepNode → CallNode        │         ││
│  │  │          → ProcessNode      │    │          → ProcessNode      │         ││
│  │  │          → ContinuationNode │    │          → DispatchNode     │         ││
│  │  │          → RetryWaitNode    │    │          → RetryWaitNode    │         ││
│  │  └─────────────────────────────┘    └─────────────────────────────┘         ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                    │                                                            │
│                    ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────────────────┐│
│  │                       POCKETFLOW CORE LAYER                                  ││
│  │                                                                              ││
│  │    BaseNode<S, P>                     Flow<S, P>                            ││
│  │        │                                  │                                 ││
│  │        ├── Node<S, P>                     ├── BatchFlow<S, P>               ││
│  │        │   (with retry)                   │                                 ││
│  │        │   ├── BatchNode                  └── ParallelBatchFlow<S, P>       ││
│  │        │   └── ParallelBatchNode                                            ││
│  │        │                                                                    ││
│  │    ┌───┴────────────────────────────────────────────────────────────────┐   ││
│  │    │  Node._exec() RETRY LOOP                                           │   ││
│  │    │  ┌──────────────────────────────────────────────────────────────┐  │   ││
│  │    │  │  for (currentRetry = 0; currentRetry < maxRetries; ...)      │  │   ││
│  │    │  │    try { return exec(prepRes) }                              │  │   ││
│  │    │  │    catch { if (last || aborted) return execFallback(...)     │  │   ││
│  │    │  │            else await sleep(wait) }                          │  │   ││
│  │    │  └──────────────────────────────────────────────────────────────┘  │   ││
│  │    └────────────────────────────────────────────────────────────────────┘   ││
│  │                                                                              ││
│  └─────────────────────────────────────────────────────────────────────────────┘│
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘

LEGEND:
  ✅ Harmonious with PocketFlow     ⚠️ Documented Exception
  ❌ Disharmony Found               → Flow Transition
```

---

## 8. Conclusion

TeXRA's PocketFlow implementation is **largely harmonious** with core principles:

1. **Three-tier retry** elegantly separates concerns (auto → manual UI → state tracking)
2. **Framework handles retry** - model handlers correctly delegate to flow layer
3. **Clean node lifecycle** - prep/exec/post separation maintained

**One disharmony identified:**
- `agentCreatorCommands.ts:252` uses manual retry loop

**Recommended action:** Refactor the agent creator to use PocketFlow Node with `maxRetries` parameter, maintaining consistency with the rest of the codebase.
