# What TeXRA could do with GitHub Copilot

Status: parked (owner, 2026-10-26: Copilot support removed in #14296; reopen only by owner decision)

## Why this note exists

The owner removed every Copilot path on 2026-10-26, in the same way #14285
removed OpenRouter: "all these copilot routes actually only adding complexity
we should remove". It was a hard product decision, not a verdict that Copilot
has no value. Some users already pay for a Copilot subscription, and VS Code
is one of TeXRA's three hosts. This note records what the integration did,
what it cost, and the shapes a future integration could take, so that
reopening the question starts from facts instead of from memory.

## What was removed

Every main commit before the removal (#14296) holds the code, for example
`33895b7daa`. Read any file with `git show 33895b7daa:<path>`.

- **Copilot as a model route.** A user could serve a canonical model, such as
  a Claude or GPT model, through the editor's Copilot access instead of a
  provider key or a subscription.
  - `packages/harness/src/model/copilotRouting.ts` (`CopilotRoutes`) held the
    per-model preference, stored as `texra.copilotRouteModels`. It also
    discovered which models the editor offered at each route decision.
  - The route was never stored. The editor was its authority.
  - `packages/llm` carried a `vscode-lm` protocol: an "editor" binding,
    content and controls, plus an `editor` arm on the turn and origin schemas.
- **The editor language-model port.**
  - `packages/harness/src/platform/languageModel.ts` defined the port.
  - `packages/extension/src/frontend/lm/createLanguageModelPort.ts` and
    `acquireVscodeLanguageModel.ts` implemented it over `vscode.lm`.
  - Every other host passed an "unavailable" port.
  - A service process reached the window's models through host calls on the
    service protocol (`lmModels`, `lmPrepare`, `lmStream`, `cancel`).
- **TeXRA tools inside Copilot Chat.**
  - `registerLanguageModelTools.ts` registered `texra_arxiv_search` and
    `texra_web_fetch` with `vscode.lm.registerTool`.
  - The extension's `languageModelTools` manifest contribution declared them,
    so Copilot Chat and agent mode could call them (`#texra_arxiv_search`).
  - The tools were read-only and needed no run.
  - They lived in the `copilot` plugin, behind its own on/off switch.
- **The quota fallback.** When a Copilot request ran out of quota, the run
  could retry on the user's own key: the `copilot-fallback` credential switch
  and the `ownKeyFallback` launch option.
- **Settings UI.** The "Copilot in VS Code" section offered Grant access and
  Use Copilot, and models served this way showed a "Via Copilot" badge.

## What it cost

- **One host only.** Only the VS Code extension could serve the route. The
  desktop app and the CLI carried the port, its fakes and its layer wiring for
  nothing.
- **A second transport inside `packages/llm`.** The editor protocol had its
  own turn shape and error evidence, beside the HTTP providers. Every change
  to turns or origins had to handle both.
- **The window–service protocol carried editor calls.** A service process had
  no editor of its own, so model streaming crossed the RPC edge, with its own
  cancellation and versioning.
- **Discovery at every route decision.** Which models Copilot offers changes
  as the user signs in, upgrades or hits a quota. Routing had to ask the
  editor each time and could not store the answer.
- **The editor API is narrow.**
  - There is no system role; TeXRA encoded the system prompt as the first
    user message.
  - There is no per-request reasoning-effort control.
  - Tool-call arguments arrive already parsed, without the provider's raw
    bytes.
  - Access needs the user's consent through a prompt with a justification,
    and asking for consent is only allowed after a direct user action.
- **Persisted shapes.** Three row kinds carried Copilot values. Removing them
  cost a version bump each (`run.config`, `model.message` and `context.edit`).

## What is possible

These options are ordered from the most general and cheapest to the most
editor-specific and costly. Check current VS Code API documentation and
GitHub's Copilot terms before relying on any of them.

1. **TeXRA tools over MCP.**
   - Serve TeXRA's research tools, such as arXiv search, web fetch, LaTeX
     compile and citation lookup, from a stdio MCP server, declared in a
     `.mcp.json`.
   - Copilot agent mode in VS Code consumes MCP servers, and so do Claude
     Code, Codex and other clients. One integration reaches all of them, and
     nothing in the harness, `packages/llm` or the storage format changes.
   - This fits the standing rulings: stdio MCP only, no new formats, and
     consume existing plugin layouts.
   - The open design question is which tools are safe outside a run. The old
     Copilot tools were limited to tools that read nothing from a run, and
     that rule carries over.
2. **TeXRA tools as VS Code language-model tools.**
   - The removed `registerLanguageModelTools.ts` plus the `languageModelTools`
     contribution: about 230 lines, extension-only, with no effect on
     the core.
   - Cheap to restore if MCP proves not to reach Copilot users well enough.
     It needs no Copilot routing, only the tool registration.
3. **A TeXRA chat participant.**
   - `vscode.chat.createChatParticipant` would let a user type `@texra` in
     Copilot Chat and reach TeXRA agents from there. This was never built.
   - It would put a second home for starting a run inside Copilot's UI, which
     conflicts with "one home per user action" unless TeXRA's own panel stops
     being the place to start runs.
   - It would also need a decision on how a chat turn maps to a TeXRA run and
     where the run's transcript lives.
4. **Copilot as a model source.**
   - The removed route, rebuilt. Users with a Copilot subscription would get
     models without provider keys.
   - This is the costliest option, for the reasons in "What it cost". If it
     comes back, it should come back as one provider in `packages/llm`, an HTTP-like
     `Model` whose transport the VS Code host supplies, rather than as a
     second turn shape.
   - The window–service split still means a service process cannot own the
     editor's model. Either such runs stay in the window process, or the RPC
     model calls return.
   - Check whether GitHub offers a supported HTTP route for third-party tools
     before rebuilding the editor bridge. An HTTP route would serve all three
     hosts the same way.

## If this is reopened

- Start with option 1. It costs least and reaches the most clients.
- Do not restore a parallel transport.
  - A model source is a `packages/llm` provider like any other.
  - A host-only capability is a typed port served by the host's runtime
    (CLAUDE.md, "Separation of concerns").
- A fallback from Copilot to another credential must be loud, and the
  run's rows must say which credential served each attempt.
- New stored values need a row-version bump. Readers stay strict.
