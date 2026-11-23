<script setup>
import CliChatHero from '../.vitepress/components/CliChatHero.vue';
import CliRunHero from '../.vitepress/components/CliRunHero.vue';
import CliSubagentsHero from '../.vitepress/components/CliSubagentsHero.vue';
import ConfigPrecedenceStack from '../.vitepress/components/ConfigPrecedenceStack.vue';
</script>

# TeXRA CLI

The TeXRA CLI brings TeXRA's assistant to the terminal: a local `texra`
command for chatting with it, running long autonomous attempts at a problem,
and running [programs](./programs.md) over your project. It is published to npm as [`@texra-ai/cli`](https://www.npmjs.com/package/@texra-ai/cli).

## Install

Install the CLI globally from npm (requires Node.js 22.22.2 or later in 22.x, or Node.js 24.15 or later):

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
texra config
```

Run `texra` with no model connected and the chat still opens, with a
**Connect a model** panel in front: sign in with a ChatGPT or Grok
subscription, or add a provider API key. A message typed before you connect
is sent as soon as you do.

For a guided first run, use `texra setup`. It walks you through sign-in
(a ChatGPT or Grok subscription, or an API key), checks your
environment, and starts your first task:

```bash
texra setup
```

Working from an Overleaf or ShareLaTeX project? Clone it into a directory
first, by URL, git URL, or 24-character project id:

```bash
texra clone <project> ./project
```

## Running programs

`texra run <program>` runs one of the [programs](./programs.md) over `--input`
files, without a chat. The document programs (`edit`, `annotate`, `enhance`,
`apply`, `transcribe`, `slides`, `poster`) revise or create
documents; the task programs (`review`, `search`, `derive`, `code`,
`review-code`, `simplify`, `test`, `experiment`, `solve`, `fix-latex`,
`latexdiff`) answer with a report; the Lean programs `prove`,
`lean-simplify` and `blueprint` work on a Lean project's files in place, and
`lean-search` reports what Mathlib and the project already have. Every program needs at least one
`--input`. Run one from a project directory:

```bash
texra run edit --input paper.tex --instruction "Polish the prose" --output paper.polished.tex --print
```

<CliRunHero
  command="texra run edit --input paper.tex --instruction 'Polish the prose' --output paper.polished.tex --print"
  :rounds="[
    { label: 'Revision 1: draft', state: 'done' },
    { label: 'Revision 2: review and correct', state: 'done' },
  ]"
  :outputs="['paper.polished.tex']"
/>

<p class="hero-caption">Command in, revisions stream as progress, and the printed path is the success signal: the copied <code>--output</code> destination, or the generated file in run storage when no copy was requested.</p>

The instruction says what the program should do: how far `edit` goes (with no
instruction it proofreads), which point of view `annotate` reads from, what
`review` should check. Pass it with `--instruction <text>` or
`--instruction-file <file>`. When both are set, the file contents are passed
first:

```bash
texra run edit --input paper.tex --instruction "Tighten the proof of Lemma 2"
texra run annotate --input paper.tex --instruction "Read as a first-time reader"
texra run edit --input paper.tex --instruction-file notes.md
```

Supported media files passed with `--input` are attached to the model instead
of being read as text. Audio transcription requires a model with native audio
support:

```bash
texra run transcribe --input recording.m4a --output transcript.tex --model google/gemini-4-argon --print
```

Text inputs retain their usual behavior. You can combine text and media with
repeated `--input` flags; `--context` supplies read-only text context.
For programs that edit their inputs, media attachments do not count as output documents.

Pass read-only context files with repeated `--context` flags. The program
reads these files, but it only emits revised documents for the selected
inputs:

```bash
texra run edit --input appendices.tex --context Draft0.tex --context refs.bib
```

Pass multiple inputs with repeated `--input` flags, a directory, or a glob.
Directory inputs expand recursively to `.tex` files. Multi-input runs can copy
their generated artifacts to a directory with `--output-dir`; relative document
paths are preserved under that directory:

```bash
texra run edit --input Draft0.tex --input appendices.tex --instruction "Polish the prose" --output-dir polished
texra run edit --input 'sections/**/*.tex' --output-dir corrected
```

Programs always write generated files into the run's run-storage
directory first. In text mode, TeXRA prints a filesystem path: the copied path
when `--output` or `--output-dir` is used, otherwise the final generated file in
run storage. A program that generates no document, such as `prove`, prints its
final reply instead, as does a task program such as `review`.

With `--output`, TeXRA also copies the final artifact to the requested
filesystem destination. JSON and NDJSON output keep `output.documents.outputs[]` as the
run-storage source of truth (`relativePath`, `absolutePath`, and `location`),
include `runDirectory`, include `copiedOutput` or `copiedOutputs` when a
filesystem copy was written, and report the completed run's canonical
`outcome`.

Final run result objects report their terminal state through `outcome` and name
the run through `runId`. A `texra run` result also records the plugins it ran
with: `plugins` lists the installed plugins that loaded when it started or
resumed, enabled and trusted (`name`, `source`, and for a fetched plugin its
`ref` and pinned `commit`). The
tools a run offered can change between its model requests when a plugin is
switched on or off; the run records each change in its history.

### NDJSON contract, version 3

Every `--output-format ndjson` line is one JSON object whose first key is
`kind`, followed by the record's own fields, a `ts` timestamp, and
`contract: 3` (the 1.0 contract version):

- `kind: "progress"` carries a session event verbatim, with `event` set to the
  event's `type` (`run.start`, `run.activate`, `run.end`, `usage`, `stage.start`,
  `tool.start`, `run.description`, `run.removed`, and so on) and `payload`
  holding the remaining fields:
  - **Identity & outcomes:** Run events identify their run via
    `payload.aggregateId` (plugin-owned events use a `plugin:` key instead).
    Parent edges appear on `run.start` as `payload.parent`; terminal outcomes
    appear on `run.end` as `outcome`.
  - **Spend:** Each `usage` event represents one priced model turn, so total
    run spend is the sum of its `usage` events.
  - **Turns, stages & scripts:** Run turns appear as `run.position` events
    (`turn.begin`, `turn.end`). A `stage.start`/`stage.end` pair marks a
    labelled span (such as a script section); any stage still open when the run
    ends closes with `run.end`. Tool calls made inside a script carry a
    `stageId` matching the enclosing `script` card's `logId`, which closes with
    its own `tool.end`.
  - **Live children (`event: "run.children"`):** The one synthetic progress event (no
    underlying session row) reports a parent's active children as
    `{ runId, children }`, where each entry carries `childRunId`, `identity`,
    `agentName`, and `status` (`running`, `waiting`, or `ready` before first
    activation). Completed children leave this list and report their outcome on
    `run.end`.
- `kind: "agent-result"` and `kind: "result"` carry the run result described
  above under `result`, with `runId`.
- History records (`history-entry`, `history-detail`) carry the run's
  `outcome` (`completed`, `cancelled`, `failed`, or `null` when none was
  recorded) and, separately, whether `texra resume` continues it
  (`continues`).

## Authentication

Model calls run on your own provider API keys, or on a provider subscription
you already pay for. There is no TeXRA account: everything ships bundled.

**Bring your own provider keys.** Set the environment variable for the
provider you want to use (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, …), then run the CLI normally:

```bash
export ANTHROPIC_API_KEY=sk-…
texra run edit --input paper.tex
```

Claude Max/Team and ChatGPT Pro/Business plans also include monthly API credits
that a standard Anthropic or OpenAI API key can spend; see
[Getting API keys](./installation.md#setting-up-api-keys).

A project's `.env` file is read by every task of that project. A key set
only in this terminal (`OPENAI_API_KEY=… texra chat`) travels with the
tasks this terminal starts, wherever they run.

**Use a provider subscription.** Kimi Code and the GLM Coding Plan are paid
through the plan's own key, added like any provider key. A ChatGPT or Grok
(xAI) subscription can serve model calls in place of an API key:

```bash
texra auth chatgpt login    # OpenAI models through your ChatGPT plan
texra auth grok login       # Grok models through an xAI subscription
```

Inside a chat, `/login` manages the same preferences: its form signs you in
or out and sets which subscription serves each provider's models, and
`/login status` prints how each model will be paid for.

**CI pipelines.** Headless pipelines can't sign in interactively. Store the
provider API key as a CI secret and export it in the pipeline environment.
With a provider key set, `texra run …` needs no other credentials.

Subscriptions sign in through `texra auth <provider> login`:

```bash
texra auth chatgpt login              # browser sign-in
texra auth chatgpt login --no-browser # print the loopback sign-in URL
texra auth chatgpt status
texra auth chatgpt logout
texra auth grok login --device        # device code: approve from a browser on any device
```

`grok` takes the same verbs. `--no-browser` still uses a local callback server.
Open the printed URL in a browser that can reach the terminal session; SSH and
container sessions may need callback port forwarding.

ChatGPT sign-in is OpenAI's "Sign in with ChatGPT" for open-source agents, and
it is browser-only: OpenAI returns the sign-in to `127.0.0.1` on the machine
running TeXRA, and `--device` signs in through the browser too. On SSH, WSL2
or a container, forward port 1455 from the machine with the browser. On the
consent page, allow TeXRA to use your ChatGPT plan; without it, sign-in stops
with an error. ChatGPT plan usage is shown in ChatGPT's own settings.

Grok's `--device` needs no callback at all: the CLI prints a short code and a
verification URL. Open the URL in a browser on any device, including your
phone, and approve the code. This is the recommended path for Grok on SSH,
WSL2, and containers.

Run `texra doctor` at any time to see which dependencies are detected and which
models the CLI can reach with the current credentials.

## Interactive chat

`texra chat` opens an interactive chat in the terminal. It streams
reasoning, tool calls, and diffs, and writes to the same run history as the VS
Code extension. Running bare `texra` in a terminal opens this same session.
While a run is working, pressing `Enter` delivers your message at its next model
step, while `Shift-Tab` holds it until the end of the current turn.

<CliChatHero />

<p class="hero-caption">A <code>texra chat</code> session streams reasoning and tool calls inline, shows diffs as the agent edits, and lists its key hints at the bottom.</p>

```bash
texra chat                                      # default model
texra chat --model deepseek/deepseek-flash@high # override the session model and effort
# one headless answer for scripts and CI
texra run chat --input main.tex --instruction "Check the proof of Lemma 2." --print
```

Slash commands inside the session:

- `/login`: sign in and choose which provider subscriptions serve their models (`/login status` prints how each model is billed).
- `/approval`: set the approval policy and revoke grants given with `a` on an approval card (`/status` lists active grants).
- `/config`: open settings and integrations.
- `/model`: switch to another model from the same provider mid-session (applies immediately and persists on resume).
- `/skills`: list available skills and apply one to your next request.
- `/resume`: restore a stored execution (`/resume all` continues every interrupted task).
- `/rename <title>`: rename the focused task.
- `/help`: list every slash command, including `/models`, `/key`, `/status`, `/plan`, `/plugins`, `/compact`, `/fork`, `/clear`, and `/exit`.
- `/tasks`: list tasks running in the [background service](#background-service) across every project. Picking one attaches to it live: Enter sends a follow-up, approval requests appear inline, and Esc detaches while the task keeps running.

`texra chat` requires an interactive terminal. For scripts and CI, use `texra run <program | chat>` with `--print` or `--output-format json|ndjson`:

- **`chat`** gives the assistant one instruction (`--instruction`, `--instruction-file`, or both; required) with optional `--input` and `--context` files, and prints its answer.
- A **program** runs over `--input` files (required), accepts `--output` / `--output-dir`, and writes versioned document outputs. A name that is neither a program nor `chat` prints the program names.

## Helper agents

For a larger job the assistant hands pieces of the work to helper agents it
sets up for each piece, or starts programs, and can fan them out in parallel
as a scripted [multi-agent workflow](./multi-agent-workflows.md):

```bash
texra run chat --instruction "Profile scripts/simulate.py, then speed up its hot loops without changing its results" --print
```

<CliSubagentsHero />

<p class="hero-caption">Helper agents stream below the assistant as numbered rows. Focus any helper agent to view its own transcript.</p>

Focusing a helper agent shows only its own transcript, which persists across sessions and can be resumed where it left off.

## Skills

Skills are reusable instruction folders the assistant can apply to a request.
Enable **Enable skills for agents** (`texra.skills.enabled`) via `texra config`
or **Settings → Agents → Skills**. List available skills or attach extra folders
with `--source` (`-s`, repeatable):

```bash
texra skills list
texra run edit --input paper.tex --source ~/my-skills
```

Imported skill folders (`.agents`, `.claude`, `.codex`, `.gemini`) start disabled
by default; toggle them under `texra config` → Skills or **Settings → Agents →
Skills** (`texra.skills.disabledSources`). Project skills live in `.texra/skills/`
and override user skills (`--source` overrides both). In chat, pick a skill with
`/skills`.

### Plugins

TeXRA installs plugins published for Claude Code and Codex. It reads the
plugin's own manifest, `.claude-plugin/plugin.json` or
`.codex-plugin/plugin.json`, and the folders beside it: skills from `skills/`,
commands from `commands/`, agents from `agents/`, MCP servers from `.mcp.json`,
plus any of these paths the manifest declares. A plugin can also carry
[programs](#programs-in-a-plugin) for TeXRA in `programs/` and a native
`harness.mjs` entry that adds in-process tools, layers, or prompt sections once
explicitly trusted at its file digest (loaded from a snapshot of the trusted
files). In chat, `/plugins add` installs a plugin interactively, and the
assistant can also list, install, or toggle plugins (always prompting you before
trusting, disabling, or removing one) through the `plugin_manager` tool.

```bash
texra plugin install github.com/LionSR/AgenticPublicationProtocol
texra plugin install github.com/<owner>/<repo>@v1.0.0
texra plugin install https://example.org/plugins.git --ref main
texra plugin install ./my-plugin
texra plugin show paper-protocol
texra plugin enable paper-protocol
texra plugin list
texra plugin update
texra plugin disable paper-protocol
texra plugin remove paper-protocol
```

An installed plugin stays off until you enable it:

- **Trust on enable**: `texra plugin enable` shows what the plugin declares (skills, commands, agents, and each MCP server's command line) and asks you to trust it. Trust covers that version, every file in the plugin folder, and the MCP servers' commands, arguments, and environment values. External binaries a server runs (such as `node`) are trusted by path, size, and modification time. If any covered file or setting changes, the plugin stops loading until you re-enable and re-trust it.
- **Names and unsupported features**: A plugin's name uses lowercase letters, digits and single hyphens, at most 32 characters, and cannot be `own`, which names the [programs an agent writes for itself](#programs-an-agent-writes-for-itself). Plugins with LSP servers cannot be enabled yet; output styles and apps are not loaded.
- **Hooks**: Claude Code hooks run as processes in the project folder. A `Stop` hook that blocks (`decision: "block"`, or exit code 2) continues the task for one extra turn using its reason as the next instruction, even under `texra run`. The stop after that turn passes `stop_hook_active: true` and cannot block again.

Once enabled and trusted, a plugin's components load under its namespace:

- **Names**: Skills, commands, agents and programs become `<plugin>:<name>`, and MCP tools are offered to top-level chat runs as `mcp__plugin_<plugin>_<server>__<tool>`.
- **Tool inheritance**: The assistant starts a plugin agent by name with the `agent` tool. One that lists `tools` receives exactly those. One that omits `tools` receives the file, shell and web tools and, as a top-level run does, the tools the enabled plugins add, including installed plugins' MCP tools.
- **Runtime changes**: Each MCP server runs as its own process in the plugin folder, with tool calls approved like shell commands. Enabling, disabling, or modifying a plugin takes effect at the next model request in a running conversation; calls to removed tools are refused, while earlier history is preserved.

Fetched plugins are stored in `~/.texra/v1/global-storage/plugins/<name>/`, pinned to the resolved commit. `texra plugin update` re-fetches the branch or tag and pins the new commit. Local folders are used in place without copying, so edits take effect immediately and `texra plugin remove` only unregisters them (if removing a fetched plugin fails to delete its folder, run `texra plugin remove` again).

A repository with a marketplace file (`.claude-plugin/marketplace.json` or `.agents/plugins/marketplace.json`) and no plugin manifest installs the plugin it lists; if it lists several, pass `--plugin <name>` (repeatable). <!-- guidance-refs-ignore -->

The CLI, VS Code extension, and desktop app share installed plugins and trust decisions. In the extension and desktop app, manage them under **Settings → Plugins**.

#### Programs in a plugin

A plugin is also where your own programs live: a folder with a manifest and a
`programs/` directory is enough. Each `programs/<name>.js` is one program,
started as `<plugin>:<name>`:

```js
// my-programs/programs/todo-list.js
export const description = 'List the TODO lines of each input file.';
export const uses = ['read_file'];

export default async (args, { inputFiles }) => {
  const found = [];
  for (const file of inputFiles) {
    const { output } = await tools.read_file({ path: file });
    for (const line of output.split('\n'))
      if (line.includes('TODO')) found.push(file + ': ' + line.trim());
  }
  return found.join('\n') || 'No TODO lines.';
};
```

```bash
mkdir -p my-programs/.claude-plugin
echo '{ "name": "my-programs", "version": "0.1.0" }' > my-programs/.claude-plugin/plugin.json
texra plugin install ./my-programs
texra plugin enable my-programs
texra run my-programs:todo-list --input paper.tex
```

- **Header declarations:** Each file must begin with `export const description = '...';` (single line, at most 300 characters) and `export const uses = ['...'];`, in either order. Both must be quoted literals ending in `;`, with only comments before or between them. TeXRA parses them statically without executing the file; a computed value, template string, or leading statement causes that file to be rejected while the plugin's other programs still load. (`uses` is named so it never shadows the `tools` object inside the sandbox.)
- **Program body:** The default export is `async (args, launch) => result`, where `launch` carries `instruction`, `inputFiles`, `contextFiles`, and `mediaFiles`, and the return value becomes the program's output. It runs in the same QuickJS sandbox as a model-written script—no filesystem, network, timers, or `Date.now()`, only the tools named in `uses` (`tools.<name>(...)`, plus `agent(...)` and `program(...)` when listed). It may also `import` built-in modules and programs from enabled plugins.
- **Naming:** The filename is the program name (lowercase letters, digits, and hyphens). TeXRA does not follow symbolic links inside `programs/`.
- **Trust and approvals:** `texra plugin enable` lists each program with its description, declared tools, and any rejected files. A program can only invoke the tools in `uses`, and unlike built-in programs, those tools are withheld while their owning plugin is off. Individual calls that require approval (shell commands, file edits) follow your approval policy, while agents and programs launched by a trusted plugin program are not re-prompted one by one. Editing any file in the plugin withdraws all of its programs until you re-enable and re-trust it.
- **Discovery:** `texra plugin list` and **Settings → Plugins** list a plugin's programs; `texra run <plugin>:<name>` starts one directly, and the assistant sees it alongside the built-in programs.

#### Programs an agent writes for itself

The assistant can also author reusable project programs. Any file it writes at `programs/<name>.js` in the project's memory folder becomes available as `own:<name>` on the next step—no restart or installation needed—and persists across conversations in the same project. It uses the same header declarations and default export as a plugin program, and can also be started directly with `texra run own:<name> --input paper.tex`.

- **Storage:** These files live in project [memory](./memory.md) alongside saved notes, not in your repository, so cloning a repo never brings them in. The Memory tab's **Open this project's memory folder** reveals the files; delete one to remove its program. Self-written programs load even when memory is switched off (that setting controls only whether a chat gets the memory folders and their indexes).
- **Trust and approvals:** Self-written programs run in the same sandbox with only the tools listed in `uses`, subject to plugin switches and your approval policy. Unlike plugin programs, every helper agent or nested program they start still prompts for approval (and under `--approval-policy never`, tools that require approval are withheld). No plugin may use the reserved name `own`.
- **Listing:** The first 20 self-written programs are listed to the assistant by name; any beyond that can still be invoked by name. Malformed files are rejected individually without blocking the rest.

## Shell completion

TeXRA can print completion scripts for Bash, Zsh, and Fish:

```bash
texra completion bash >> ~/.bashrc
texra completion zsh > "${fpath[1]}/_texra"
texra completion fish > ~/.config/fish/completions/texra.fish
```

Restart the shell, or source the file you updated. Completion includes
subcommands, flags, enum values such as `--output-format text|json|ndjson`,
and model names for `--model <TAB>`.

Model completion calls back into `texra models list`. Disable that dynamic
lookup in slow shells with:

```bash
export TEXRA_COMPLETION_DYNAMIC=0
```

## Task history

TeXRA stores every task in the project task store. List recent tasks:

```bash
texra history list
texra history list --limit 10        # only the most recent tasks (alias: -n)
texra history list --output-format ndjson
```

Text output prints one tab-separated row per task, with no header line:

```text
<id>    <timestamp>    <name>    <status>    <subject>
```

The name is the task's label (a program's name, or the chat's), and the
subject is its first input file's name, else its title, else `-`.

The NDJSON form is stable for scripts under the version 3 contract above.
Each line has kind `history-entry` and contains the same task entry object used
by JSON output, with the terminal `outcome` spelled as `completed`,
`cancelled`, or `failed` (`null` when none was recorded) and `continues`
saying whether `texra resume` continues it. The text status column matches the Tasks view (`Completed`, `Stopped`, `Error`, or `No outcome`), plus `(can continue)` or `(can resume)` when resumable.

Inspect, export, or delete tasks:

```bash
texra history show <id>                  # summary (--full for full conversation)
texra history show <id> --export html    # export standalone HTML or Markdown (md)
texra history delete <id>                # delete one task (--all --yes deletes all)
texra doctor --prune-storage             # review and remove orphaned project stores and corrupt backups
```

Continue a stored task on its saved model:

```bash
texra resume <id>
texra --resume <id>
```

How `texra resume` handles each kind of run:

- **Interactive chats:** Reopens in the interactive chat UI and waits for your next message. Without a TTY, it exits with a usage error pointing scripts at `texra run`.
- **One-shot `texra run chat` tasks:** If stopped mid-turn, resumes in chat to finish that turn. Once ended, `texra resume` exits with code 2 and suggests `texra history show <id>` or `texra resume <id> --fork`.
- **Program runs:** Resumes headlessly under the original execution ID and honors `--print`, `--output-format`, and `--no-input`.
- **Approval policy:** A resumed run keeps its original approval policy (passing `--approval-policy` prints a notice that it does not apply to the resumed turn, though new messages in chat use it).
- **In-chat commands:** Inside `texra chat`, `/resume` lists recent tasks by title, `/resume <id>` continues one, `/resume all` continues every interrupted task, and `/rename <title>` renames the focused task. A missing or malformed ID exits with code 2.

Fork a conversation as you continue it:

```bash
texra resume <id> --fork               # a new task holding the conversation
```

Inside the chat, `/fork` continues a new task holding the conversation
(the original stays in `/resume`).

A fork holds the conversation as it stood at the end of its last turn and
leaves the original task unchanged. Forking continues in an interactive chat,
so it needs a terminal, and a program run cannot be forked.

When `texra chat` opens, interrupted tasks stay paused until you resume them with `/resume` or `/resume all`. `texra run` never auto-resumes either.

If another TeXRA process still holds a task, resume refuses with that process's PID and host. If the original process is gone and cannot be verified (for example on another machine), delete the task from history and start a new one.

## Background service

On macOS and Linux, the CLI, VS Code extension, and desktop app share a local background service (started automatically by `texra chat`, `texra tasks`, VS Code, or the desktop app; it exits after 10 minutes idle). Tasks keep running if you close the terminal, and any open VS Code or desktop window for the same project handles window-only actions like diff previews and diagnostics.

If the service cannot start (or `TEXRA_NO_SERVICE=1` is set, or on Windows), `texra chat` runs locally in its own process. `texra run`, `-p`, and `--output-format ndjson` always run locally.

```bash
texra tasks list                                   # tasks across projects (* = running)
texra tasks start --instruction "<text>"           # start a task in the service
texra tasks attach <id>                            # follow live (Ctrl-C detaches)
texra tasks send <id> "<text>"                     # send a follow-up or resume
texra tasks stop <id>                              # stop a running task
```

You can shorten any `<id>` to a unique prefix. Multiple terminals can attach to the same task; `attach` is read-only, so answer pending approvals in `texra chat` via `/tasks`. Per-command approval settings (`--approval-policy`, `TEXRA_APPROVAL_POLICY`) apply only to that task and can tighten the project policy (or set `yolo` unless the project policy is `never` / **Block**). With `--no-input`, the task follows the same approval policy without prompting.

Manage the service directly:

```bash
texra service status    # pid, version, socket, clients, running tasks
texra service stop      # stop the service (running tasks can be resumed)
texra service restart   # reload shell PATH, keys, or config.json changes
texra serve             # run in the foreground
```

The service listens on a user-only socket in `~/.texra/run/` (logs in `~/.texra/run/serve.log`) and inherits `PATH` and keys from your login shell. When a newer TeXRA version starts, it asks any older service to finish active tasks and exit before starting the updated one.

## Tools and integrations

In the interactive TUI, `/plugins` lists TeXRA's plugins, including the
external agent integrations shown in the extension settings, with installed
plugins and MCP servers beside them, and switches the ones that can be switched
on or off. Plugins you install yourself are also managed from the shell with
`texra plugin` (see above).

## Models and memories

List the models TeXRA knows about, and manage which ones appear in the
model pickers:

```bash
texra models list
texra models show deepseek/deepseek-v4-pro
texra models enabled
texra models enable xai/grok-4.7
texra models disable xai/grok-4.7
```

## Project defaults

Run `texra config` in a terminal, or `/config` in a chat, to open the
configuration view; `texra config show` prints the settings for scripts.

The CLI reads optional, non-secret defaults from `.texra/config.json` in the
current project. Scaffold one with `texra init` (add `--yes` to accept
defaults non-interactively, or `--gitignore` to add `.texra/` to `.gitignore`).
Command-line flags override environment variables, environment variables
override the project file, the project file overrides your user
configuration file (`~/.texra/v1/global-storage/config.json`), and that file
overrides built-in defaults.

<ConfigPrecedenceStack />

<p class="hero-caption">Resolution order, highest priority on top: a CLI flag beats its <code>TEXRA_*</code> env var, which beats the <code>.texra/config.json</code> key (and, below it, your user configuration file), which beats the built-in default (<code>deepseek/deepseek-v4-pro</code>).</p>

```json
{
  "texra.model": "deepseek/deepseek-v4-pro",
  "texra.outputFormat": "text",
  "texra.chat": {
    "model": "deepseek/deepseek-v4-pro"
  },
  "texra.run": {
    "model": "deepseek/deepseek-v4-pro"
  }
}
```

Supported top-level keys are `texra.model` and `texra.outputFormat`;
`texra.chat` and `texra.run` may each set a command-specific `model`
default. Shared TeXRA settings
the CLI honors, such as `texra.telemetry.enabled` (which a project file can
only turn off), are also accepted. The
built-in CLI model default is `deepseek/deepseek-v4-pro`.

The approval policy (`texra.approvalPolicy`) is never read from
`.texra/config.json`, because a repository you clone can carry that file. Set
it with `/config` or the settings view: it is kept in your own storage for the
current project, and a value in your user configuration file is the default
for every project. A project file that sets it is ignored and `texra doctor` reports the key.

The corresponding environment variables are `TEXRA_MODEL`,
`TEXRA_OUTPUT_FORMAT`, and `TEXRA_APPROVAL_POLICY`. The approval policy a
command asks for (`--approval-policy` or `TEXRA_APPROVAL_POLICY`) does not
replace the stored one: it can
only narrow it for that command's tasks, and `yolo` auto-approves them unless
the stored policy is `never` (**Block**). Run
`texra doctor` to see which project config file was loaded and whether any
keys were ignored.

Two more switches live in the environment:

| Variable                              | Effect                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `TEXRA_NO_TELEMETRY` / `DO_NOT_TRACK` | Turn off usage logging ([Usage logging](./configuration.md#usage-logging)) |
| `TEXRA_NO_UPDATE_CHECK`               | Skip the daily check for a newer `texra` release (environment-only)        |

Usage logging can also be turned off with `"texra.telemetry.enabled": false`
in your user configuration file, `~/.texra/v1/global-storage/config.json`
(`texra doctor` prints this hint). The environment variables override a stored `true`, but
not the reverse: they can only switch logging off.

Both take `1`, `true`, or any other value; `0`, `false`, `no`, `off`, empty,
and unset mean "leave it on".
