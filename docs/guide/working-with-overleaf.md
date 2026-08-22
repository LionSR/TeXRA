<script setup>
import OverleafCloneFlow from '../.vitepress/components/OverleafCloneFlow.vue';
import OverleafRoundTripFlow from '../.vitepress/components/OverleafRoundTripFlow.vue';
import OverleafEditActions from '../.vitepress/components/OverleafEditActions.vue';
</script>

# Working with Overleaf: a Git-based workflow

Overleaf is the standard platform for collaborative LaTeX writing. With Overleaf\'s Git integration, you can combine it with TeXRA\'s agents, local tools (like `latexdiff`), and VS Code: derivations checked and drafts revised locally, collaboration on Overleaf.

This guide describes a workflow to clone your Overleaf project, run TeXRA locally in VS Code, and sync your changes back: Overleaf for collaboration, TeXRA for local AI editing.

::: tip Works from the CLI too
The clone → edit → push loop below works in the terminal as well. After
cloning, run agents with the [`texra` CLI](./texra-cli.md) (e.g.
`texra run polish --input main.tex`) instead of the VS Code panel, then commit
and push as usual.
:::

## Why bridge Overleaf and TeXRA?

- **AI editing:** Apply TeXRA\'s specialized agents (`correct`, `polish`, `research`, `paper2slide`, etc.) locally.
- **Local tooling:** Use `latexdiff` for precise change tracking and local compilation for previews.
- **VS Code environment:** Use VS Code\'s features and extensions (like LaTeX Workshop).
- **Git:** Use granular version control, branching, and offline work locally.

## Prerequisites

- Overleaf account with Git access enabled for your project (check Overleaf plans).
- An **Overleaf Git authentication token** (starts with `olp_`). Generate one from [Account Settings → Git Integration](https://www.overleaf.com/user/settings). Read [Overleaf's token documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens) for step-by-step instructions.
- Git installed locally. Install it using your platform's package manager:
  - **macOS:** `brew install git` (via [Homebrew](./installation.md#homebrew)), or run `xcode-select --install` to get git as part of the Xcode Command Line Tools.
  - **Windows:** Download the installer from [git-scm.com](https://git-scm.com/downloads), or install via `winget install --id Git.Git -e`.
  - **Linux (Ubuntu/Debian):** `sudo apt-get install git`.
- TeXRA installed as either the VS Code extension or the `texra` CLI
  ([installation guide](./installation.md)).

## Workflow steps

The whole loop is a round trip: pull your project down from Overleaf, edit it locally with TeXRA, then push your commits back.

<OverleafRoundTripFlow />

<p class="hero-caption">Clone or pull brings the project into VS Code, where TeXRA's agents do the editing; <code>git push</code> sends your committed changes back to Overleaf for your collaborators.</p>

### 1. Clone your Overleaf project

#### Option A: use TeXRA's clone command (recommended)

1.  In VS Code, open the Command Palette (<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and run **TeXRA: Clone Overleaf/ShareLaTeX Project**.
2.  Paste the Overleaf project URL or 24-character project ID when prompted.
3.  Enter your Overleaf Git token (it begins with `olp_`). TeXRA saves it to VS Code's secret storage so future clones can reuse it.
4.  The command runs `git clone` directly into your workspace root, so the cloned project becomes the repository you're working in. Make sure that folder is empty before starting.

<OverleafCloneFlow />

<p class="hero-caption">Three quick-input prompts: pick the command, paste the project URL or 24-character ID, then enter your <code>olp_</code> token, which is cached to VS Code secret storage for next time.</p>

> **Token storage:** Reset the cached token at any time with the VS Code command **Developer: Clear Secret Storage**.

#### Option B: use the TeXRA CLI

Create an empty destination directory, then pass either the Overleaf project
URL or its 24-character project ID:

```bash
mkdir paper
texra clone 0123456789abcdef01234567 --cwd ./paper
```

The CLI requests the Git token without displaying it and saves the token in
TeXRA's local secret store. Later clones reuse the saved token. In scripts,
`--no-input` disables the prompt; the command then requires a token saved by an
earlier interactive invocation. Self-hosted ShareLaTeX project and Git URLs are
accepted by the same command.

#### Option C: manual terminal fallback

1.  **Overleaf:** Go to your project > **Menu** > **Git**. Copy the Git **clone URL** (`https://git.overleaf.com/YOUR_PROJECT_ID`).
    ![Overleaf Git Menu](/images/overleaf-git.png)
2.  **Local terminal:** Go to the local directory you want and run:
    ```bash
    git clone https://git.overleaf.com/YOUR_PROJECT_ID your-local-folder
    ```
    When prompted for a password, enter your Overleaf Git token (`olp_…`). For the username, enter any non-empty value (e.g. `git`).

### 2. Edit locally with TeXRA in VS Code

1.  Open `your-local-folder` in VS Code.
2.  Use TeXRA as usual:
    - Select files, agent, model.
    - Write instructions.
    - Execute (<wa-icon library="texra" name="play"></wa-icon>).
    - Review outputs (`r0/<input filename>.tex`, for example `r0/main.tex`; each round keeps the input filename) from task storage.
    - Use `latexdiff` (<wa-icon library="texra" name="diff-single"></wa-icon>) or merge (<wa-icon library="texra" name="merge"></wa-icon>).
    - Use features like auto-extract (<wa-icon library="texra" name="wand"></wa-icon>) and tool options (<wa-icon library="texra" name="tools"></wa-icon>).
    - Optionally use LaTeX Workshop for local previews ([LaTeX compilation setup](./latex-compilation.md)).

<OverleafEditActions />

<p class="hero-caption">Each toolbar action in the local edit loop, from selecting files and writing instructions through <code>Execute</code>, reviewing outputs, <code>latexdiff</code>/merge, and auto-extract.</p>

### 3. Commit local changes

As you work, commit changes often using VS Code\'s Source Control (<wa-icon library="texra" name="source-control"></wa-icon>) or the terminal:

```bash
# Stage changes (e.g., all modified files)
git add .
# Commit with a descriptive message
git commit -m "Refined methodology section using TeXRA polish"
```

### 4. Sync back to Overleaf

1.  **(Recommended) Pull:** Fetch and merge any changes made directly on Overleaf since your last pull:
    ```bash
    git pull
    ```
    Resolve any merge conflicts locally using standard Git tools.
2.  **Push:** Upload your local commits to Overleaf:
    ```bash
    git push
    ```
    Refresh Overleaf in your browser to see the synced changes.

## Important considerations

- **Merge conflicts:** The most likely problem. Pull changes from Overleaf _before_ pushing your local work to keep conflicts small.
- **Authentication:** Git may re-prompt for Overleaf credentials. If your token expires, generate a new one from [Overleaf account settings](https://www.overleaf.com/user/settings) (read the [token documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens)).
- **Large projects:** Overleaf Git has size limits; keep them in mind for large projects.

This Git-based workflow lets you use TeXRA\'s local AI and tooling on your Overleaf projects while keeping Overleaf for collaboration.

## Next steps

- [Best practices](./best-practices.md): get more out of TeXRA.
- [LaTeX Diff](./latex-diff.md): change comparison in detail.
- [Intelligent Merge](./intelligent-merge.md): AI-assisted merging.
