# Tailoring TeXRA

The assistant's own prompt and tools are fixed. You shape what it does in a
project with the things below; none of them replaces the assistant, they add
to it.

## Project instructions: `AGENTS.md`

Put the rules every conversation in a project should follow (notation,
macros, journal style, how to build the paper, files never to touch) in an
`AGENTS.md` file at the workspace root. TeXRA adds it to the assistant's
instructions in every conversation. Read [Project instructions](./configuration.md#project-instructions-agentsmd).

## Memory

The assistant can keep notes about the project in its memory and read them in
later conversations. Read [Memory](./memory.md).

## Plugins on and off

**Settings → Plugins** (or `/plugins` in the terminal chat) switches each
group of tools on or off: web search, Zotero, Lean, Wolfram, the Codex and
Claude Code integrations, multi-agent work and more. A plugin that is off
adds nothing to the conversation.

## Skills

A skill is a folder with a `SKILL.md` that tells the assistant how to do one
kind of work. TeXRA reads skills from installed plugins, from `.texra/skills/`
in the project, from your own skills folder, and, once you switch that
source on, from the `.agents`, `.claude`, `.codex` and `.gemini` skill folders
beside the project and in your home folder. Turn skills on with **Enable
skills for agents** in the **Skills** section of **Settings → Agents**, where
you also choose the sources. In the terminal, `texra skills list` shows them
and `/skills` applies one to your next request. Read
[Skills in the CLI guide](./texra-cli.md#skills).

## Install a plugin

TeXRA installs plugins published for Claude Code and Codex. A plugin can
bring skills, commands, agents, MCP servers, programs (`programs/<name>.js`),
and native TeXRA extensions (`harness.mjs`):

```bash
texra plugin install github.com/<owner>/<repo>
texra plugin enable <name>
```

An installed plugin stays off until you review and trust what it carries (a
native `harness.mjs` entry loads from a snapshot of the trusted files, and any
edit requires re-trusting). In the terminal chat you can also use `/plugins add`,
and in the VS Code extension and desktop app manage installed plugins under
**Settings → Plugins**. Read [Plugins in the CLI guide](./texra-cli.md#plugins).

A plugin's agents are Claude Code subagent files (`agents/<name>.md`: a
name, a description and an optional tool list, with the agent's instructions
as the body). While the plugin is enabled, the assistant is told of each one
as `<plugin>:<name>` and can hand it a piece of work by that name, so ask for
it: "have `my-plugin:referee` read section 3". An agent that lists no tools
gets the file, shell and web tools, the tools every agent gets injected
(`plan`, `script`, `context`, and the rest), and the tools of the plugins
you have on.

## Write your own program

A program is a JavaScript file that runs a fixed procedure over the files
you give it. Put it in a plugin's `programs/` folder and it is started as
`<plugin>:<name>`, by you (`texra run <plugin>:<name> --input …`) or by the
assistant when you ask for it. Read
[Programs in a plugin](./texra-cli.md#programs-in-a-plugin).

The assistant can also write a program for itself, saved in the project's
memory, and start it again in later conversations. Read
[Programs an agent writes for itself](./texra-cli.md#programs-an-agent-writes-for-itself).

## MCP servers

The Model Context Protocol servers an installed plugin carries give the
assistant their tools while the plugin is enabled. Read
[MCP servers](./agent-integrations.md#mcp-servers).

## A different point of view is a sentence

You need no new agent to change how a job is done. The programs take their
scope and point of view from the instruction: "read as a referee for a
physics journal and mark every unsupported claim" is `annotate` with that
sentence. To combine steps, ask the assistant to chain programs, for example
`annotate`, then `apply`.

::: info If you used 0.40
Custom agent YAML files, the custom agents folder, the Agents library in
Settings, customizing a built-in agent, and TeXRA's bundled skills are gone.
Move an agent's standing rules into `AGENTS.md`, a checklist into a skill,
and a repeatable procedure into a plugin program. The skill collections
listed on the [Open source](./open-source.md) page are published as Claude
Code plugins.
:::
