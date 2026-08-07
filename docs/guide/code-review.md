<script setup>
import PrReviewCard from '../.vitepress/components/PrReviewCard.vue';
</script>

# Code Review

The **TeXRA Code Review** GitHub Action posts a pull request review on each PR
— a short summary at the top, and inline comments on the lines TeXRA wants to
flag.

It runs from your own GitHub Actions environment, using model provider API keys
you put in your repo's secrets. Your code and diffs are not sent through any
TeXRA service; only a GitHub-signed workload identity is exchanged for a
short-lived TeXRA GitHub App token.

This page walks through the whole setup from zero — no prior GitHub Actions
experience needed. Short version: from the repo, run
`texra install-github-action`, then set one provider API key secret.

## What you'll see on a PR

Once installed, every PR gets a single review from `texra-ai-bot[bot]`: a
summary comment at the top with TeXRA's overall verdict, plus inline comments on
the lines it wants to question. On the next push to the same PR, TeXRA updates
those same threads instead of posting duplicates.

<PrReviewCard />

<p class="hero-caption">One review per PR — a top-level verdict plus inline comments pinned to the flagged lines, refreshed in place on the next push.</p>

## How it works

If you haven't used GitHub Actions before, here is the whole picture:

- **GitHub Actions** is GitHub's built-in automation service. You describe a
  job in a YAML file inside your repo (under `.github/workflows/`), and GitHub
  runs it on its own servers whenever the trigger you chose fires — here,
  whenever a pull request is opened or updated.
- **The job checks out your PR and asks an AI model to review the diff.** It
  installs the [TeXRA CLI](./texra-cli.md), feeds it the pull request diff plus
  any files the model wants to read, and posts the result back as a normal
  GitHub review.
- **The model call uses _your_ API key**, stored as an encrypted repository
  _secret_. The diff travels directly from GitHub's runner to your model
  provider (Anthropic, OpenAI, Google, …). There is no TeXRA server in the
  middle, and no TeXRA account or sign-in is needed.
- **Cost:** each review is one ordinary API call billed to your key by the
  provider. The price depends on the model you pick and the size of the diff —
  for typical PRs it is small, but very large diffs on premium models cost
  more.

## What you need

