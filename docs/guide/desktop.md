<script setup>
import FlowSteps from '../.vitepress/components/FlowSteps.vue';
</script>

# Desktop App

The TeXRA desktop app is the standalone Electron host for TeXRA, built for researchers who want the TeXRA agent workflow without installing VS Code. It shares the same agent runtime, model providers, LaTeX tools, settings UI, task list, configuration locations (`.texra/config.json` and `~/.texra`), and credential store (`~/.texra/secrets/`) as the extension and CLI.

## Availability

The desktop app is in beta development; public signed installers are not published yet.

Supported packaging targets:

| Platform | Planned artifact         | Current expectation               |
| -------- | ------------------------ | --------------------------------- |
| macOS    | Universal `.dmg` and zip | Beta builds may be unsigned       |
| Windows  | x64 NSIS installer       | Beta builds may be unsigned       |
| Linux    | x64 AppImage and `.deb`  | Manual install and manual updates |

When public distribution is ready, this page will link to the desktop release
repository that holds the installers. The app checks that repository's latest
release for a newer version and points you to it; it does not download or
install updates itself, and it needs no `GH_TOKEN` or other GitHub credential.

## Installation

Until signed public installers are published, use the VS Code extension for
normal work and treat desktop builds as beta artifacts.

When a desktop installer is available:

1. Download the installer for your platform from the linked desktop release
   page.
2. Install TeXRA using the normal operating-system flow.
3. Launch TeXRA and open the project folder that contains your manuscript.
4. Complete first-run setup in the Models, Agents, Plugins, LaTeX and General settings.

For the system dependencies TeXRA needs, follow the same setup as the extension:
[Installation](/guide/installation).

## First Run

On first launch, point the app at your project and verify your setup:

<FlowSteps :steps="[
  { n: 1, icon: 'folder-open', title: 'Open your project', desc: 'Point the desktop app at the same folder or Git repository you already use for your project.', chips: [{ text: 'folder or repo', variant: 'info', icon: 'folder-tree' }] },
  { n: 2, icon: 'key', title: 'Add API keys', desc: 'Add model provider keys in the Models tab, or set workspace-local .env variables.', chips: [{ text: 'Models tab', variant: 'accent' }, { text: '.env', variant: 'info', icon: 'file-code' }] },
  { n: 3, icon: 'gear', title: 'Review settings', desc: 'Check agent visibility, plugins, LaTeX tool paths, and approval and Git under General.', chips: [{ text: 'Agents', variant: 'accent' }, { text: 'Plugins', variant: 'accent' }, { text: 'LaTeX', variant: 'accent' }, { text: 'General', variant: 'accent' }] },
  { n: 4, icon: 'play', title: 'Run a small task', desc: 'Run a LaTeX or polish task and confirm the output appears in the task list.', chips: [{ text: 'Tasks', variant: 'success', icon: 'list-check' }] }
]" />

<p class="hero-caption">First-run setup is explicit: open your project, add keys, review settings, then confirm a small task lands in the task list.</p>

### What carries over from the extension and CLI

The desktop app, the VS Code extension, and the CLI read the same native TeXRA
configuration: workspace settings in `.texra/config.json` and global settings
and shared task data under `~/.texra`. Opening the same project therefore
shares:

- workspace and global values stored in TeXRA configuration, including
  approval, telemetry, skill, model-behavior, bibliography, and selected TikZ
  and LaTeX replacement settings;
- history and execution records; and
- project files, custom instructions, and checked-in agent definitions.

TeXRA's own stored state (enabled agents, the default team, disabled tools,
model selection and similar choices) also lives under `~/.texra`, in stores
every host reads, so it carries over too. Provider API keys and sign-ins are
shared: every TeXRA app keeps them in one folder, `~/.texra/secrets/`,
readable by your user alone.

### Tasks run in the background service

On macOS and Linux the desktop app runs a project's tasks in the background
TeXRA service, the same one the CLI and VS Code use. It starts the service
when none is running. A task keeps running when you quit the app, and a
terminal (`/tasks` in `texra chat`) or a VS Code window of the same project
can follow it. The app still shows the task's notices and its proposed edits
for review. When the service cannot start, the app runs its tasks itself.

## Logs

The desktop app writes a local session log named `texra-desktop.log`. Choose
**Show Logs** from the **View** menu or from Commands to read it in the
app, or **Open Logs Folder** from the **Help** menu to open the folder in your
operating system.

Include relevant log excerpts when reporting beta desktop issues. Avoid sharing
API keys, unpublished manuscript text, or private file paths.

## Updates

Automatic desktop updates are not available during beta. Beta users should install newer builds manually.

A packaged build checks the public desktop release repository's latest
release, without a GitHub token, and when a newer version exists shows a
dialog that links to its download page. It never downloads or installs an
update itself. Set `TEXRA_NO_UPDATE_CHECK=1` to turn the check off.

Docs will be updated when signed installers are live.

## Related Docs

- [Configuration](/guide/configuration)
- [Troubleshooting](/guide/troubleshooting)
