<script setup>
import FlowSteps from '../.vitepress/components/FlowSteps.vue';
</script>

# Desktop App

The TeXRA desktop app is a standalone application for researchers who want the full TeXRA workspace without installing VS Code. It shares your settings (`.texra/config.json` and `~/.texra`), credentials (`~/.texra/secrets/`), and task history with the VS Code extension and the CLI.

## Availability & installation

Public installers are coming soon.

| Platform | Artifact                 | Notes                 |
| -------- | ------------------------ | --------------------- |
| macOS    | Universal `.dmg` and zip |                       |
| Windows  | x64 NSIS installer       |                       |
| Linux    | x64 AppImage and `.deb`  | Manual install/update |

Once installers are published, download the build for your OS from the releases page, install it normally, and open your project folder. For LaTeX system dependencies, see [Installation](/guide/installation).

## First run

<FlowSteps :steps="[
  { n: 1, icon: 'folder-open', title: 'Open a project', desc: 'Open your LaTeX or research project folder (File → Open Folder).', chips: [{ text: 'project folder', variant: 'info', icon: 'folder-tree' }] },
  { n: 2, icon: 'key', title: 'Connect a model', desc: 'Sign in with ChatGPT/Grok or add API keys under Settings → Models (or a project .env).', chips: [{ text: 'Models', variant: 'accent' }, { text: '.env', variant: 'info', icon: 'file-code' }] },
  { n: 3, icon: 'gear', title: 'Review settings', desc: 'Check Agents, Plugins, Memory, LaTeX, and General (Approval & Git) in Settings.', chips: [{ text: 'Settings', variant: 'accent' }] },
  { n: 4, icon: 'play', title: 'Start a task', desc: 'Ask TeXRA to tighten a section or check a proof and review the diff.', chips: [{ text: 'Tasks', variant: 'success', icon: 'list-check' }] }
]" />

### Shared with VS Code and CLI

Opening the same project folder in the desktop app, VS Code extension, or CLI automatically shares:

- Project and user settings (`.texra/config.json` and `~/.texra`), plus `AGENTS.md`
- Saved API keys and subscription sign-ins (`~/.texra/secrets/`)
- Task history and generated outputs

### Layout and projects

The desktop app lets you arrange **Agent**, **Files**, **Editor**, **PDF**, **Review**, **Terminal**, **Browser**, and **Logs** in split panes whose layout persists across restarts and project switches.

Open projects appear in the **Projects** section of the left sidebar with a status dot; the active project's tasks appear in **Task history** below. Press `Cmd/Ctrl+K` to open **Commands** (or **Switch Project** for open projects), and use **File → Open Recent** to reopen closed projects.

### Background service

On macOS and Linux, the desktop app runs tasks through the shared background TeXRA service (starting it automatically if needed). Tasks keep running if you close the app and can be followed from `texra chat` (`/tasks`) or a VS Code window open to the same project. If the service cannot start, the app falls back to running tasks locally.

## Logs

TeXRA writes desktop logs to `texra-desktop.log`. Open **View → Show Logs** (or run **Show Logs** from **Commands**) to inspect them in-app, or **Help → Open Logs Folder** to reveal the log directory.

## Updates

Packaged builds check the public releases page on launch and notify you with a link when a newer version is available (updates are never downloaded or installed automatically). Set `TEXRA_NO_UPDATE_CHECK=1` to disable update checks.

## Related Docs

- [Configuration](/guide/configuration)
- [Troubleshooting](/guide/troubleshooting)
