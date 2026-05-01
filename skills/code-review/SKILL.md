---
name: code-review
description: TeXRA-specific code review. Use when reviewing a PR, branch, or staged changes in this repository. Replaces a generic "looks good" pass with concrete, repo-aware checks against CLAUDE.md and AGENTS.md (platform decoupling, Zod v4 patterns, PocketFlow rules, factory anti-patterns, render-time workarounds, configuration/storage/log routing). The built-in /review skill should consult this skill first when reviewing TeXRA code.
---

# TeXRA Code Review

A "no issues found" review on this repo is almost always wrong. This codebase has many narrow, project-specific conventions that generic review passes miss. Use this skill to ground review comments in real repo rules instead of vague style notes.

## When to use this skill

- The user runs `/review`, asks for a code review, or asks "what would you flag?"
- A PR or branch needs an audit before merge.
- Reviewing changes that touch `src/agent/`, `src/tools/`, `src/platform/`, `src/model/`, or any webview frontend.

## How to run a review

1. **Read [references/review-checklist.md](references/review-checklist.md) first.** It is the source of truth for repo-specific rules. Treat it as a search list, not a tickbox form — pick the categories that apply to the diff.
2. **Identify the change surface.** Run `git diff` (or `git diff main...HEAD`) and group changed files by zone: VS Code-free zones (`agent/`, `model/`, `latex/`, `tools/`, `shared/`, `replacement/`, `eventBus/`, webview frontends), VS Code-allowed zones (`extension.ts`, `commands/`, `frontend/`, `common/webview`, `common/state`, `auth/`), and platform layer (`platform/`).
3. **Run the targeted checks** from the checklist that match the zones touched. Most findings cluster around: platform coupling, Zod schemas, PocketFlow services, configuration/log routing, factory layering, and render-time workarounds.
4. **Verify, don't speculate.** Before flagging, open the file and confirm the issue exists in the current diff, not in unrelated code. If something looks suspicious but you can't verify it, mark it as a question, not a finding.
5. **Order findings by severity:** correctness/security first, then platform-decoupling violations, then API-contract issues, then style/maintainability. Cite `path:line` for every finding.
6. **Skip the noise.** Don't comment on whitespace, missing JSDoc on private helpers, or anything CLAUDE.md says not to comment on. Don't propose new abstractions that the diff doesn't already justify.

## Review output format

Structure findings as:

```
## Findings

### Critical
- `path/file.ts:42` — <one-line summary>. <why it matters / what to do>.

### Should fix
- ...

### Nits / questions
- ...

## Verified
- <what you actually opened and checked, e.g. "Read src/tools/foo.ts:1-120; confirmed no `vscode` import">
```

Always include the **Verified** section. It forces honesty about what was actually inspected vs. skimmed, and it makes "no issues found" mean something — list what you checked.

## Quality bar

- A correct review either lists concrete findings tied to repo rules, or names what was inspected and why it's clean. Never both empty.
- Prefer 3 well-grounded findings over 10 generic ones.
- If the diff is large, narrow scope and say so ("Reviewed agent/ and tools/ paths; webview changes not yet reviewed").
- For UI changes, the build doesn't validate behavior — say so explicitly if you couldn't run the extension.

## Repo facts the review should know

- **Platform abstraction**: core code reaches host services via `platform()` from `@platform` (see `src/platform/platform.ts`). Direct `vscode` imports are forbidden in `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, and webview frontends.
- **Zod v4** with `.nullish()` (not `.optional()`) for tool input schemas; `.prefault()` for deserialization; `.catch()` for fallbacks; `.int()` / `.uuid()` / `.iso.datetime()` natively.
- **PocketFlow**: services are immutable, set once via `flow.setServices()`; shared store holds only mutable state; transitions use `FlowTransition.*` constants; agents own lifecycle, flows own execution.
- **Build commands**: `npm run compile:fast` / `package:fast` / `build:fast` skip type checking — `npm run typecheck` (or `compile:safe`) is required to catch type errors. **Never run `npm test`** (downloads VS Code test env; wastes time).
- **Path aliases** (in `tsconfig.json`): `@agent/*`, `@commands/*`, `@common/*`, `@frontend/*`, `@utils/*`, `@model/*`, `@latex/*`, `@logger/*`, `@tools/*`, `@webview/*`, `@progressView/*`, `@settingsView/*`, `@shared/*`, `@eventBus/*`, `@replacement/*`, `@housekeeping/*`, `@auth/*`, `@types/*`, `@platform`, `@platform/*`.
