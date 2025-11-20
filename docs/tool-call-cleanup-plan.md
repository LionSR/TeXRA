# Tool-call cleanup plan

This plan addresses current gaps in tool-call handling, single-source-of-truth state, and SDK-native typing. The goal is to rely on provider-native payloads, keep one canonical tool-call representation, and preserve YAML readability in progress logs.

## Issues and tasks

1. **Single source of truth for tool-call state**  
   `toolCall` and `toolCalls` still coexist in flow state; the log/follow-up paths branch on both. Consolidate to one `activeToolCall` array cursor that drives dispatch and logging.

2. **Rename the tool-call union for clarity**  
   `ProviderToolCall` still implies normalization. Rename to `SdkToolCall` (or similar) and ensure every handler/flow import uses the new name, eliminating legacy "normalized" terminology.

3. **Provider-typed tool extraction is optional**  
   Some handlers leave `extractToolUse` optional, forcing null checks. Make it required for tool-capable providers and typed against SDK responses so the cycle can assume its presence.

4. **Parallel tool calls not supported**  
   Extraction returns a single call and the cycle stores one. Extend extraction to return arrays, add a capability flag, and iterate through calls sequentially (parallel off for now) to match SDK support for multiple function calls.

5. **OpenAI chat/Responses handlers still reshape arguments**  
   They stringify or coerce `function.arguments` and synthesize IDs. Consume `ChatCompletionMessageToolCall` and `ResponseFunctionToolCallItem` verbatim, including argument payloads, and drop fallback ID/name generation.

6. **DeepSeek handler mirrors OpenAI heuristics**  
   It string-coerces IDs/names and rewraps arguments. Use the SDK tool-call type directly and pass native IDs/names/arguments through without mutation.

7. **Google GenAI handler synthesizes IDs and duplicates thinking**  
   The handler clones `FunctionCall`, generates IDs, and emits duplicate "thinking" entries. Trust SDK `FunctionCall` objects with required `id`, pass arguments through unchanged, and ensure thinking is emitted once per response.

8. **Anthropic tool-use titles omit result details**  
   Tool-result metadata is not surfaced in the progress view header for Anthropic calls. Include tool result summary (ID/name/output preview) in the title while keeping YAML rendering for detail sections.

9. **YAML formatting regressions**  
   Tool-use formatter should consistently render inputs/outputs/diagnostics via YAML for readability. Centralize YAML stringification and ensure all providers pass structured objects without pre-stringifying.

10. **Type propagation in cycle options is still `unknown`**  
    `CreateResponseOptions` and cycle state carry `unknown` response/tool types. Parameterize them with SDK response/client types so downstream nodes and logging don't cast, reinforcing the single-source-of-truth tool-call object.

11. **Model registry lacks tool-call capability/config**  
    The registry does not expose whether a provider supports parallel tool calls or requires IDs. Add explicit capability flags per model to guide extraction/dispatch logic and disable parallel calls where not yet supported.

12. **Tests still use ad-hoc payloads**  
    Several handler tests feed loose objects instead of SDK types. Update fixtures to real SDK shapes (OpenAI tool_call, Anthropic tool_use block, Google FunctionCall) and add a regression case for the `invalid_type` error observed in tool payload validation.
