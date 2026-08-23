<script setup>
import CliChatHero from '../.vitepress/components/CliChatHero.vue';
import CliToolsListHero from '../.vitepress/components/CliToolsListHero.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
import CliMultiAgentHero from '../.vitepress/components/CliMultiAgentHero.vue';
import ConfigPrecedenceStack from '../.vitepress/components/ConfigPrecedenceStack.vue';
</script>

# TeXRA CLI

The TeXRA CLI brings TeXRA's theorist agents to the terminal: a local `texra`
command for chatting with an agent, running long autonomous attempts at a
problem, launching specialist teams, and running document workflows over your
project. It is published to npm as [`@texra-ai/cli`](https://www.npmjs.com/package/@texra-ai/cli).

## Install

Install the CLI globally from npm (requires Node.js >=22.9.0):

```bash
npm install -g @texra-ai/cli
```

Or with [Homebrew](https://github.com/texra-ai/homebrew-tap) on macOS and
Linux, which installs Node.js for you if needed:

```bash
brew install texra-ai/tap/texra
```

Verify the command:

```bash
texra --help
texra version
texra agents list
texra config
```

For a guided first run, use `texra setup`. It walks you through sign-in
(TeXRA account, ChatGPT subscription, or an API key), checks your
environment, shows the agent roster, and starts your first task:

```bash
texra setup
```

Working from an Overleaf or ShareLaTeX project? Clone it into a directory
first, by URL, git URL, or 24-character project id:

```bash
texra clone <project> --cwd ./paper
```

## Running agents

Run a workflow agent from a project directory:

```bash
texra run polish --input paper.tex --output paper.polished.tex --print
```

<CliRunHero
  command="texra run polish --input paper.tex --output paper.polished.tex --print"
  :rounds="[
    { label: 'r0: draft revision', state: 'done' },
    { label: 'r1: critique and revise', state: 'done' },
  ]"
  :outputs="['paper.polished.tex']"
/>

<p class="hero-caption">Command in, rounds stream as progress, and the printed path is the success signal: the copied <code>--output</code> destination, or the generated file in run storage when no copy was requested.</p>

Workflow agents that take an instruction, such as `polish`, accept it with
`--instruction <text>` or `--instruction-file <file>`. When both are set, the
file contents are passed first:

```bash
texra run polish --input paper.tex --instruction "Tighten the proof of Lemma 2"
texra run polish --input paper.tex --instruction-file notes.md
```

Pass read-only context files with repeated `--context` flags. The agent can
read these files through `{{ ALL_CONTEXTS }}`, but it only emits revised
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
filesystem copy was written, and report the completed run's canonical
`outcome`.

Final run result objects report their terminal state through `outcome`.
Streamed NDJSON progress records continue to use status fields for live
progress.

## Authentication

Model calls run on your own provider API keys, or on a provider subscription
you already pay for. Signing in to TeXRA is a separate, optional step that
unlocks the hosted research-agent catalog.

**Bring your own provider keys.** Set the environment variable for the
provider you want to use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, …), then run the CLI normally:

```bash
export ANTHROPIC_API_KEY=sk-…
texra run polish --input paper.tex
```

The CLI doesn't read `.env` files automatically. If you already keep keys
there, load them into the shell first (in bash/zsh: `set -a; . .env; set +a`).

**Use a provider subscription.** ChatGPT, Grok (xAI), Kimi Code, and the GLM
Coding Plan can serve model calls in place of an API key:

```bash
texra auth chatgpt login    # Codex models through your ChatGPT plan
texra auth grok login       # Grok models through an xAI subscription
```

Inside a chat, `/api` manages the same preferences: `/api chatgpt`, `/api grok`,
`/api kimi-code`, and `/api glm-code` set which subscription serves its
provider's models, and `/api status` prints how each model will be paid for.

**CI pipelines.** Headless pipelines can't sign in interactively. Store the
provider API key as a CI secret and export it in the pipeline environment.
With a provider key set, `texra run …` needs no other credentials.

**Sign in to TeXRA (Researcher Access)** to use the hosted research-agent
catalog. Remote agents then resolve by name like any local agent. Sign-in does
not supply model access; runs still use the credentials above.

```bash
texra login                 # pick GitHub or Google, then sign in via browser
texra login github          # choose the OAuth provider explicitly
texra login --no-browser    # print the loopback sign-in URL
texra login --device        # device code: approve from a browser on any device
```

