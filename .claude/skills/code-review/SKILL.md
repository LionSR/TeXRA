---
name: code-review
description: TeXRA-aware code review. Use for /review, PR audits, or any code review of this repo. Catches platform-coupling, Zod v4, PocketFlow, factory, and webview-render rules that generic passes miss.
---

# TeXRA Code Review

A "no issues found" review on this repo is almost always wrong. CLAUDE.md and AGENTS.md encode many narrow conventions; this skill turns them into a targeted check list.

## When to use this skill

- The user runs `/review`, asks for a code review, or asks "what would you flag?"
- A PR or branch needs an audit before merge.
- Reviewing changes that touch `src/agent/`, `src/tools/`, `src/platform/`, `src/model/`, or any webview frontend.

## Workflow

1. **Read [references/review-checklist.md](references/review-checklist.md).** Pick the categories that match the diff — don't grind through all of them.
2. **Identify the change surface.** Run `git diff` (or `git diff main...HEAD`) and group changed files by zone: VS Code-free zones (`agent/`, `model/`, `latex/`, `tools/`, `shared/`, `replacement/`, `eventBus/`, webview frontends) vs. VS Code-allowed zones (`extension.ts`, `commands/`, `frontend/`, `common/webview/`, `common/state/`, `auth/`, `platform/`).
3. **Verify, don't speculate.** Open every file before flagging. If you can't verify, mark it as a question, not a finding.
4. **Order by severity.** Correctness/security → platform-decoupling → API-contract → maintainability. Cite `path:line` for every finding.
5. **Skip the noise.** Don't comment on whitespace, missing JSDoc on private helpers, or anything CLAUDE.md says not to comment on.

## Output format

Write the rendered review in calm, declarative prose. No emojis (🔴 / 🟡 / ℹ️ / ⚠️ / etc.), no ALL-CAPS shouting, no alarmist labels like "BLOCKER" or "CRITICAL". State the issue, cite `path:line`, propose the fix.

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
