<script setup>
import MemoryItemAnatomy from '../.vitepress/components/MemoryItemAnatomy.vue';
import CliMemoryHero from '../.vitepress/components/CliMemoryHero.vue';
</script>

# Memory

The assistant (and the helper agents it starts) can save memories that persist across tasks. Next time you start a chat, even days later, the assistant loads them and picks up where you left off without needing to re-explain the project.

<MemoryHero />

<p class="hero-caption">The Memory tab in Settings: toggle memory on or off, and browse, pin, open, or delete the memories saved for your project.</p>

## What memory is for

Memory is for facts the assistant should remember about **your project**, not the conversation itself. Good things to save:

- Conventions you want enforced (label prefixes, citation styles, notation choices)
- Project structure (where figures live, which file is the main document)
- Decisions you've made that the assistant would otherwise revisit
- Pitfalls you keep hitting (a compiler quirk, a finicky package, a flaky reference)

Memory is **not** a chat transcript. The assistant doesn't replay old conversations; it reads the memories you've curated.

## Enabling memory

Memory is **on by default**. To turn it off, open **Settings** (Command Palette → `TeXRA: Open Settings`), switch to the **Memory** tab, and flip the **Enable memory for chat agents** switch. The same switch turns it back on.

When memory is on, every chat has access to the `memory` tool: it can create, view, update, rename, delete, pin, and unpin memories under `/memories`.

## How memory is used

The assistant and helper agents work with memory through a small set of commands on the `memory` tool:

| Command       | What it does                                                              |
| ------------- | ------------------------------------------------------------------------- |
| `view`        | List `/memories` or read a single memory                                  |
| `create`      | Write a new memory (or overwrite an existing one)                         |
| `str_replace` | Edit a memory by replacing a substring                                    |
| `insert`      | Insert text at a specific line                                            |
| `delete`      | Remove a memory                                                           |
| `rename`      | Move a memory to a new path                                               |
| `pin`         | Mark a memory as a **core long-term memory** (loaded at every task start) |
| `unpin`       | Remove the pinned status                                                  |

Every memory is a Markdown file. The assistant sees them at `/memories/<name>.md`; on disk they live in the shared TeXRA root at `~/.texra/v1/workspace-storage/<project>-<hash>/memories/`, shared across the VS Code extension, desktop app, and CLI for the same project. Each file carries a small YAML header recording which task last modified it, when, and whether it's pinned. That header is what the metadata strip in Settings shows.

<MemoryCommandsHero />

<p class="hero-caption">A task's <code>memory</code> tool calls: the agent lists existing memories, writes a new one, edits another, then pins the convention so it loads at every task start.</p>

## Pinned vs. unpinned

Unpinned memories are searchable context: the agent can read them when it needs to, but they don't take up space in every prompt.

**Pinned memories** load at the start of every task, so reserve them for high-value items: conventions, hard-won techniques, and recurring pitfalls. You can pin up to **10 memories**; if you hit the limit, unpin a stale one before pinning the next.

<MemoryPinHero />

<p class="hero-caption">Pinned memories carry a blue left border and a <code>Pinned</code> badge in the metadata strip.</p>

## Managing memories from Settings

The Memory tab shows every saved memory, with pinned ones first and the rest sorted by most recently
updated. For each memory you get:

- **Path**: the canonical `/memories/...` location
- **Metadata strip**: `Pinned · size · line count · updated · by <agent>`
- **Contents**: a collapsible Markdown preview rendered inline (pinned memories start expanded)
- **Actions**: pin / unpin, open in editor, delete

The toolbar above the list has **Refresh memories** and **Open memory folder**. Open memory folder reveals the on-disk `memories/` directory in your file explorer, useful if you want to edit memories by hand or check them into a side repo.

<MemoryItemAnatomy />

The same store is inspectable from a terminal:

<CliMemoryHero />

<p class="hero-caption"><code>memory list</code> prints each memory with its pinned state, size, and last writer; <code>memory show</code> previews one. In chat, <code>/memory</code> does the same.</p>

## Memory is shared across a task

Within a single task, the assistant and every helper agent it starts see the **same** `/memories` directory. A helper can write a memory that the assistant picks up on its next turn, and it persists into later tasks. This is why memory is most useful for **project-level** facts rather than turn-level scratch space: once written, it stays.

## When _not_ to use memory

- **Throwaway intermediate work**: that belongs in the agent's plan or scratch reasoning, not in a saved memory.
- **Sensitive credentials**: memory files are plain Markdown on disk; treat them like any other project file.
- **Auto-generated logs**: tasks already store artifacts in task history; don't duplicate them as memories.

## Related

- [Tasks view](./progress-board.md): see what an agent is doing in real time, including which memories it has read or written
- [Configuration](./configuration.md): the full list of Settings tabs
- [Tailoring TeXRA](./customizing.md): project instructions, skills, plugins and your own programs
