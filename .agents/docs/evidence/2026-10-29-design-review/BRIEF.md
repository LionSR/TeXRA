# Brief: A Philosophy of Software Design review of three agent harnesses (2026-10-29)

You are one of five reviewers. Each takes one lens from John Ousterhout's _A
Philosophy of Software Design_ and compares three agent harnesses through it.
The owner wants sharp, evidence-backed verdicts and a ranked list of what
TeXRA should change, not a survey.

## Sources (read-only; do not modify, do not run git checkout in them)

| Project                             | Path                                                                                                                                                                                              | Revision                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TeXRA harness (`@texra-ai/harness`) | `/Users/siruilu/Local/AI-Projects/coauthor/.claude/worktrees/apsd-cae1afc` (focus `packages/harness/src`; hosts in `packages/{cli,desktop,extension}`, app in `packages/texra`)                   | `cae1afc30a` (main after today's merges)                                  |
| pi (`earendil-works/pi`)            | `/private/tmp/claude-501/-Users-siruilu-Local-AI-Projects-coauthor/51ae2d1c-cdc9-4012-8639-38f682455ff8/scratchpad/pi-src` (focus `packages/durable`, `packages/agent`, `packages/coding-agent`)  | `c3d8ce4`, which includes unreleased durable-package changes beyond 1.4.0 |
| DeepSeek Harness                    | `/private/tmp/claude-501/-Users-siruilu-Local-AI-Projects-coauthor/51ae2d1c-cdc9-4012-8639-38f682455ff8/scratchpad/dsh-src` (minimal SDK profile vs richer approval/subagent profiles; say which) | `f3803c96`                                                                |

Read `AGENTS.md` and `packages/harness/AGENTS.md` in the TeXRA tree first: they
state the design rules TeXRA holds itself to (deep modules, no pass-through, one
owner per fact, errors defined out of existence, no silent fallbacks).

## Prior work: verify, do not repeat

- `.agents/docs/proposed/architecture/2026-10-21-harness-general-package-design/2026-10-29-peer-source-review.md` (and its `-pi-` and `-deepseek-` siblings) in `/Users/siruilu/Local/AI-Projects/coauthor` (untracked there; read by absolute path). It corrected earlier claims: loop sizes compare unequal responsibilities (pi's `startRun` delegates to a 2,528-line scheduler); credentials are already injectable, HTTP transport is the gap; DeepSeek services are typed despite string ids; counts are measurements, not causes.
- The release PRD: `git -C /Users/siruilu/Local/AI-Projects/coauthor show origin/docs/harness-1-release-prd:.agents/docs/proposed/architecture/2026-10-28-harness-1-release-prd.md`. Its "four contracts" and the ordered table (rows 0-13) are the queued work. Flag each recommendation as NEW or ALREADY QUEUED (row number).
- Today's merged changes you are reviewing the result of: #14395 (Run is a view), #14396 (RunReport internal), #14402 (plan as plugin.fact), #14397, #14399, #14401 (hook.outcome v2), #14411 (`RunRegistry.stopEnd`), #14412 (generation holds its claim). #14413 (decision chain in `loop/toolGuard.ts`) is still open; you may read it with `gh pr diff 14413 -R LionSR/TeXRA` but judge main.

## Rules for evidence

- Every claim cites `path:line` at the pinned revision. Counts say exactly what was counted and how (command or method), so the owner can rerun them.
- Compare equal responsibilities. If a peer delegates a responsibility elsewhere, follow it.
- Separate observed source behavior from inference. Say "inferred" when you did not trace it end to end.
- No peer is a design to import whole. Name what each does better and worse.
- Do not run peers' tests or install their dependencies. Do not edit any file outside your own report.

## Output

Write your report to `/private/tmp/claude-501/-Users-siruilu-Local-AI-Projects-coauthor/51ae2d1c-cdc9-4012-8639-38f682455ff8/scratchpad/apsd-1029/<lens>.md` in English, plain prose, no em dashes. Structure:

1. **Verdict** (3-5 sentences): who does this lens best and why; TeXRA's grade (A-F) for each project with one line of justification.
2. **Findings**: for each of TeXRA, pi, DeepSeek, the 2-4 strongest positive and negative examples with path:line and Ousterhout's term (deep module, shallow module, information leakage, temporal decomposition, pass-through method or variable, overexposure, special-general mixing, conjoined methods, change amplification, cognitive load, unknown unknowns, define errors out of existence, pull complexity downwards, different layer different abstraction).
3. **What TeXRA should do**: at most 5 recommendations, ranked by complexity removed. For each: the red flag it removes, the concrete change (files), a rough net-line estimate with how you estimated it, the peer evidence, and NEW or ALREADY QUEUED (PRD row).
4. **What TeXRA should refuse**: peer patterns that look attractive but would add complexity here, with the reason.
5. **Corrections**: any claim in the prior review or PRD your evidence contradicts.

Keep the report under 2,500 words. Finish by replying with the report path and your 3-sentence verdict.
