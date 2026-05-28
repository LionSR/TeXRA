# TeXRA CLI

The TeXRA CLI provides a local `texra` command for running TeXRA agents from a
terminal. It is published to npm as [`@texra-ai/cli`](https://www.npmjs.com/package/@texra-ai/cli).

## Install From npm

Install the CLI globally (requires Node.js 22 or newer):

```bash
npm install -g @texra-ai/cli
```

Verify the command:

```bash
texra --help
texra version
texra agents list
```

## Running Agents

Run a workflow agent from a project directory:

```bash
texra run polish --input paper.tex --output paper.polished.tex --print
```

Pass read-only context files with repeated `--context` flags. The agent can
read these files through `{{ ALL_CONTEXTS }}`, but it should only emit revised
documents for the selected inputs:

```bash
texra run firstread --input appendices.tex --context Draft0.tex --context refs.bib
```

Pass multiple inputs with repeated `--input` flags, a directory, or a glob.
Directory inputs expand recursively to `.tex` files. Multi-input runs can copy
their generated artifacts to a directory with `--output-dir`; relative document
paths are preserved under that directory:

```bash
texra run firstread --input Draft0.tex --input appendices.tex --output-dir flagged
texra run logic --input 'paper/**/*.tex' --output-dir logic-pass
```

Workflow agents always write generated files into the execution's run-storage
directory first. In text mode, TeXRA prints a filesystem path: the copied path
when `--output` or `--output-dir` is used, otherwise the final generated file in
run storage.

With `--output`, TeXRA also copies the final artifact to the requested
filesystem destination. JSON and NDJSON output keep `outputs[]` as the
run-storage source of truth (`relativePath`, `absolutePath`, and `location`),
include `runDirectory`, include `copiedOutput` or `copiedOutputs` when a
filesystem copy was written, and report `terminalStatus` for the completed run.

## Authentication

You can run the CLI either with a TeXRA sign-in (included relay access) or
with your own provider API keys — whichever you prefer.

**Sign in with GitHub or Google** to use included access without managing keys:

```bash
texra login                 # opens a browser to complete sign-in
texra login github          # choose the OAuth provider explicitly
texra login --no-browser    # print the sign-in URL if no browser is available
```

```bash
texra auth status           # who am I signed in as?
texra auth usage            # how much of my included quota have I used?
texra logout
```

**Bring your own provider keys.** Set the right environment variable for the
provider you want to use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, …), then run the CLI normally:

```bash
export ANTHROPIC_API_KEY=sk-…
texra run polish --input paper.tex
```

If you're signed in **and** want this particular run to use your own key
instead of relay access, add `--api-mode personal`.

The CLI doesn't read `.env` files automatically. If you already keep keys
there, load them into the shell first (in bash/zsh: `set -a; . .env; set +a`).

Run `texra doctor` any time to see which dependencies are detected, who you're
signed in as, and which models the CLI can reach with the current credentials.

## Interactive Chat

`texra chat` opens an interactive tool-use session in the terminal. It streams
reasoning, tool calls, and diffs, and writes to the same run history as the VS
Code extension.

```bash
texra chat                          # default chat agent and model
texra chat --agent research         # pick a tool-use agent for the session
texra chat --model deepseekT        # override the session model
```

Slash commands inside the session: `/tools` lists and toggles integrations,
`/api` switches between relay and personal-key access, and `/resume` restores a
stored execution. Chat requires an interactive terminal — for scripted, non-TTY
runs use `texra run` with `--print` or `--output-format json|ndjson`.

## Shell Completion

TeXRA can print completion scripts for Bash, Zsh, and Fish:

```bash
texra completion bash >> ~/.bashrc
texra completion zsh > "${fpath[1]}/_texra"
texra completion fish > ~/.config/fish/completions/texra.fish
```

Restart the shell, or source the file you updated. Completion includes
subcommands, flags, enum values such as `--output-format text|json|ndjson`,
agent names for `texra run <TAB>`, and model names for `--model <TAB>`.

Agent and model completion call back into `texra agents list` and
`texra models list`. Disable those dynamic lookups in slow shells with:

```bash
export TEXRA_COMPLETION_DYNAMIC=0
```

## Execution History

TeXRA stores completed executions in the workspace run store. List recent runs:

```bash
texra history list
texra history list --output-format ndjson
```

Text output prints one tab-separated row per execution:

```text
<id>    <timestamp>    <agent>    <status>    <primary input>
```

The NDJSON form is stable for scripts. Each line has kind `history-entry` and
contains the same execution entry object used by JSON output.

Inspect or delete one execution:

```bash
texra history show <id>
texra history delete <id>
```

Resume a stored execution configuration headlessly:

```bash
texra resume <id>
texra --resume <id>
```

The interactive chat also accepts `/resume`. With no id it prints recent
executions; with an id it starts from the stored execution configuration. A
missing or malformed id exits with code 2 in headless commands.

## Tools and Integrations

The CLI can inspect the same external agent integrations shown in the extension
settings:

```bash
texra tools list
texra tools status codex
texra tools disable codex
texra tools enable codex
texra tools install codex
texra tools auth codex
```

`tools list` reports each integration id, name, category, enabled state, and
detection result. Use `--output-format json` or `--output-format ndjson` for
scripts. `tools install <id>` prints the install guide and registered command;
it only runs the command when passed `--run`. In the interactive TUI, `/tools`
opens the same integration list and toggles integrations that support enabling
or disabling.

## Workspace Defaults

The CLI reads optional, non-secret defaults from `.texra/config.json` in the
current workspace. Scaffold one with `texra init` (add `--yes` to accept
defaults non-interactively, or `--gitignore` to add `.texra/` to `.gitignore`).
Command-line flags override environment variables, environment variables
override the workspace file, and the workspace file overrides built-in
defaults.

```json
{
  "model": "deepseekT",
  "outputFormat": "text",
  "approvalPolicy": "never",
  "chat": {
    "agent": "chat",
    "model": "deepseekT"
  },
  "run": {
    "model": "deepseekT"
  }
}
```

Supported top-level keys are `agent`, `model`, `outputFormat`, and
`approvalPolicy`; `chat` and `run` may set command-specific `agent` and `model`
defaults. The built-in CLI model default is `deepseekT`.

The corresponding environment variables are `TEXRA_AGENT`, `TEXRA_MODEL`,
`TEXRA_OUTPUT_FORMAT`, `TEXRA_APPROVAL_POLICY`, and `TEXRA_API_MODE`. Run
`texra doctor` to see which workspace config file was loaded and whether any
keys were ignored.

Use `--api-mode personal` or `TEXRA_API_MODE=personal` to force a `run` or
`chat` invocation to use provider API keys even when the CLI is signed in for
included relay access. `--api-mode included` keeps the default relay behavior
when the account is signed in. The accepted aliases match the TUI `/api`
command: for example, `direct`, `api`, and `byok` select personal API keys,
while `relay` selects included access.
