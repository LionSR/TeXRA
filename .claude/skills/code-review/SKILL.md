---
name: code-review
description: TeXRA-aware code review. Use for /review, PR audits, or any code review of this repo. Catches platform-coupling, Zod v4, PocketFlow, factory, modern-TypeScript, and webview-render rules that generic passes miss.
---

# TeXRA Code Review

A "no issues found" review on this repo is almost always wrong. CLAUDE.md and AGENTS.md encode many narrow conventions; this skill turns them into a targeted check list.

## When to use this skill

- The user runs `/review`, asks for a code review, or asks "what would you flag?"
- A PR or branch needs an audit before merge.
- Reviewing changes that touch `src/agent/`, `src/tools/`, `src/platform/`, `src/model/`, or any webview frontend.

## Workflow

1. **Read [references/review-checklist.md](references/review-checklist.md).** Pick the categories that match the diff — don't grind through all of them.
2. **Identify the change surface.** Run `git diff` (or `git diff main...HEAD`) and group changed files by zone: VS Code-free zones (`agent/`, `model/`, `latex/`, `tools/`, `controllers/`, `shared/`, `replacement/`, `eventBus/`, webview frontends) vs. VS Code-allowed zones (`extension.ts`, `commands/`, `frontend/`, `common/webview/`, `common/state/`, `auth/`, `platform/`).
3. **Check the event-channel rule.** New run-scoped facts extend `AgentEvent` (trace); session-scoped facts extend `SessionFact`. Flag any new `bus.emit` from a VS Code-free zone and any new subscribe surface. The `src/tools` emit sites this rule once grandfathered have migrated to session-owned emission (`SessionHandle.events` / `SessionEventHub` in `src/agent/runtime/`), so a new direct `bus.emit` is a violation, not a grandfathered pattern. This does not restrict `appSignals.emit(...)` on the separate `AppSignals` bus (`src/eventBus/AppSignals.ts`) within its documented scope. Background: `docs/proposals/2026-06-10-error-pipeline-and-ownership.md`.
4. **Flag silent degradation.** A fallback that masks a failure is a defect unless it is loud (warn with the cause, and surface it). Grep the diff for `catch {`, `catch (_`, `.catch(() =>`, a Zod `.catch(` on persisted data, `??`/`||` over a failed read, and `default: return` in an event switch. Taxonomy and the accepted best-effort exceptions: checklist §15.
5. **Verify, don't speculate.** Open every file before flagging. If you can't verify, mark it as a question, not a finding.
6. **Order by severity.** Correctness/security → platform-decoupling → API-contract → maintainability. Cite `path:line` for every finding.
7. **Skip the noise.** Don't comment on whitespace, missing JSDoc on private helpers, or anything CLAUDE.md says not to comment on.

## Output format

Default to calm, declarative prose. State the issue, cite `path:line`, propose the fix.

Emoji use:
- Headers and "categories I checked" prose: none. Don't decorate routine review structure.
- Clean reviews: none. A no-issues report shouldn't look like an emergency.
- Genuine Blocker findings (real security, platform-decoupling, or build-breaking issues): a single 🔴 prefix on that finding's line is fine. Use sparingly — one per real Blocker.
- Suggestions and Notes: plain bullets, no emoji.
- Don't use ALL-CAPS or words like "BLOCKER" / "CRITICAL" as decoration; prose plus the GitHub review status carries the urgency.

```
## Findings

### Issues to address before merge
- `path/file.ts:42` — <one-line summary>. <why / fix>.

### Suggestions
- ...

### Notes
- ...

## Verified
- <what you actually opened, e.g. "Read src/tools/foo.ts:1-120; confirmed no `vscode` import">
```

Omit empty sections — don't write "(none)". If the diff is clean, say so in one sentence above `## Verified`. The `Verified` section is mandatory. Prefer 3 grounded findings over 10 generic ones.
