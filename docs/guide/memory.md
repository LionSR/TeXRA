# Memory

The assistant (and the helper agents it starts) keep notes that persist across conversations. The next time you start a chat, even days later, the assistant sees an index of those notes and picks up where it left off without needing to re-explain the project.

## What memory is for

Memory is for facts the assistant should remember about **you** and **your project**, not the conversation itself. Good things to keep:

- Conventions you want enforced (label prefixes, citation styles, notation choices)
- Project structure (where figures live, which file is the main document)
- Decisions you've made that the assistant would otherwise revisit
- Pitfalls you keep hitting (a compiler quirk, a finicky package, a flaky reference)
- Your own preferences that hold in every project (spelling, tone, how much explanation you want)

Memory is **not** a chat transcript. The assistant doesn't replay old conversations; it reads the notes.

## Memory is two folders of Markdown files

There is no memory tool. Notes are ordinary Markdown files in two folders, which the assistant reads and writes with the same file tools it uses on your project:

| Folder             | What belongs in it                    | Where it is                                                       |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------- |
| **Your memory**    | What is true of you, in every project | `~/.texra/memories/`                                              |
| **Project memory** | What is true of this project          | `~/.texra/v1/workspace-storage/<workspace-name>-<hash>/memories/` |

Neither folder is inside your repository, so a project you clone brings no memory with it, and nothing remembered is committed. The VS Code extension, the desktop app, and the CLI share both folders.

Each folder has an index, `MEMORY.md`, with one line per note. The index is the only part of memory shown automatically: its current text is in the assistant's instructions at every request, so a note written in one conversation is listed in the next, and a note written mid-task is listed at the next step. The notes themselves are read when a line of the index looks relevant. Only the first 16,000 characters of an index are shown, so keep it to one short line per note.

Instructions you want followed in full, every time, belong in [`AGENTS.md`](./customizing.md#project-instructions-agentsmd), which is loaded whole; memory is for what the assistant learns as it works.

## Enabling memory

Memory is **on by default**. To turn it off, open **Settings** (Command Palette → `TeXRA: Open Settings`), switch to the **Memory** tab, and flip the **Enable memory for chat agents** switch. While it is off, agents are given neither folder and no index.

Memory needs the file tools: an agent with no tool to read a file has no memory, and under the **Block** approval policy an agent can read its notes but not write them. Writing a note is a file edit like any other, so under **Ask** you review it; under the default, Auto-approve, it is written without asking.

## Reading and editing notes yourself

The **Memory** tab has two buttons, **Open your memory folder** and **Open this project's memory folder**. The notes are plain files: read them, edit them, delete them, or add your own in any editor. To make sure the assistant sees a note you wrote, add a line for it to that folder's `MEMORY.md`.

In a task's view, a note the assistant writes appears as a file edit, with its diff.

## Memory is shared across a task

Within a single run, the assistant and every helper agent it starts read and write the **same** two folders. A helper agent can write a note that the assistant sees at its next step, and that note survives into the next conversation.

The assistant can also keep programs for itself in the project folder: a file at `programs/<name>.js` there is the program `own:<name>` (see [the CLI guide](./texra-cli.md)).

## When _not_ to use memory

- **Throwaway intermediate work**: that belongs in the agent's plan or scratch reasoning, not in a saved note.
- **Sensitive credentials**: memory files are plain Markdown on disk; treat them like any other file.
- **Auto-generated logs**: runs already have run storage for artifacts; don't duplicate them as memories.

## Related

- [Tasks view](./progress-board.md): see what an agent is doing in real time, including the notes it reads and writes
- [Configuration](./configuration.md): the full list of Settings tabs
- [Tailoring TeXRA](./customizing.md): project instructions, skills, plugins, and your own programs
