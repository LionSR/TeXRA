# Command Organization

Extension commands are organized by domain to keep the source tree readable.

The top-level groups under `src/commands` are:

- `agent` – running and managing agents
- `files` – selecting or opening documents
- `integrations` – API keys, git operations and external services
- `latex` – figure extraction, linting and diff utilities
- `tests` – internal test helpers
- `utils` – editor helpers and settings commands
- `views` – commands tied to the ProgressBoard or history view
- `workspace` – housekeeping tasks like cleaning or packing

This mirrors the philosophy used in `src/agent` where code is grouped by
responsibility rather than technical layer.