When run interactively, a bare `texra login` asks which provider to use instead of
silently defaulting. If you use multiple accounts, `--select-account` forces
the OAuth account chooser and `--login-hint <email>` suggests which account to
use.

`--no-browser` still uses a local callback server. Open the printed URL in a
browser that can reach the terminal session; SSH and container sessions may need
callback port forwarding.

`--device` needs no callback at all: the CLI prints a short code and a
verification URL. Open the URL in a browser on any device, including your
phone, sign in, and approve the code. This is the recommended path on SSH,
WSL2, and containers. The interactive pickers offer it automatically when they
detect a remote session.

```bash
texra auth                  # same as `texra auth status`
texra auth status           # who am I signed in as?
texra logout
```

`texra auth` on its own reports your account status and accepts the same flags
as `texra auth status`, such as `--output-format json`.

Run `texra doctor` at any time to see which dependencies are detected, who you
are signed in as, and which models the CLI can reach with the current
credentials.

## Interactive chat

`texra chat` opens an interactive tool-use session in the terminal. It streams
reasoning, tool calls, and diffs, and writes to the same run history as the VS
Code extension.

<CliChatHero />

<p class="hero-caption">A <code>texra chat</code> session streams reasoning and tool calls inline, shows diffs as the agent edits, and lists its slash commands at the bottom.</p>

```bash
texra chat                          # default chat agent and model
texra chat --agent research         # pick a tool-use agent for the session
texra chat --model deepseekT        # override the session model
# headless tool-use run for scripts and CI
texra agents run review --input main.tex --instruction "Check the proof." --print
```

Slash commands inside the session: `/tools` lists and toggles integrations,
`/api` sets which provider subscriptions serve their models and reports how
each model will be paid for, `/model` switches to
another model from the same provider mid-session (the change applies
immediately and persists on resume), `/skills` lists available skills and
applies one to your next request, and `/resume` restores a stored execution.
Chat requires an interactive terminal. For scripted, non-TTY runs use
`texra agents run <agent>` with `--print` or
`--output-format json|ndjson`. It accepts workspace `--input` and `--context`
files plus an `--instruction` prompt for the tool-use agent. Use `texra run`
for workflow agents that take input files and produce document-oriented
outputs.

## Multi-agent teams

The CLI can list, show, and run the same built-in teams as the
extension's Teams settings tab: Lean Project, Physicist, Mathematician,
Computer Scientist, and Software Engineer.

```bash
texra multi-agent list
texra multi-agent show software-engineer
texra multi-agent run software-engineer --instruction "Profile and speed up scripts/simulate.py"
```

`run` starts the team's orchestrator, which plans the work and delegates to its
specialists. For example, the Software Engineer team's `engineer` lead delegates
to `coder`, `codeReviewer`, `testEngineer`, and `codeSimplifier`. Pass `--input`
and `--context` files as with `texra run`;
read-only context files are included in the instruction the team receives.
When the work splits cleanly, the lead can fan it out as a scripted
[multi-agent workflow](./multi-agent-workflows.md).

<CliMultiAgentHero />

<p class="hero-caption">The lead delegates while child agents stream below it as numbered subagent rows. Each one is a focusable stream with its own scoped transcript.</p>

In an interactive team session, focusing a subagent shows only its own
transcript. Scroll back through its earlier output with normal terminal
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

## Shell completion

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

## Execution history

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

Continue a stored session, on the saved agent and model:

```bash
texra resume <id>
texra --resume <id>
```

A tool-use session reopens in the interactive chat and waits for your next
message, so without a terminal it exits with a usage error that points
scripting at `texra run`. A workflow run resumes headless under its original
execution id and honors the headless globals (`--print`, `--output-format`,
`--no-input`). The interactive chat also accepts `/resume`: with no id it
prints recent executions, with an id it continues the stored session. A
missing or malformed id exits with code 2.

A run another TeXRA process still holds is refused. If that process cannot be
reached (it ran on another machine, or its liveness cannot be proven), resume
says so and stops; when you are sure it is gone, `texra resume <id> --reclaim`
removes its hold and continues. A run whose holder is provably alive is never
reclaimed.

## Tools and integrations

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

