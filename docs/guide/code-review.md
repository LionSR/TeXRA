# Code Review

TeXRA can review your pull requests automatically. The **TeXRA Code Review**
GitHub Action runs the `review` tool-use agent headlessly on each PR, then posts
a pull request review with inline comments anchored to the changed lines.

The review runs entirely from your repository using your own provider API keys —
TeXRA does not proxy your code or your diffs.

## What It Does

On every pull request the workflow:

1. Builds the PR diff (`merge-base..head`) and computes the set of lines that can
   take inline comments.
2. Collects any previous TeXRA review threads so follow-up runs can update or
   resolve them instead of repeating themselves.
3. Runs the `review` agent headlessly (`texra agents run review … --output-format json`)
   with the diff as read-only context.
4. Posts a single pull request review: a summary plus inline comments on the
   changed lines.

## Requirements

- A GitHub repository with Actions enabled.
- At least one **model provider API key** stored as a repository secret.
- The workflow needs `contents: read` and `pull-requests: write` permissions
  (already declared in the shipped workflow).

## Setup

### 1. Add the workflow files

Copy these into the repository you want reviewed:

- `.github/workflows/texra-code-review.yml` — the workflow.
- `.github/actions/texra-code-review/` — the composite action and its scripts.
- `.github/prompts/texra-code-review-prompt.md` — the review prompt.

The workflow loads the action from the **base branch** of each PR (a
`.trusted-actions` checkout), so PR branches cannot alter the review logic. Once
the files are merged to your default branch, reviews run on PRs opened from
branches in the same repository.

::: warning Forked PRs
The workflow triggers on `pull_request`, which by design does not expose
repository secrets to forks. PRs opened from forked repositories will hit the
"no model provider API key" skip path and produce no review. This is the
intended trade-off — reviewing untrusted code with privileged secrets would let
fork authors exfiltrate them. If you need reviews on external contributor PRs,
gate them behind a maintainer-triggered workflow (for example
`pull_request_target` with explicit checkout safeguards) rather than the shipped
configuration.
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

If no provider key is present, the workflow logs a notice and skips the review
instead of failing. The action runs with `api-mode: personal`, so it always uses
these keys rather than a TeXRA sign-in.

### 3. (Optional) Configure the model

Model selection is resolved at runtime (Settings → Secrets and variables →
Actions → **Variables**):

- Set `TEXRA_REVIEW_MODEL` to pin one model id for every review.
- Otherwise the first provider with a configured key wins, in this order:
  DeepSeek, Anthropic, OpenAI, Google, OpenRouter, xAI. Override the per-provider
  default with `TEXRA_REVIEW_ANTHROPIC_MODEL`, `TEXRA_REVIEW_OPENAI_MODEL`,
  `TEXRA_REVIEW_GOOGLE_MODEL`, `TEXRA_REVIEW_DEEPSEEK_MODEL`,
  `TEXRA_REVIEW_OPENROUTER_MODEL`, or `TEXRA_REVIEW_XAI_MODEL`.

Built-in defaults per provider:

| Provider   | Default model  |
| ---------- | -------------- |
| DeepSeek   | `deepseekproT` |
| Anthropic  | `opus47T`      |
| OpenAI     | `gpt55`        |
| Google     | `gemini31p`    |
| OpenRouter | `gptoss`       |
| xAI        | `grok4`        |

### 4. (Optional) Pin the CLI version

Set the `TEXRA_CLI_VERSION` variable to install a specific `@texra-ai/cli`
version in CI. Leave it empty (or `latest`) to track the latest published
release.

## Turning Reviews Off

Set the repository variable `TEXRA_REVIEW_ENABLED` to `false` to skip the review
on every PR without removing the workflow. Any other value (or no value) keeps it
enabled.

## Threaded Follow-ups

By default the action posts with the built-in `GITHUB_TOKEN`. Add a
`TEXRA_REVIEW_GITHUB_TOKEN` secret (with pull-request review permissions) to let
TeXRA reuse existing review threads across runs — resolving and replying instead
of posting duplicate comments.

## Next Steps

- [TeXRA CLI](./texra-cli.md) — the `texra` command the action runs under the hood.
- [Built-in Agents](./built-in-agents.md#review) — what the `review` agent checks.
