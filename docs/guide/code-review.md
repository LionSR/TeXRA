<script setup>
import PrReviewCard from '../.vitepress/components/PrReviewCard.vue';
</script>

# Code Review

The **TeXRA Code Review** GitHub Action posts a pull request review on each PR
— a short summary at the top, and inline comments on the lines TeXRA wants to
flag.

It runs from your own GitHub Actions environment, using model provider API keys
you put in your repo's secrets. Your code and diffs are not sent through any
TeXRA service.

## What you'll see on a PR

Once installed, every PR gets a single review from `github-actions[bot]`: a
summary comment at the top with TeXRA's overall verdict, plus inline comments on
the lines it wants to question. On the next push to the same PR, TeXRA updates
those same threads instead of posting duplicates.

<PrReviewCard />

<p class="hero-caption">One review per PR — a top-level verdict plus inline comments pinned to the flagged lines, refreshed in place on the next push.</p>

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
- `.github/prompts/texra-code-review-prompt.md` — custom review instructions
  used by this workflow. Read custom prompts from the trusted default branch,
  not from the pull request checkout.

The workflow delegates review mechanics to `texra-ai/texra-action/review`.
Pin the action to a reviewed release commit for reproducible CI behavior, and
update that pin deliberately when adopting a new action release.

Once the workflow is merged to your default branch, every new PR from a branch
in the same repository will get a TeXRA review. Keep any custom prompt on the
trusted default branch, or use the external action's bundled prompt by omitting
the trusted prompt checkout and `prompt-file` input.

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
- `TEXRA_REVIEW_MODEL_DEFAULTS` — JSON map from provider id to default model
  id, used when you want provider-specific defaults. Example:
  `{"deepseek":"deepseekproT","anthropic":"opus48T"}`.

Older per-provider variables such as `TEXRA_REVIEW_DEEPSEEK_MODEL` are no
longer read by the external action. Move those values into
`TEXRA_REVIEW_MODEL_DEFAULTS`.

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

## Review failures

If the model provider or CLI run fails, the external action fails the workflow
check instead of posting a fallback review. Treat that failed check as the
signal that no review was completed.

## Next Steps

- [TeXRA CLI](./texra-cli.md) — the `texra` command the action runs under the hood.
- [Built-in Agents](./built-in-agents.md#review) — what the `review` agent checks.