<p class="hero-caption"><code>tools list</code> reports six columns per integration: a status dot marks the enabled state, a check or cross marks whether the backing tool was detected on this machine, and the note carries the registered install command when something is missing.</p>

Use `--output-format json` or `--output-format ndjson` for
scripts. `tools install <id>` prints the install guide and registered command;
it only runs the command when passed `--run`. In the interactive TUI, `/tools`
opens the same integration list and toggles integrations that support enabling
or disabling.

## Models and memories

List the models TeXRA knows about, and manage which ones appear in the
`/model` picker and the lead-model picker:

```bash
texra models list
texra models show deepseekproT
texra models enabled
texra models enable grok46
texra models disable grok46
```

Inspect the notes agents have stored for this workspace (see
[Memory](./memory.md)):

```bash
texra memory list
texra memory show memories/<file>
```

## Workspace defaults

Run `texra config` in a terminal to open the same configuration view available
from the launcher's **Settings** row and from `/config` in a chat. Its **Agents**
section has three distinct choices:

- **Workspace roster** controls which agents are available in the current
  folder. It may inherit the user default, show all agents, use a named team,
  or store an exact custom selection.
- **Default team** is a user-level choice used only by workspaces whose roster
  is set to inherit. With no default team, an inherited workspace shows all
  agents.
- **Default chat agent** is the root agent selected for new chats in this
  workspace. It is stored under `texra.chat` in `.texra/config.json` and does
  not change which agents are visible.

The corresponding non-interactive interface is `texra config agents`:

```bash
texra config agents                         # inspect the effective roster
texra config agents --all                   # show every agent in this folder
texra config agents --team lean-project     # use a named team
texra config agents --inherit               # follow the user default
texra config agents --default-team physicist
texra config agents --workflow correct,polish --tool-use assistant,review
texra config agents --default-agent builtInToolUse:assistant
```

`texra agents list` and `texra multi-agent list|show|run` keep narrower
responsibilities: they inspect or run agents and teams, but do not alter the
workspace roster. `texra init` writes initial command defaults and likewise
does not change agent visibility.

The CLI reads optional, non-secret defaults from `.texra/config.json` in the
current workspace. Scaffold one with `texra init` (add `--yes` to accept
defaults non-interactively, or `--gitignore` to add `.texra/` to `.gitignore`).
Command-line flags override environment variables, environment variables
override the workspace file, and the workspace file overrides built-in
defaults.

<ConfigPrecedenceStack />

<p class="hero-caption">Resolution order, highest priority on top: a CLI flag beats its <code>TEXRA_*</code> env var, which beats the <code>.texra/config.json</code> key, which beats the built-in default (<code>deepseekproT</code>).</p>

```json
{
  "texra.model": "deepseekproT",
  "texra.outputFormat": "text",
  "texra.approvalPolicy": "never",
  "texra.chat": {
    "agent": "assistant",
    "model": "deepseekproT"
  },
  "texra.run": {
    "model": "deepseekproT"
  }
}
```

Supported top-level keys are `texra.agent`, `texra.model`,
`texra.outputFormat`, and `texra.approvalPolicy`; `texra.chat` and `texra.run`
may set command-specific `agent` and `model` defaults. Shared TeXRA settings
the CLI honors, such as `texra.telemetry.enabled`, are also accepted. The
built-in CLI model default is `deepseekproT`.

The corresponding environment variables are `TEXRA_AGENT`, `TEXRA_MODEL`,
`TEXRA_OUTPUT_FORMAT`, and `TEXRA_APPROVAL_POLICY`. Run
`texra doctor` to see which workspace config file was loaded and whether any
keys were ignored.

Two more switches live in the environment:

| Variable                              | Effect                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TEXRA_NO_TELEMETRY` / `DO_NOT_TRACK` | Turn off usage logging for rounds billed to your own API key ([Usage logging](./configuration.md#usage-logging)) |
| `TEXRA_NO_UPDATE_CHECK`               | Skip the daily check for a newer `texra` release (environment-only)                                              |

Usage logging can also be turned off in the workspace file with
`"texra.telemetry.enabled": false` in `.texra/config.json` (`texra doctor`
prints this hint). The environment variables override a stored `true`, but
not the reverse: they can only switch logging off.

Both take `1`, `true`, or any other value; `0`, `false`, `no`, `off`, empty,
and unset mean "leave it on".
