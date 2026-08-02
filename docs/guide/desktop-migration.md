# Shared Data Across TeXRA Apps

The TeXRA desktop app, VS Code extension, and command-line client use the same
TeXRA configuration files wherever possible. Opening the same project gives
the desktop app its workspace settings and shared TeXRA history without an
export or migration step.

Workspace settings live in `.texra/config.json`. Global TeXRA settings and
shared task data live under `~/.texra`. These are native TeXRA files rather than
VS Code settings, so the three hosts read the same values.

## Shared Data

Your project files remain the source of truth. If you open the same repository,
paper folder, or Overleaf Git checkout in the desktop app, TeXRA can work with
the same `.tex`, `.bib`, figure, and configuration files already in that
workspace.

Secure credentials remain host-specific. The extension uses VS Code Secret
Storage, while the desktop and command-line hosts use their own secure stores.
API keys and sign-in sessions therefore need to be added separately for now.

The shared subset is:

- native workspace and global values stored in TeXRA configuration, including
  approval, telemetry, skill, model-behavior, bibliography, and selected TikZ
  and LaTeX replacement settings;
- shared history and execution records; and
- project files, custom instructions, and checked-in agent definitions.

Agent and team rosters, tool enablement and availability, model visibility, and
host-specific LaTeX compile and formatter preferences remain in each host's
state. Review those controls after opening a project in another app. Provider
API keys, account sessions, and other secrets also do not yet carry over.

## Opening a Project in the Desktop App

1. Install and open the desktop app.
2. Open the same project folder you use with the extension or CLI.
3. Sign in again if you use remote agents or account-backed features.
4. Add any provider API keys needed by the desktop host.
5. Review the shared settings and run a small command to confirm the expected
   project configuration is active.
6. Run a small command, such as a short polish task or LaTeX compile check, and
   confirm the output lands in the expected task storage.

## Credentials

There is no settings or history export step. A future shared credential service
may remove the remaining need to enter secrets separately; until then, TeXRA
does not copy API keys or session tokens between host-specific secure stores.

## Related Docs

- [Installation](/guide/installation) - install TeXRA and required local tools.
- [Configuration](/guide/configuration) - review provider, Git, LaTeX, and agent
  settings.
- [Remote Agents](/guide/remote-agents) - sign in and manage remote agent access.
