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

**Included access** — sign in with GitHub or Google:

```sh
texra login          # opens a browser; use --no-browser to print the URL
texra auth status    # confirm sign-in and included usage
```

**Personal API keys** — bring your own provider keys and select personal mode:

```sh
export ANTHROPIC_API_KEY=...   # or OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, ...
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

## Building from source

Contributors building the CLI from a repository checkout should follow the
developer guide at `docs/guide/texra-cli.md`.

## License

Proprietary — all rights reserved. Use is governed by the TeXRA terms of
service. See [LICENSE.txt](./LICENSE.txt) and <https://texra.ai/terms>.
