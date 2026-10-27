# TeXRA app package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for `packages/texra`
(`@texra-ai/texra`), the app over the harness.

## Directory organization

- `packages/texra/src/common/files/` - The app's file rules: the LaTeX extension tables (`fileHandlingRules.ts`) and the extension categories hosts list and filter by (`getIncludedExtensions`, `getFilterExtensions` in `fileTypeUtils.ts`). They are TeXRA's policy, not the harness's.
- `packages/texra/src/ui/` (`@ui/*`) - The host-neutral UI toolkit all three hosts render from (`ui/wa/`, `ui/styles/`, `ui/markdown/`, `ui/copy/`). It is app code, VS Code-free, and takes no `@agent/*` imports. Its design system (tokens, control skins, brand and human-in-the-loop rules) is in `packages/texra/src/ui/README.md`.
- `packages/texra/src/shared/{litControllers,monaco,highlighting}/` - Lit reactive controllers, a Monaco bootstrap and a highlight.js wrapper. They are UI code that never moved into the kit (shelved on cost): treat them as the kit's territory, don't duplicate them in `@ui`, and don't add rendering code under a `shared/` directory.
