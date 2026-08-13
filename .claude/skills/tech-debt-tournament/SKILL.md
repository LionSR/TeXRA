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

1. **Read the ledger.** Call `mcp__github__get_issue` for #8974. Parse
   `cursor`, `rotationSize`, the ordered `areas` list, and the current
   do-not-do bullets from the body.

2. **Gather known issues for dedupe.** Call `mcp__github__search_issues` with
   `query: "repo:LionSR/TeXRA is:issue label:tech-debt"`. Do not restrict
   state: a recently closed issue remains a duplicate risk. Follow pagination
   until every page has been read, and reduce each issue to a `"#N <title>"`
   string for the `knownIssues` argument. Pull requests are not dedupe records.

3. **Run the workflow.** Call Claude Code's `Workflow` tool with
   `name: "tech-debt-tournament"` (or
   `scriptPath: ".claude/workflows/tech-debt-tournament.mjs"`) and args:

   ```text
   {
     campaignDate: "<today's date, YYYY-MM-DD, from environment context>",
     cursor: <ledger cursor>,
     rotationSize: <ledger rotationSize, default 3>,
     areas: [...ledger area names in their persisted order...],
     knownIssues: [...],
     doNotDo: [...ledger do-not-do bullets...],
     maxFile: 3
   }
   ```

   The workflow is entirely read-only: agents may inspect the repository but
   must not edit files or run state-changing commands.

   This script targets Claude Code's Workflow runtime and its inline `schema`
   option. Do not pass it to TeXRA's separate `delegate_multi_agents` tool;
   that host intentionally uses fixed result envelopes and JSON output files.

4. **Inspect the result.** The workflow returns
   `{ campaignDate, areasThisCycle, nextCursor, toFile, contested, rejected,
   newDoNotDo, droppedAsKnown, droppedAsDoNotDo, merged, seamCount }`. If
   `toFile` is empty, skip to step 7 and record a quiet cycle. Do not force a
   candidate through to meet a quota. Any candidate with a verifier correction
   is `CONTESTED`, so every `toFile` spec survived with its scope and estimates
   unchanged.

5. **Create the tracking issue first.** This makes a partially completed run
   recoverable. Call `mcp__github__create_issue` with:

   - Title: `Tracking: tech-debt tournament <campaignDate> (<N> deletion issue(s), ~-<total LoC> LoC)`.
   - Labels: `tracking`, `tech-debt`, and `source:claude`.
   - Body: `areasThisCycle` plus the planned child titles.

   Capture the tracking issue number and integer REST database `id`; the `id`
   is not its issue number and not its GraphQL `node_id`.

6. **Create and attach each child.** For each candidate in `toFile`, call
   `mcp__github__create_issue` in the style of #8758's children (for example,
   #8746):

   - Use the candidate title and spec.
   - Prefix the body with `From the <campaignDate> tech-debt tournament
     (adversarially verified). Verdict: REAL_NET_GAIN, ~-<estLoc> LoC,
     -<estElements> elements, risk <risk>.`
   - Apply `tech-debt`, `source:claude`, and `risk:<risk>` labels.

   Capture the child's issue number and integer REST database `id`, then call
   `mcp__github__add_sub_issue` with the tracking issue number and
   `sub_issue_id: <child id>`. After every child is attached, call
   `mcp__github__update_issue` to replace the tracking issue's planned list
   with filed issue links and summarize `droppedAsKnown`, `droppedAsDoNotDo`,
   and `contested` so a human can see why the cycle remained small.

7. **Update ledger issue #8974.** Only after all creates and attachments
   succeed, call `mcp__github__update_issue`:

   - Set `cursor` to `nextCursor`.
   - Append the plain-string `newDoNotDo` entries, deduplicated against the
     existing do-not-do bullets.
   - Append one cycle-log row with the date, `areasThisCycle`, filed issue
     numbers, and new do-not-do entries.
   - Preserve the rest of the body exactly.

8. **Report.** Return the date, areas covered, links to the filed children and
   tracking issue (or `quiet cycle, nothing survived verification`), and the
   next cursor.

## Guardrails

- Never raise `maxFile` or `rotationSize` above the skill defaults
  without the user explicitly asking for a bigger cycle — the whole point of
  this mechanism is small, steady, low-drama batches, not recreating the
  #8758 mega-campaign every few days.
- Do not push any code in this skill. The tournament only produces issues;
  implementing them is separate work (a normal PR-per-issue flow, same rules
  as #8758's "Working rules for this campaign" section).
- If `mcp__github__search_issues` or the ledger read fails, stop and report
  rather than guessing at cursor/dedupe state — filing duplicate or
  already-adjudicated issues is worse than skipping a cycle.
- If a child create or attachment fails, do not advance the ledger and do not
  restart from scratch. Report the existing tracking issue and use its planned
  child list to resume only the missing create or attach operations.
