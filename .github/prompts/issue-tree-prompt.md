You maintain the issue tree for the repository named in the runtime context.
Daily, cluster orphan issues into parents, then close completed trackers. Run
both phases in this order.

Use the GitHub MCP tools, not the `gh` CLI, for all GitHub operations.

## Phase A: Cluster Orphan Issues Into Parents

1. List up to 100 open issues without a parent. Drop any item that has a
   `pull_request` field: GitHub's issues endpoint returns pull requests
   alongside issues, and pull requests must never be clustered or linked as
   sub-issues. Then exclude issues labeled `tracking` or with titles starting
   `Tracking:`, `[Parent]`, `Epic:`, or `Meta:`, matching this repository's
   tracker convention from `issue-tracker.yml`.
2. Find clusters of five or more orphans sharing a clear theme. A common
   `area:*` label is the strongest signal; root-cause overlap or feature
   decomposition also count.
3. Skip a cluster if the cluster's theme is already covered by an existing open
   tracker. Match on either a tracker title whose wording overlaps the cluster
   theme, or an open issue labeled `tracking` whose `area:*` labels overlap the
   cluster's `area:*` labels and whose body or title indicates the same theme.
   Do not skip merely because some unrelated tracker exists in the repository:
   the check is theme-scoped, not global.
4. From the `list_issues` response, capture each child's integer `id`, namely
   the REST database id. This is not the issue `number` and not the GraphQL
   `node_id` string.
5. For each surviving cluster, create the parent via `mcp__github__issue_write`
   with `method=create`.
   - Title: `Tracking: <theme>`.
   - Labels: `tracking` plus the cluster's `area:*` labels.
   - Body: one-paragraph theme plus checklist rows of the form `- [ ] #N - title`.
   - Capture both `number` and integer `id` from the response.
6. Link each child as a native sub-issue with `mcp__github__sub_issue_write`,
   `method=add`, `issue_number=<parent-number>`, and
   `sub_issue_id=<child-id>`. The `sub_issue_id` is the child's numeric REST id,
   not its issue number and not its `node_id`.

Phase A caps:

- At most five new parents per run.
- At most 50 sub-issue links per run.
- Precision over recall: link only when the relationship is unambiguous.

## Phase B: Close Completed Trackers

For each open issue labeled `tracking` in the repository named in the runtime
context, excluding any parent created in Phase A this run:

- Read its sub-issues via `mcp__github__issue_read`.
- It qualifies for closure only if it has at least one sub-issue and every
  sub-issue is closed with `state_reason=completed`. Skip if any sub-issue is
  `not_planned` or `duplicate`.
- Skip parents created less than 24 hours ago.
- Process leaf-up: close inner trackers first, then re-check outer ones in the
  same run.

To close, comment:

```text
All N sub-issues closed as completed. Auto-closing this tracker.
```

Then call `mcp__github__issue_write` with `method=update`, `state=closed`, and
`state_reason=completed`.

Phase B cap: at most 20 closures per run.

## Final Report

Give a one-line summary per phase. Skip silently when nothing matches.
