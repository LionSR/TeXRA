<script setup>
import FlowSteps from '../.vitepress/components/FlowSteps.vue';
</script>

# Desktop App

The TeXRA desktop app is the standalone Electron host for TeXRA. It is intended
for researchers who want the TeXRA agent workflow without installing VS Code.
The desktop app shares the same agent runtime, model providers, LaTeX tools,
settings UI, and progress view as the extension, but it stores credentials and
state in desktop app storage.

## Availability

The desktop app is in beta development. Public signed installers and automatic
updates are not enabled until the Phase 6 release pipeline is complete.

Supported packaging targets:

| Platform | Planned artifact         | Current expectation               |
| -------- | ------------------------ | --------------------------------- |
| macOS    | Universal `.dmg` and zip | Beta builds may be unsigned       |
| Windows  | x64 NSIS installer       | Beta builds may be unsigned       |
| Linux    | x64 AppImage and `.deb`  | Manual install and manual updates |

When public distribution is ready, this page will link to the desktop release
repository that contains only installer artifacts and update manifests. The
desktop client must not require a `GH_TOKEN` or any other GitHub credential to
check for updates.

## Installation

Until signed public installers are published, use the VS Code extension for
normal work and treat desktop builds as beta artifacts.

When a desktop installer is available:

1. Download the installer for your platform from the linked desktop release
   page.
2. Install TeXRA using the normal operating-system flow.
3. Launch TeXRA and open the project folder that contains your manuscript.
4. Complete first-run setup in the Models, Agents, Tools, and LaTeX settings.

For the system dependencies TeXRA needs, follow the same setup as the extension:
[Installation](/guide/installation).

## First Run

On first launch, configure the desktop app explicitly:

- Open the same folder or Git repository you already use for your paper.
- Sign in again if you use TeXRA account features or remote agents.
- Add model provider API keys in the Models tab, or configure workspace-local
  `.env` variables.
- Review agent visibility, tool approval settings, Git integration, and LaTeX
  tool paths.
- Run a small LaTeX or polish task and confirm the output appears in the
  Progress view.

<FlowSteps :steps="[
  { n: 1, icon: 'folder-open', title: 'Open your project', desc: 'Point the desktop app at the same folder or Git repository you already use for your paper.', chips: [{ text: 'folder or repo', variant: 'info', icon: 'folder-tree' }] },
  { n: 2, icon: 'right-to-bracket', title: 'Sign in', desc: 'Re-authenticate if you use TeXRA account features or remote agents.', chips: [{ text: 'account features', variant: 'neutral' }, { text: 'remote agents', variant: 'neutral' }] },
  { n: 3, icon: 'key', title: 'Add API keys', desc: 'Add model provider keys in the Models tab, or set workspace-local .env variables.', chips: [{ text: 'Models tab', variant: 'accent' }, { text: '.env', variant: 'info', icon: 'file-code' }] },
  { n: 4, icon: 'gear', title: 'Review settings', desc: 'Check agent visibility, tool approval, Git integration and LaTeX tool paths.', chips: [{ text: 'Agents', variant: 'accent' }, { text: 'Tools', variant: 'accent' }, { text: 'LaTeX', variant: 'accent' }] },
  { n: 5, icon: 'play', title: 'Run a small task', desc: 'Run a LaTeX or polish task and confirm the output appears in the Progress view.', chips: [{ text: 'Progress view', variant: 'success', icon: 'list-check' }] }
]" />

<p class="hero-caption">First-run setup is explicit: open your project, sign in, add keys, review settings, then confirm a small task lands in the Progress view.</p>

For details about which settings, history, and credentials are shared with the
extension and CLI, see [Shared Data Across TeXRA Apps](/guide/desktop-migration).

## Logs

The desktop app writes a local session log named `texra-desktop.log`. Use the
**Logs** button in the desktop toolbar or **TeXRA > Open Logs Folder** from the
application menu to open the folder in your operating system.

Include relevant log excerpts when reporting beta desktop issues. Avoid sharing
API keys, unpublished manuscript text, or private file paths.

## Updates

Automatic desktop updates are not available until the Phase 6 release pipeline
lands. Beta users should install newer builds manually.

The intended update model is:

- signed installers are built in CI for macOS, Windows, and Linux;
- release artifacts and update manifests are published to a public desktop
  release repository;
- the installed app checks that public release location without embedding or
  asking for a GitHub token;
- update downloads require user consent for v1.

Docs will be updated when signed installers and auto-update manifests are live.

## Related Docs

- [Shared Data Across TeXRA Apps](/guide/desktop-migration)
- [Configuration](/guide/configuration)
- [Remote Agents](/guide/remote-agents)
- [Troubleshooting](/guide/troubleshooting)