- A GitHub repository you administer, with Actions enabled (default on GitHub).
- The [TeXRA CLI](./texra-cli.md) installed locally (`npm i -g @texra-ai/cli`),
  plus [`gh`](https://cli.github.com/) authenticated for opening the workflow
  PR (`gh auth login`).
- An API key from at least one model provider. Prefer open-weight options
  when you can (DeepSeek, OpenRouter); Anthropic, OpenAI, Google, and xAI
  also work.

## Setup

### Quick setup (recommended)

From a clone of the repository you want TeXRA to review:

```bash
texra install-github-action
```

That command:

1. Opens the [TeXRA GitHub App](https://github.com/apps/texra-ai-bot) installer
   so you can grant access to the repo (reviews then post as `texra-ai-bot[bot]`).
2. Writes `.github/workflows/texra-code-review.yml` on a branch.
3. Pushes and opens a pull-request page for you to create (or use `--no-pr` to
   stop after committing locally).

Then set **one** provider API key as a repository secret so the model can run.
Prefer an open-weight option when you can:

```bash
gh secret set DEEPSEEK_API_KEY
```

(Or `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, or `XAI_API_KEY` — names must match exactly.)

Merge the install PR to your default branch. From then on, same-repo PRs get a
TeXRA review. Open the PR checks (or the repo **Actions** tab) and click
**TeXRA Code Review** to watch a run.

::: tip
You must be able to install GitHub Apps on the repository and to add Actions
secrets. If `gh pr create --web` fails with a workflow-scope error, run
`gh auth refresh -h github.com -s workflow` and retry.
:::

::: warning Forks don't get reviewed
PRs opened from a **fork** are not reviewed. GitHub deliberately doesn't share
your repo secrets with forks, so the workflow has nothing to talk to the model
provider with and exits quietly. If a contributor needs a TeXRA review, push
their branch into your repo (or to a topic branch you control) and reopen the
PR from there.
:::

### Manual setup

Use this when you can't run the CLI, when the installer fails, or when you want
to review every YAML line yourself.

1. Install the [TeXRA GitHub App](https://github.com/apps/texra-ai-bot) on the
   repository.
2. Add a provider API key under **Settings → Secrets and variables → Actions**
   (see the secret names in [Quick setup](#quick-setup-recommended)).
3. Add `.github/workflows/texra-code-review.yml` from the
   [`texra-ai/texra-action` examples](https://github.com/texra-ai/texra-action/tree/main/examples)
   (start with `pr-review.yml`), commit it to the default branch, and open a
   test PR.

The workflow needs `permissions.id-token: write` so the action can exchange a
GitHub Actions OIDC token for a short-lived App installation token. Leave
`github-token` unset unless you intentionally override App auth.

::: tip Pin the action version for reproducible CI
`@v1` tracks the latest v1.x release. To change review behavior only when you
decide, pin a reviewed release commit —
`uses: texra-ai/texra-action/review@<full-commit-sha>` — and bump it
deliberately.
:::

## Picking a model

You can skip this entirely — by default TeXRA picks a sensible model for
whichever provider key you set, trying providers in this order: **DeepSeek →
Anthropic → OpenAI → Google → OpenRouter → xAI**.

The built-in defaults:

| Provider   | Default model  |
| ---------- | -------------- |
| DeepSeek   | `deepseekproT` |
| Anthropic  | `opus48T`      |
| OpenAI     | `gpt55`        |
| Google     | `gemini31p`    |
| OpenRouter | `gptoss`       |
| xAI        | `grok4`        |

To override, add a repo **variable** — same place as secrets, but the
**Variables** tab (Settings → Secrets and variables → Actions → **Variables**
→ **New repository variable**). Variables are plain, non-secret settings:

- `TEXRA_REVIEW_MODEL` — pin one model id for every review, regardless of
  provider.
- `TEXRA_REVIEW_MODEL_DEFAULTS` — JSON map from provider id to default model
  id, used when you want provider-specific defaults. Example:
  `{"deepseek":"deepseekproT","anthropic":"opus5T"}`. This explicitly opts
  Anthropic reviews into Opus 5; the action's built-in default remains `opus48T`.

The scaffolded workflow already passes both variables through, so adding the
variable is all it takes.

::: info Migrating from older setups
Older per-provider variables such as `TEXRA_REVIEW_DEEPSEEK_MODEL` are no
longer read by the external action. Move those values into
`TEXRA_REVIEW_MODEL_DEFAULTS`.
:::

## Writing your own review prompt

Out of the box, the action reviews with its bundled general-purpose prompt. If
you want reviews tailored to your project — "focus on the math", "enforce our
naming conventions", "be terse" — you can supply your own prompt file that
replaces the bundled one.

There is one security rule to understand first: **read the prompt from the
trusted base branch, not from the PR being reviewed.** The prompt is the
reviewer's instructions. If the workflow read it from the PR's own checkout, any
PR could rewrite the instructions — for example to "approve everything" — before
being reviewed. The pattern below checks the prompt out from the PR's _base_
commit, so a PR can propose prompt changes but they only take effect after
they're merged.

1. Add your prompt at `.github/prompts/texra-code-review-prompt.md` on your
   default branch. Start from the bundled prompt in
   [`texra-ai/texra-action`](https://github.com/texra-ai/texra-action) and edit
   the review-focus parts — the prompt file fully replaces the bundled
   instructions, so keep the parts describing the expected JSON review output
   intact.
2. In the workflow, add a second checkout step after "Checkout pull request":

   ```yaml
   - name: Checkout trusted review prompt
     if: steps.keys.outputs.present == 'true' && steps.merge-ref.outputs.available == 'true'
     uses: actions/checkout@v6
     with:
       ref: ${{ github.event.pull_request.base.sha }}
       path: .trusted-review-prompt
       sparse-checkout: .github/prompts/texra-code-review-prompt.md
       sparse-checkout-cone-mode: false
       persist-credentials: false
   ```

3. Point the review step at the trusted copy by adding one input:

   ```yaml
   prompt-file: .trusted-review-prompt/.github/prompts/texra-code-review-prompt.md
   ```

To go back to the bundled prompt, remove the `prompt-file` input and the extra
checkout step.

## Pinning the TeXRA CLI version

By default the workflow installs the latest published `texra` CLI on each run.
To pin a specific version (e.g. for reproducibility), set the
`TEXRA_CLI_VERSION` repository variable to the version you want — `0.38.2`,
`latest`, or empty for latest.

## Everyday controls

### Pausing reviews

Set the repository variable `TEXRA_REVIEW_ENABLED` to `false` to pause TeXRA
reviews without removing the workflow file. Set it back to anything else (or
unset it) to resume.

### Letting TeXRA resolve its own threads

With `resolve-threads: 'true'` on the review step (as in the richer examples
under [`texra-ai/texra-action`](https://github.com/texra-ai/texra-action)),
the TeXRA GitHub App can resolve fixed findings and reply to earlier threads
under the same bot identity. No personal access token is needed.

### Choosing whose PRs get reviewed

`require-write-access: 'true'` limits reviews to PRs authored by users with
write access, so outside accounts can't spend your API budget. Allow-list
trusted bots with `allow-bots` (comma-separated), for example
`dependabot[bot]`.

## Troubleshooting

### My PR didn't get a review

Work down this checklist — each item maps to a quiet skip:

1. **Is the workflow on the default branch?** PRs only trigger it once
   `.github/workflows/texra-code-review.yml` exists on your default branch
   (usually `main`), or the PR itself contains it.
2. **Is the PR from a fork?** Fork PRs are skipped — secrets aren't shared
   with forks (see the warning above).
3. **Is the secret named exactly right?** A typo like `ANTHROPIC_KEY` means no
   key is found; the run logs a "no model provider API key" notice and skips.
4. **Does the PR have a merge conflict?** GitHub can't produce a merge preview
   for conflicted PRs, so there is nothing to review; resolve the conflict and
   push.
5. **Is `TEXRA_REVIEW_ENABLED` set to `false`?** Unset it or set it to `true`.
6. **Does the PR author have write access?** With `require-write-access`
   enabled, PRs from non-writers (and non-allow-listed bots) are skipped.

In every case the **Actions** tab shows the run (or its absence) and a notice
explaining the skip.

### The check failed

If the model provider or CLI run fails, the action fails the workflow check
instead of posting a fallback review. Treat that failed check as the signal
that no review was completed. Open the run log from the **Actions** tab to see
the error — common causes are an expired or out-of-credit API key and provider
outages. Use **Re-run failed jobs** on the run page to try again.

### Common questions

**Where does my code go?** From GitHub's runner directly to the model provider
your key belongs to — nowhere else. No TeXRA service sees your code or diffs.

**What does it cost?** Whatever your provider charges for the tokens in the
review call — billed to your API key like any other usage. No TeXRA account or
subscription is involved.

**Can I add keys for several providers?** Yes. TeXRA uses the first available
provider in its default order (DeepSeek → Anthropic → OpenAI → Google →
OpenRouter → xAI), or exactly what you pin via `TEXRA_REVIEW_MODEL`.

## Next Steps

- [TeXRA CLI](./texra-cli.md) — the `texra` command the action runs under the hood.
- [Built-in Agents](./built-in-agents.md#review) — what the `review` agent checks.
