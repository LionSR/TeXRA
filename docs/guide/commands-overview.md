# Command Organization

Commands under `src/commands` are organized by feature area.
This keeps each directory small and mirrors the modular layout used in
`src/agent`.

- `agents/` – commands that control or create agents
- `files/` – open file pickers and related utilities
- `history/`, `progress/` – actions for the History and Progress webviews
- `workspace/` – backend operations such as packing, merging or LaTeX helpers
- `wolfram/`, `arXiv/`, etc. – integrations with external tools

Each folder exposes a `register*` function consumed by `src/commands.ts`.
