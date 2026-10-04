# VS Code Activation Smoke Test

Use this checklist after changes that affect the extension package layout,
extension manifest, activation flow, or webview asset packaging.

## Electron Bundle Render Smoke

```bash
npm run smoke:webviews
```

This command builds the extension webview bundles, renders the launcher,
progress view, and settings view in Electron, and writes screenshots to
`artifacts/webview-smoke/`. It verifies that the bundled webview frontends load
without renderer errors, but it does not verify VS Code command registration,
activation events, or view-container integration. Use the VS Code checks below
for those host-level behaviors.

## Automated Host Check

```bash
npm run compile:fast
npm run test:vscode                      # latest stable VS Code
npm run test:vscode -- --vscode minimum  # engines.vscode
```

This launches the built extension in a real VS Code and asserts, from inside the
extension host, that it activates, that every manifest command is registered, and
that `showProgressView`, `showAgents` and `openProgressViewInTab` run and open a
TeXRA webview tab. It runs in CI on push, nightly and dispatch, not on pull
requests. It makes no model call: it seeds no API key.

## Development Host

```bash
corepack pnpm install
npm run compile:safe
npm run check:extension-package-invariants

SMOKE_ROOT="$(mktemp -d /tmp/vsh-XXXXXX)" # keep it short: VS Code's IPC socket path limit is ~100 chars
mkdir -p "$SMOKE_ROOT/workspace" "$SMOKE_ROOT/user-data" "$SMOKE_ROOT/extensions"
printf '\\documentclass{article}\n\\begin{document}\nSmoke\n\\end{document}\n' > "$SMOKE_ROOT/workspace/main.tex"

code --new-window \
  --user-data-dir "$SMOKE_ROOT/user-data" \
  --extensions-dir "$SMOKE_ROOT/extensions" \
  --extensionDevelopmentPath "$PWD/packages/extension" \
  "$SMOKE_ROOT/workspace"
```

In the Extension Development Host:

1. Confirm that the TeXRA output channel reports activation without an error.
2. Run `TeXRA: New Task`.
3. Run `TeXRA: Show Sessions`.
4. Run `TeXRA: Show Settings`.
5. Capture screenshots of the launcher, progress view, and settings view.

## Packaged VSIX

```bash
npm run build:fast
npm run check:vsix-contents

VSIX="releases/texra-$(node -p "require('./packages/extension/package.json').version").vsix"
SMOKE_ROOT="$(mktemp -d /tmp/vsh-XXXXXX)" # keep it short: VS Code's IPC socket path limit is ~100 chars
mkdir -p "$SMOKE_ROOT/workspace" "$SMOKE_ROOT/user-data" "$SMOKE_ROOT/extensions"
printf '\\documentclass{article}\n\\begin{document}\nSmoke\n\\end{document}\n' > "$SMOKE_ROOT/workspace/main.tex"

code \
  --user-data-dir "$SMOKE_ROOT/user-data" \
  --extensions-dir "$SMOKE_ROOT/extensions" \
  --install-extension "$VSIX"

code --new-window \
  --user-data-dir "$SMOKE_ROOT/user-data" \
  --extensions-dir "$SMOKE_ROOT/extensions" \
  "$SMOKE_ROOT/workspace"
```

Repeat the same launcher, progress view, and settings view checks in the
isolated VSIX window. Include the command output and screenshots in the PR when
the smoke test is part of the acceptance criteria.
