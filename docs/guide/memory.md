<script setup>
import MemoryItemAnatomy from '../.vitepress/components/MemoryItemAnatomy.vue';
import CliMemoryHero from '../.vitepress/components/CliMemoryHero.vue';
</script>

# Memory

Tool-use agents in TeXRA can save notes that persist across conversations. The next time you start a chat — even days later — the agent loads those notes and picks up where it left off, without you having to re-explain the project.

<MemoryHero />

<p class="hero-caption">The Memory tab in the Dashboard: enable memory for chat agents, then browse, pin, open, or delete the notes agents have saved.</p>

## What memory is for

Memory is for facts the agent should remember about **your project**, not the conversation itself. Good things to save:

- Conventions you want enforced (label prefixes, citation styles, notation choices)
- Project structure (where figures live, which file is the main document)
- Decisions you've made that the agent would otherwise re-litigate
- Pitfalls you keep hitting (a compiler quirk, a finicky package, a flaky reference)

Memory is **not** a chat transcript. The agent doesn't replay old conversations; it reads the notes you've curated.

## Enabling memory

Memory is **opt-in**. Open the **Dashboard** (Command Palette → `TeXRA: Show Settings Dashboard`), switch to the **Memory** tab, and flip the **Enable memory for chat agents** switch.

You can also jump straight to the tab with `TeXRA: Show Memory`.

When memory is on, every tool-use agent run has access to the `memory` tool: it can create, view, update, rename, delete, pin, and unpin notes under `/memories`.

## How an agent uses memory

Behind the scenes, agents work with memory through a small set of commands on the `memory` tool:

| Command       | What it does                                                               |
| ------------- | -------------------------------------------------------------------------- |
| `view`        | List `/memories` or read a single note                                     |
| `create`      | Write a new note (or overwrite an existing one)                            |
| `str_replace` | Edit a note by replacing a substring                                       |
| `insert`      | Insert text at a specific line                                             |
| `delete`      | Remove a note                                                              |
| `rename`      | Move a note to a new path                                                  |
| `pin`         | Mark a note as a **core long-term memory** (loaded at every session start) |
| `unpin`       | Remove the pinned status                                                   |

Every note is a Markdown file. Agents see them at `/memories/<name>.md`; on disk they live under your workspace's TeXRA storage folder. Each file carries a small YAML header that records which agent last modified it, when, and whether it's pinned — that's what powers the metadata strip in the Dashboard.

<MemoryCommandsHero />

<p class="hero-caption">A run's <code>memory</code> tool calls: the agent lists existing notes, writes a new one, edits another, then pins the convention note so it loads at every session start.</p>

## Pinned vs. unpinned

Unpinned notes are searchable context — the agent can read them when it needs to, but they don't take up space in every prompt.

**Pinned notes are different.** They're loaded at the start of every session, so put only the highest-value insights there: conventions, hard-won techniques, recurring pitfalls. You can pin up to **10 notes**; if you hit the limit, unpin something stale before pinning the next one.

The pinned indicator in the Dashboard is a blue left border plus a `Pinned` badge in the metadata strip.

<MemoryPinHero />

<p class="hero-caption">Pinned notes carry the blue left border and a <code>Pinned</code> badge and load every session; unpinned notes stay as searchable context the agent reads on demand.</p>

## Managing memories from the Dashboard

The Memory tab shows every saved note, with pinned notes first and the rest sorted most recently
updated. For each note you get:

- **Path** — the canonical `/memories/...` location
- **Metadata strip** — `Pinned · size · line count · updated · by <agent>`
- **Contents** — a collapsible Markdown preview rendered inline (pinned notes start expanded)
- **Actions** — pin / unpin, open in editor, delete

The toolbar above the list has **Refresh** and **Open Folder** — the latter reveals the on-disk `memories/` directory in your file explorer, useful if you want to edit notes by hand or check them into a side repo.

<MemoryItemAnatomy />

<p class="hero-caption">One expanded note, part by part: the <code>/memories/...</code> path, the metadata strip, the pin / open / delete actions, and the collapsible Contents preview — with Refresh and Open Folder in the toolbar above.</p>

The same store is inspectable from a terminal — memory is shared state, not a
Dashboard feature:

<CliMemoryHero />

<p class="hero-caption"><code>memory list</code> prints each note with its pinned state, size, and last writer; <code>memory show</code> previews one note. In chat, <code>/memory</code> does the same.</p>

## Memory is shared across the run

Within a single run, the orchestrator and every subagent it spawns see the **same** `/memories` directory. A specialist agent can drop a note that the orchestrator picks up on its next turn, and that note survives into the next conversation. This is why memory is most useful for **project-level** facts rather than turn-level scratch space — once it's written, it's persistent.

## When _not_ to use memory

- **Throwaway intermediate work** — that belongs in the agent's todo list or scratch reasoning, not in a saved note.
- **Sensitive credentials** — memory files are plain Markdown on disk; treat them like any other workspace file.
- **Auto-generated logs** — runs already have task-run storage for artifacts; don't duplicate them as memories.

If you find yourself with a long list of stale, never-pinned notes, just delete the noise. The agent never reads what isn't there, so a smaller, curated memory is usually more useful than a sprawling one.

## Related

- [ProgressBoard](./progress-board.md) — see what an agent is doing in real time, including which memories it has read or written
- [Configuration](./configuration.md) — the full list of Dashboard tabs
- [Custom Agents](./custom-agents.md) — give your own tool-use agents access to the `memory` tool
