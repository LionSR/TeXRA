# TeXRA app package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for `packages/texra`
(`@texra-ai/texra`), the app over the harness.

## Directory organization

- `packages/texra/src/ui/` (`@ui/*`) - The host-neutral UI toolkit all three hosts render from (`ui/wa/`, `ui/styles/`, `ui/markdown/`, `ui/copy/`); see CLAUDE.md "Layout" for its boundaries, including the `litControllers/`, `monaco/`, `highlighting/` trio in `packages/texra/src/shared/`. The transcript row model is the harness's, in `packages/harness/src/shared/transcript/` (`@shared/transcript`). `packages/harness/src/transcript/` (`@transcript`) is the unrelated run-transcript persistence layer.
