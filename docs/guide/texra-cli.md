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
current workspace. Command-line flags override environment variables,
environment variables override the workspace file, and the workspace file
overrides built-in defaults.

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

## Validation

The CLI build performs type checking, architecture checks, bundling, and resource
copying:

```bash
corepack pnpm --filter @texra-ai/cli build
```

For a deterministic local run check that does not require provider credentials:

```bash
corepack pnpm --filter @texra-ai/cli validate:run
```
