# Model handlers — provider sub-domains

`agent/modelHandlers` is the **model-provider bounded context**: it adapts each
LLM provider's SDK to the shared `IModelHandler` port
(`src/agent/types/IModelHandler.ts`).
Provider-specific code lives in a sub-directory per provider family so the
ubiquitous language is visible in the layout; genuinely cross-provider code
stays at the root.

| Location      | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _root_        | `ModelHandler` (abstract base), `toolConversion`, `contextManagementConstants`, `modelHandlerValidation` — shared across all providers                                                                                                                                                                                                                                                                                                                          |
| `anthropic/`  | `modelHandlerAnthropic` + Anthropic-only helpers (`anthropicContextManagement`, `anthropicDocumentHandling`, `anthropicTools`)                                                                                                                                                                                                                                                                                                                                  |
| `openai/`     | `modelHandlerOpenAI`, `modelHandlerOpenAIResponse`, Responses-API collaborators (`OpenAIResponseWebSocketTransport`, `ResponseStreamProcessor`, `responseStreamEvents`, `openAIResponseContent`, `openAIResponseFileUploads`), OpenAI helpers (`openAIMessageUtils`, `openAIResponseErrors`, `ReasoningStreamAggregator`), and the OpenAI-**compatible** providers that extend `ModelHandlerOpenAI` (`modelHandlerDashScope/DeepSeek/GLM/Kimi/MiniMax/XAI`) |
| `google/`     | `modelHandlerGoogleInteractions` (Interactions API), plus Google helpers for usage, media, messages, and SDK errors.                                                                                                                                                                                                                                                                                                                                            |
| `openrouter/` | `modelHandlerOpenRouterNative`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `vscodelm/`   | `modelHandlerVscodeLm` — host-neutral adapter for subscription-backed models supplied by an editor, currently GitHub Copilot through the VS Code language-model port                                                                                                                                                                                                                                                                                            |
| `support/`    | Cross-provider runtime collaborators (stream handling, media, proxy, usage, SDK error adapters, `ServerChainState` — the server-side conversation-chain anchor shared by the OpenAI Responses and Google Interactions handlers)                                                                                                                                                                                                                                 |
| `utils/`      | Stateless cross-provider helpers (argument parsing, tool accumulation, etc.)                                                                                                                                                                                                                                                                                                                                                                                    |

## Conventions

- **One provider family per directory.** OpenAI-compatible providers stay in
  `openai/` (flat) since they subclass `ModelHandlerOpenAI` and share its
  directory; their `./modelHandlerOpenAI` import is intentional.
- **Shared, not duplicated.** Anything imported by more than one provider family
  (tool conversion, context-window constants, the base class, `support/`,
  `utils/`) lives at the root or in a shared sub-directory — never
  copied into a provider folder.
- **Import via the `@agent/modelHandlers/<provider>/<File>` alias**, e.g.
  `@agent/modelHandlers/anthropic/modelHandlerAnthropic`. There is no barrel and
  no re-export shims (per the repo's anti-shim convention).
