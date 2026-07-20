---
name: tech-debt-tournament
description: Run one cycle of the recurring tech-debt tournament — reads rotation state from the ledger issue, runs the tech-debt-tournament workflow over a small rotating slice of the codebase, files a capped number of issues, updates the ledger. Use when invoked by the scheduled routine, or when the user explicitly asks to run a tech-debt tournament cycle.
---

# Tech-debt tournament (recurring, scoped)

This is the repeatable version of the campaign that produced #8758 (12 deletion
issues, ~-1k LoC, adversarially verified). Instead of one large sweep, it runs
in small cycles: a rotating slice of the codebase per run, a small cap on
issues filed per run. The mechanism exists so real, verified tech-debt issues
accumulate every few days without another 27-agent mega-campaign each time.

Ledger issue: **LionSR/TeXRA#8974** — holds the rotation cursor, the
do-not-do list, and the cycle log. Always read it fresh; never trust a cached
cursor from a previous conversation turn.

## Steps

1. **Read the ledger.** `mcp__github__issue_read` (method `get`) on #8974.
   Parse `cursor`, `rotationSize`, the `areas` order list, and the current
   do-not-do bullet list from the body.

2. **Gather known issues for dedupe.** `mcp__github__search_issues` with
   `query: "repo:LionSR/TeXRA label:tech-debt"` (state not restricted — a
   recently closed tech-debt issue is still a real duplicate risk). Reduce
   each hit to `"#N <title>"` strings; that is the `knownIssues` arg.

3. **Run the workflow.** Call `Workflow` with `name: "tech-debt-tournament"`
   (or `scriptPath: ".claude/workflows/tech-debt-tournament.mjs"`) and args:
   ```
   {
     campaignDate: "<today's date, YYYY-MM-DD, from environment context>",
     cursor: <ledger cursor>,
     rotationSize: <ledger rotationSize, default 3>,
     knownIssues: [...],
     doNotDo: [...ledger do-not-do bullets...],
     maxVerify: 8,
     maxFile: 3
   }
   ```
   The workflow is entirely read-only (no edits, no state-changing commands
   inside any spawned agent) until this point — everything so far only reads
   the repo and GitHub.

4. **Inspect the result.** The workflow returns
   `{ campaignDate, areasThisCycle, nextCursor, toFile, carriedForward,
   contested, rejected, newDoNotDo, droppedAsKnown, droppedAsDoNotDo, merged,
   seamCount }`. If `toFile` is empty, skip straight to step 7 (update the
   ledger cycle log with zero filed — a quiet cycle is a valid outcome, don't
   force filing to hit a quota).

5. **File the issues.** For each candidate in `toFile`, in the same style as
   the child issues under #8758 (e.g. #8746): `mcp__github__issue_write`
   method `create`, `owner: LionSR`, `repo: TeXRA`, `title` from the
   candidate (issue-style, e.g. `refactor(scope): <what ceases to exist>
   (~-N LoC)`), `body` = the candidate's `spec` plus a short header noting
   `From the <campaignDate> tech-debt tournament (adversarially verified).
   Verdict: REAL_NET_GAIN, ~-<estLoc> LoC, -<estElements> elements, risk
   <risk>.` and append any `corrections` from the verify phase as a
   `**Verifier corrections**` section — these are hard scope requirements,
   not suggestions. `labels: ["tech-debt", "source:claude", "risk:<risk>"]`.

6. **Create the cycle's tracking issue and attach sub-issues.** One umbrella
   issue per cycle (mirrors #8758's shape but scaled down):
   title `tracking: tech-debt tournament <campaignDate> (<N> deletion
   issue(s), ~-<total LoC> LoC)`, body summarizing `areasThisCycle`, the
   filed issues, and — briefly — what was dropped (`droppedAsKnown`,
   `droppedAsDoNotDo`, `contested`, `carriedForward`) so a human skimming it
   understands why the count is small. Then `mcp__github__sub_issue_write`
   method `add` for each filed issue under this tracking issue.

7. **Update the ledger issue (#8974).** `mcp__github__issue_write` method
   `update` on #8974:
   - Set `cursor` to the workflow's `nextCursor`.
   - Append any `newDoNotDo` entries to the do-not-do list (dedupe against
     what's already there — don't duplicate an entry).
   - Append one row to the cycle log table: date, `areasThisCycle`, filed
     issue numbers, `carriedForward` titles (if any), new do-not-do entries
     (if any).
   - Keep the rest of the body intact — this is an update, not a rewrite of
     the working rules section.

8. **Report.** One short message: date, areas covered this cycle, links to
   the filed issues and tracking issue (or "quiet cycle, nothing survived
   verification" if `toFile` was empty), and the new cursor position for
   context on what's next.

## Guardrails

- Never raise `maxFile`/`maxVerify`/`rotationSize` above the SKILL defaults
  without the user explicitly asking for a bigger cycle — the whole point of
  this mechanism is small, steady, low-drama batches, not recreating the
  #8758 mega-campaign every few days.
- Do not push any code in this skill. The tournament only produces issues;
  implementing them is separate work (a normal PR-per-issue flow, same rules
  as #8758's "Working rules for this campaign" section).
- If `mcp__github__search_issues` or the ledger read fails, stop and report
  rather than guessing at cursor/dedupe state — filing duplicate or
  already-adjudicated issues is worse than skipping a cycle.
