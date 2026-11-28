---
name: github
description: Follow a pull request's reviews, comments and CI, an issue's activity or a repository's new pull requests and issues with the `gh` command line in `bash`, and come back to check again with `wake`. Use when the user asks to watch, follow up on or react to GitHub activity. Needs `gh` installed and signed in.
---

# GitHub activity with `gh`

Everything here is the GitHub CLI run through `bash`. Nothing watches GitHub for you: you read the state, act on it, and arrange your own next look with `wake`.

## Sign-in

`gh` uses its own login (`gh auth login`, which the user runs in a terminal: it is interactive) or the `GH_TOKEN` / `GITHUB_TOKEN` environment variable of the process TeXRA runs in. Check before anything else:

```bash
gh auth status
```

If it reports no login, tell the user what to run and stop; do not ask for a token in the conversation. Inside a clone, `gh` takes the repository from the `origin` remote; elsewhere pass `-R OWNER/REPO`.

## A pull request

```bash
gh pr view 123 --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,updatedAt,url
gh pr checks 123                       # one line per check: name, state, link
gh pr checks 123 --json name,state,bucket,link,workflow
gh pr view 123 --json reviews,latestReviews,comments   # review verdicts and conversation comments
gh api repos/{owner}/{repo}/pulls/123/comments --paginate   # review comments on lines of the diff
```

- `gh pr view --comments` prints the conversation only. Comments on lines of the diff come from the `pulls/123/comments` endpoint: each has `path`, `line`, `body`, `user.login`, `created_at` and, for a reply, `in_reply_to_id`.
- Inside a clone `gh api` fills `{owner}` and `{repo}` from the repository.
- A failed check's log: take the run id from the check's `link` (`.../actions/runs/<run id>/job/<job id>`), then `gh run view <run id> --log-failed`. The log is long; pipe it through `tail` or `grep`.
- Without a number, `gh pr view` and `gh pr checks` use the pull request of the current branch.

## An issue, a repository

```bash
gh issue view 45 --json title,state,labels,assignees,comments,updatedAt
gh pr list --state open --json number,title,author,updatedAt,isDraft
gh issue list --state open --json number,title,author,updatedAt,labels
```

## Seeing only what is new

Keep what you have already handled in your wake note or a small file: the newest comment's `created_at` (or id), the head commit (`headRefOid`) and each check's state. On the next look, act only on what is newer, and skip comments from bots unless the user asked for them. `--jq` filters on the spot:

```bash
gh api repos/{owner}/{repo}/pulls/123/comments --paginate \
  --jq '.[] | select(.created_at > "2030-01-31T09:00:00Z") | {user: .user.login, path, line, body}'
```

## Coming back later

To follow something over time, end your turn with `wake`: a note to yourself and a delay (at least 60 seconds; a few minutes is right for CI, longer for reviews). The note is all you will have, so write what to check, what you have already handled, and when to stop (merged, closed, checks green and no open comments). Each wake's turn arranges the next one. Tell the user that you are following the pull request and how to stop it (stopping the task cancels its pending wakes).

- A wake is kept by the running TeXRA process for the project. If none is running when it is due, it is delivered once, late, the next time the project is opened.
- A one-shot run (`texra run`, a program) takes no later message, so `wake` fails there. Check once and report; or wait inside the run with `gh pr checks 123 --watch --fail-fast` under a `bash` timeout.
- To wait on CI alone within a turn, `gh pr checks 123 --watch` returns when every check has finished. Run it with `run_in_background: true` and a `timeout` that fits, and its result arrives as a message.

## Acting

Replying, reviewing, pushing fixes and merging change things other people see: do them when the user asked for that, and say what you did.

```bash
gh pr comment 123 --body-file reply.md
gh api repos/{owner}/{repo}/pulls/123/comments/<comment id>/replies -f body='Fixed in abc1234.'
```
