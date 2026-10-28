---
name: code-review
description: TeXRA-aware code review. Use for /review, PR audits, or any code review of this repo. Catches platform-coupling, Effect Schema, run-loop, factory, modern-TypeScript, and webview-render rules that generic passes miss.
---

# TeXRA Code Review

A "no issues found" review on this repo is almost always wrong. AGENTS.md and the nested AGENTS.md files encode many narrow conventions; this skill turns them into a targeted check list.

## When to use this skill

- The user runs `/review`, asks for a code review, or asks "what would you flag?"
- A PR or branch needs an audit before merge.
- Reviewing changes that touch `packages/harness/src/agent/`, `packages/harness/src/tools/`, `packages/harness/src/platform/`, `packages/harness/src/model/`, or any webview frontend.

## Workflow

1. **Read [references/review-checklist.md](references/review-checklist.md).** Pick the categories that match the diff — don't grind through all of them.
2. **Identify the change surface.** Run `git diff` (or `git diff main...HEAD`) and group changed files by zone: VS Code-free zones (`VSCODE_FREE_ZONE_DIRS` in `eslint.config.mjs`) vs. the VS Code-allowed extension files (`extension.ts`, `commands/`, `frontend/`, `common/`, and the view providers outside their `frontend/`).
3. **Check the event-channel rule** (`packages/harness/AGENTS.md` "Event channels and cards"). Run facts extend `AgentEvent`, session facts extend `SessionEvent` and commit through the session log; any new `bus.emit` from a VS Code-free zone or new subscribe surface is a finding. `emitAppSignal(...)` within its documented scope is fine.
4. **Flag silent degradation.** A fallback that masks a failure is a defect unless it is loud (warn with the cause, and surface it). Grep the diff for `catch {`, `catch (_`, `.catch(() =>`, a `catchDecoding` default on persisted data, `??`/`||` over a failed read, and `default: return` in an event switch. Taxonomy and the accepted best-effort exceptions: checklist §15.
5. **Verify, don't speculate.** Open every file before flagging. If you can't verify, mark it as a question, not a finding.
6. **Order by severity.** Correctness/security → platform-decoupling → API-contract → maintainability. Cite `path:line` for every finding.
7. **Skip the noise.** Don't comment on whitespace, missing JSDoc on private helpers, or anything AGENTS.md says not to comment on.

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
- <what you actually opened, e.g. "Read packages/harness/src/tools/foo.ts:1-120; confirmed no `vscode` import">
```

Omit empty sections — don't write "(none)". If the diff is clean, say so in one sentence above `## Verified`. The `Verified` section is mandatory. Prefer 3 grounded findings over 10 generic ones.
