<script setup>
import CliChatHero from '../.vitepress/components/CliChatHero.vue';
import CliAuthModesHero from '../.vitepress/components/CliAuthModesHero.vue';
import CliToolsListHero from '../.vitepress/components/CliToolsListHero.vue';
import ConfigPrecedenceStack from '../.vitepress/components/ConfigPrecedenceStack.vue';
</script>

# TeXRA CLI

The TeXRA CLI provides a local `texra` command for running TeXRA agents from a
terminal. It is published to npm as [`@texra-ai/cli`](https://www.npmjs.com/package/@texra-ai/cli).

## Install From npm

Install the CLI globally (requires Node.js >=22.9.0):

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
texra run correct --input appendices.tex --context Draft0.tex --context refs.bib
```

Pass multiple inputs with repeated `--input` flags, a directory, or a glob.
Directory inputs expand recursively to `.tex` files. Multi-input runs can copy
their generated artifacts to a directory with `--output-dir`; relative document
paths are preserved under that directory:

```bash
texra run polish --input Draft0.tex --input appendices.tex --output-dir polished
texra run correct --input 'paper/**/*.tex' --output-dir corrected
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

You can run the CLI either with a TeXRA sign-in (included hosted access) or
with your own provider API keys — whichever you prefer.

<CliAuthModesHero />

<p class="hero-caption">Two credential paths: included hosted access after <code>texra login</code>, or your own provider keys via env vars. <code>--api-mode personal</code> flips a single run to your key even while signed in.</p>

**Sign in with GitHub or Google** to use included access without managing keys:

```bash
texra login                 # pick GitHub or Google, then sign in via browser
texra login github          # choose the OAuth provider explicitly
texra login --no-browser    # print the loopback sign-in URL
```

When run interactively, a bare `texra login` asks which provider to use instead of
silently defaulting.

`--no-browser` still uses a local callback server. Open the printed URL in a
browser that can reach the terminal session; SSH and container sessions may need
callback port forwarding.

```bash
texra auth                  # same as `texra auth status`
texra auth status           # who am I signed in as?
texra auth usage            # how much of my included quota have I used?
texra logout
```

`texra auth` on its own reports your account status and accepts the same flags
as `texra auth status`, such as `--output-format json`.

**Bring your own provider keys.** Set the right environment variable for the
provider you want to use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, …), then run the CLI normally:

```bash
export ANTHROPIC_API_KEY=sk-…
texra run polish --input paper.tex
```

If you're signed in **and** want this particular run to use your own key
instead of hosted access, add `--api-mode personal`.

The CLI doesn't read `.env` files automatically. If you already keep keys
there, load them into the shell first (in bash/zsh: `set -a; . .env; set +a`).

Run `texra doctor` any time to see which dependencies are detected, who you're
signed in as, and which models the CLI can reach with the current credentials.

## Interactive Chat

`texra chat` opens an interactive tool-use session in the terminal. It streams
reasoning, tool calls, and diffs, and writes to the same run history as the VS
Code extension.

<CliChatHero />

<p class="hero-caption">A <code>texra chat</code> session streams reasoning and tool calls inline, shows diffs as the agent edits, and lists its slash commands at the bottom.</p>

```bash
texra chat                          # default chat agent and model
texra chat --agent research         # pick a tool-use agent for the session
texra chat --model deepseekT        # override the session model
```

Slash commands inside the session: `/tools` lists and toggles integrations,
`/api` switches between hosted and personal-key access, `/model` switches to
another model from the same provider mid-session (the change applies
immediately and persists on resume), `/skills` lists available skills and
applies one to your next request, and `/resume` restores a stored execution.
Chat requires an interactive terminal — for scripted, non-TTY runs use
`texra run` with `--print` or `--output-format json|ndjson`.

## Multi-Agent Teams

The CLI can list, inspect, and run the same built-in team presets as the
extension's Multi-Agent settings tab — Lean Project, Physicist, Mathematician,
Computer Scientist (ML), and Software Engineer:

```bash
texra multi-agent list
texra multi-agent inspect software-engineer
texra multi-agent run software-engineer --instruction "Profile and speed up scripts/simulate.py"
```

`run` starts the team's orchestrator, which plans the work and delegates to its
specialists. For example, the Software Engineer team's `engineer` lead delegates
to `coder`, `codeReviewer`, `testEngineer`, `codeSimplifier`, and
`progressCheck`. Pass `--input` and `--context` files as with `texra run`;
read-only context files are included in the instruction the team receives.

In an interactive team session, focusing a subagent shows only its own
transcript — scroll back through its earlier output with normal terminal
scrolling and search. Each subagent keeps its own scoped history that persists
across sessions, and resuming a subagent continues it where it left off.

## Skills

Skills are reusable instruction folders the agent can apply to a request. List
what's available, and pull in extra skill folders for any agent run:

```bash
texra skills list
texra run polish --input paper.tex --source ~/my-skills
texra chat --include-interop
```

`--source` (alias `-s`) adds an additional skill root and may be repeated;
`--include-interop` also includes `.agents`, `.claude`, `.codex`, and `.gemini`
skill folders from the workspace and home directory. When skills share a name,
project and user skills take precedence over bundled ones. In chat, pick a
skill with `/skills` to apply it to your next request.

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
texra history list --limit 10        # only the most recent runs (alias: -n)
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
detection result.

<CliToolsListHero />

<p class="hero-caption"><code>tools list</code> reports five fields per integration: a status dot marks enabled vs disabled, and a check or cross marks whether the backing tool was detected on this machine.</p>

Use `--output-format json` or `--output-format ndjson` for
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

<ConfigPrecedenceStack />

<p class="hero-caption">Resolution order, highest priority on top: a CLI flag beats its <code>TEXRA_*</code> env var, which beats the <code>.texra/config.json</code> key, which beats the built-in default (<code>deepseekT</code>).</p>

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
included hosted access. `--api-mode included` keeps the default hosted behavior
when the account is signed in. The accepted aliases match the TUI `/api`
command: for example, `direct`, `api`, and `byok` select personal API keys,
while `included` selects hosted access.
