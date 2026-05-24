# @texra-ai/cli

TeXRA CLI — an AI-powered LaTeX research assistant for the terminal. Run TeXRA's
writing, reviewing, and document-processing agents against your `.tex` projects
without leaving the shell.

## Install

```sh
npm install -g @texra-ai/cli
texra --help
```

Requires Node.js >= 22. The published command is a self-contained bundle —
runtime libraries are inlined into the binary, so the install needs no extra
build step.

## Authenticate

You can use TeXRA's included relay access, or your own provider API keys.

**Researcher Access Program (included access)** — sign in for complimentary
access to budget-friendly models, no API keys required:

```sh
texra login          # opens a browser; use --no-browser to print the URL
texra auth status    # confirm sign-in and included usage
```

**Personal API keys** — bring your own provider keys. Set them in the
environment or a workspace `.env` file (loaded automatically), then select
personal mode:

```env
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GOOGLE_API_KEY=your_google_key_here
DEEPSEEK_API_KEY=your_deepseek_key_here
XAI_API_KEY=your_xai_key_here
OPENROUTER_API_KEY=your_openrouter_key_here
```

Other providers follow the same `<PROVIDER>_API_KEY` convention
(`MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, `MINIMAX_API_KEY`, `GLM_API_KEY`).
Add `--api-mode personal` to a run to force your own keys:

```sh
texra run polish --input paper.tex --api-mode personal
```

Verify your environment, sign-in state, available models, and LaTeX toolchain at
any time:

```sh
texra doctor
```

## Quick start

Polish a LaTeX document and print the result path:

```sh
texra run polish --input paper.tex --output paper.polished.tex --print
```

Start an interactive tool-use chat in the current project:

```sh
texra chat
```

See what is available:

```sh
texra agents list     # workflow + tool-use agents
texra models list     # configured models
```

## Running workflow agents

```sh
texra run <agent> --input <file> [--input <file> ...] [options]
```

- Pass multiple `--input` flags, a directory (expands to `.tex` recursively), or
  a glob.
- Pass read-only `--context` files the agent can read but will not rewrite.
- Use `--output <file>` (single input) or `--output-dir <dir>` (multi-input) to
  copy generated artifacts to the filesystem; otherwise results stay in
  run storage and the path is printed.
- Use `--output-format text|json|ndjson` for scriptable output, and `--print`
  for non-interactive runs.

```sh
texra run firstread --input Draft0.tex --context refs.bib --output-dir flagged
texra run logic --input 'paper/**/*.tex' --output-dir logic-pass --output-format ndjson
```

## Execution history

```sh
texra history list                 # add --output-format ndjson for scripts
texra history show <id>
texra resume <id>                  # re-run a stored execution configuration
```

## Workspace defaults

Place optional, non-secret defaults in `.texra/config.json` in your project:

```json
{
  "model": "deepseekT",
  "outputFormat": "text",
  "approvalPolicy": "never",
  "chat": { "agent": "chat", "model": "deepseekT" },
  "run": { "model": "deepseekT" }
}
```

Precedence: command-line flags override environment variables, which override
this file, which overrides built-in defaults. Supported environment variables
are `TEXRA_AGENT`, `TEXRA_MODEL`, `TEXRA_OUTPUT_FORMAT`, `TEXRA_APPROVAL_POLICY`,
and `TEXRA_API_MODE`.

## Shell completion

```sh
texra completion bash >> ~/.bashrc
texra completion zsh  > "${fpath[1]}/_texra"
texra completion fish > ~/.config/fish/completions/texra.fish
```

Completion covers subcommands, flags, enum values, agent names, and model names.

## Support & Feedback

Report issues and feature requests on the
[GitHub issues page](https://github.com/texra-ai/texra-issues/issues) or email
[contact@texra.ai](mailto:contact@texra.ai). See [texra.ai](https://texra.ai)
and the [documentation](https://texra.ai/guide/) for tutorials and agent
recipes.

## License

© TeXRA Team 2025–2026. All rights reserved. Use is governed by the TeXRA terms
of service. See [LICENSE.txt](./LICENSE.txt) and <https://texra.ai/terms>.
