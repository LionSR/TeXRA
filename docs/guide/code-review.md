# Code Review

The **TeXRA Code Review** GitHub Action posts a pull request review on each PR
— a short summary at the top, and inline comments on the lines TeXRA wants to
flag.

It runs from your own GitHub Actions environment, using model provider API keys
you put in your repo's secrets. Your code and diffs are not sent through any
TeXRA service.

## What you'll see on a PR

Once installed, every PR gets a single review from `github-actions[bot]`:

- A summary comment at the top of the PR with TeXRA's overall verdict.
- Inline comments on the lines TeXRA wants to question or suggest changes for.
- On the next push to the same PR, TeXRA updates the same threads instead of
  posting duplicates.

## What you need

- A GitHub repository with Actions enabled.
- A model provider API key (Anthropic, OpenAI, Google, etc.) saved as a repo
  secret.
- Nothing else — the shipped workflow already declares the GitHub permissions
  it needs to read code and write review comments.

## Setup

### 1. Add the workflow files

Copy these into the repository you want reviewed:

- `.github/workflows/texra-code-review.yml` — the workflow.
- `.github/actions/texra-code-review/` — the composite action and its scripts.
- `.github/prompts/texra-code-review-prompt.md` — the review prompt.

Once these are merged to your default branch, every new PR from a branch in
the same repository will get a TeXRA review. The review code always runs from
the version on your default branch, so PR authors can't change how reviews
work by editing the workflow.

::: warning Forks don't get reviewed
PRs opened from a **fork** are not reviewed. GitHub deliberately doesn't share
your repo secrets with forks, so the workflow has nothing to talk to the model
provider with and exits quietly. If a contributor needs a TeXRA review, push
their branch into your repo (or to a topic branch you control) and reopen the
PR from there.
:::

### 2. Add a provider API key secret

Add at least one of these repository secrets (Settings → Secrets and variables →
Actions → **Secrets**):

| Secret               | Provider   |
| -------------------- | ---------- |
| `ANTHROPIC_API_KEY`  | Anthropic  |
| `OPENAI_API_KEY`     | OpenAI     |
| `GOOGLE_API_KEY`     | Google     |
| `DEEPSEEK_API_KEY`   | DeepSeek   |
| `OPENROUTER_API_KEY` | OpenRouter |
| `XAI_API_KEY`        | xAI        |

Without at least one of these, TeXRA can't talk to any model — the workflow
posts no review and skips quietly (you'll see a "no model provider API key"
notice on the run). TeXRA charges these keys directly; you don't need a TeXRA
sign-in for code review.

### 3. (Optional) Pick a model

By default TeXRA picks a sensible model for whichever provider key you set,
trying providers in this order: **DeepSeek → Anthropic → OpenAI → Google →
OpenRouter → xAI**.

To override, add one of these as a repo **variable** (Settings → Secrets and
variables → Actions → **Variables**):

- `TEXRA_REVIEW_MODEL` — pin one model id for every review, regardless of
  provider.
- `TEXRA_REVIEW_ANTHROPIC_MODEL`, `TEXRA_REVIEW_OPENAI_MODEL`,
  `TEXRA_REVIEW_GOOGLE_MODEL`, `TEXRA_REVIEW_DEEPSEEK_MODEL`,
  `TEXRA_REVIEW_OPENROUTER_MODEL`, `TEXRA_REVIEW_XAI_MODEL` — override the
  default for one provider only.

The built-in defaults:

| Provider   | Default model  |
| ---------- | -------------- |
| DeepSeek   | `deepseekproT` |
| Anthropic  | `opus48T`      |
| OpenAI     | `gpt55`        |
| Google     | `gemini31p`    |
| OpenRouter | `gptoss`       |
| xAI        | `grok4`        |

### 4. (Optional) Pin the TeXRA CLI version

By default the workflow installs the latest published `texra` CLI on each run.
To pin a specific version (e.g. for reproducibility), set the
`TEXRA_CLI_VERSION` repository variable to the version you want — `0.38.2`,
`latest`, or empty for latest.

## Turning reviews off

Set the repository variable `TEXRA_REVIEW_ENABLED` to `false` to pause TeXRA
reviews without removing the workflow file. Set it back to anything else (or
unset it) to resume.

## Replying to your own threads

Out of the box, TeXRA posts review comments but can't resolve or reply to its
own earlier threads — GitHub's default Actions token isn't allowed to. If you
want TeXRA to clean up its own threads on subsequent pushes (resolving fixed
ones, replying with updates rather than re-posting), create a personal or
fine-grained access token with pull-request review permissions and add it as a
`TEXRA_REVIEW_GITHUB_TOKEN` repo secret.

## Next Steps

- [TeXRA CLI](./texra-cli.md) — the `texra` command the action runs under the hood.
- [Built-in Agents](./built-in-agents.md#review) — what the `review` agent checks.
