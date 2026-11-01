# TeXRA app package guidelines

Folder-scoped addition to the root [AGENTS.md](../../AGENTS.md) for `packages/texra`
(`@texra-ai/texra`), the app over the harness.

## Directory organization

- `packages/texra/src/common/files/` - The app's file rules: the LaTeX extension tables (`fileHandlingRules.ts`) and the extension categories hosts list and filter by (`getIncludedExtensions`, `getFilterExtensions` in `fileTypeUtils.ts`). They are TeXRA's policy, not the harness's.
- `packages/texra/src/ui/` (`@ui/*`) - The host-neutral UI toolkit all three hosts render from (`ui/wa/`, `ui/styles/`, `ui/markdown/`, `ui/copy/`, the Lit reactive controllers in `ui/litControllers/`, the Monaco bootstrap in `ui/monaco/`, the highlight.js wrapper in `ui/highlighting/`) and the progress view the VS Code webview, the desktop renderer and the trace viewer mount (`ui/progress/`). It is app code, VS Code-free, and takes no `@agent/*` imports; don't add rendering code under a `shared/` directory. Its design system (tokens, control skins, brand and human-in-the-loop rules) is in `packages/texra/src/ui/README.md`.
