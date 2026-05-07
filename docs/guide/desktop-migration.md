# Migrating to the Desktop App

The TeXRA desktop app is a separate host from the VS Code extension. Treat the
first desktop launch as a fresh setup: open your project folder, sign in again,
and reconfigure the providers and workspace settings you want to use.

The desktop app shares TeXRA's agent logic, model handlers, LaTeX processing,
and webview UI with the extension, but it uses its own application storage and
secure credential store. It does not read VS Code's Secret Storage, user
settings, workspace state, or extension global storage.

## What Carries Over

Your project files remain the source of truth. If you open the same repository,
paper folder, or Overleaf Git checkout in the desktop app, TeXRA can work with
the same `.tex`, `.bib`, figure, and configuration files already in that
workspace.

These items usually carry over because they live outside the VS Code extension:

- Manuscript source files and repository history.
- Workspace-local `.env` files, if you already use them for provider API keys.
- LaTeX, Perl, GraphicsMagick, ImageMagick, Ghostscript, Git, and other system
  tools installed on your machine.
- Custom agent YAML files that live inside the project folder.
- Team-owned files such as `.latexindent.yaml`, `tex-fmt.toml`, or shared
  `.vscode/settings.json` files committed to the repository.

After opening the project in the desktop app, verify the LaTeX tool paths and
run a small agent task before relying on the migrated setup for production work.

## What To Reconfigure

Re-enter credentials and preferences that were stored by the extension host:

- Model provider API keys from the Models tab.
- TeXRA account or remote-agent sign-in.
- GitHub token for PR and issue subscription tools.
- Agent visibility, custom agent directory, model list, and tool approval
  preferences.
- LaTeX formatting, diff, TikZ, file-extension, and ignored-path settings if
  they were only stored in VS Code user settings.
- Execution history and task-storage archives that lived in the extension's
  global storage.

If a setting was committed to the workspace, keep using the committed copy. If
it was only a personal VS Code user setting, set it again in the desktop app.

## Recommended First Launch

1. Install and open the desktop app.
2. Open the same project folder you used with the VS Code extension.
3. Sign in to TeXRA again if you use remote agents or account-backed features.
4. Open the Models tab and set the provider API keys you want available.
5. Review the Agents and Tools tabs and enable the same agents and approvals you
   use in the extension.
6. Open the LaTeX settings and confirm formatter, diff, TikZ, and tool-path
   preferences.
7. Run a small command, such as a short polish task or LaTeX compile check, and
   confirm the output lands in the expected task storage.

## Export And Import

Automatic export/import from the VS Code extension is deferred. Phase 7 defaults
to explicit re-authentication and manual reconfiguration so the desktop app does
not need access to VS Code's private storage or credentials.

A future migration tool may export non-secret preferences, custom agent
registrations, or execution-history metadata into a reviewable file. It should
not export API keys or session tokens. Track that work separately from the first
desktop release.

## Related Docs

- [Installation](/guide/installation) - install TeXRA and required local tools.
- [Configuration](/guide/configuration) - review provider, Git, LaTeX, and agent
  settings.
- [Remote Agents](/guide/remote-agents) - sign in and manage remote agent access.
