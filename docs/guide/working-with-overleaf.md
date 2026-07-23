<script setup>
import OverleafCloneFlow from '../.vitepress/components/OverleafCloneFlow.vue';
import OverleafRoundTripFlow from '../.vitepress/components/OverleafRoundTripFlow.vue';
import OverleafEditActions from '../.vitepress/components/OverleafEditActions.vue';
</script>

# Power Up Overleaf with TeXRA: A Git-Based Workflow

Overleaf is the go-to platform for collaborative LaTeX writing. But what if you could combine its convenience with the advanced AI editing, local tool integration (like `latexdiff`), and VS Code power offered by TeXRA? You can, using Overleaf\'s Git integration!

This guide outlines a workflow to clone your Overleaf project, leverage TeXRA locally in VS Code, and seamlessly sync your changes back. Get the best of both worlds: Overleaf for collaboration, TeXRA for AI-powered local editing.

::: tip Works from the CLI too
The clone → edit → push loop below is equally at home in the terminal. After
cloning, run agents with the [`texra` CLI](./texra-cli.md) (e.g.
`texra run polish --input main.tex`) instead of the VS Code panel, then commit
and push as usual.
:::

## Why Bridge Overleaf and TeXRA?

- **AI Superpowers:** Apply TeXRA\'s specialized agents (`correct`, `polish`, `research`, `paper2slide`, etc.) locally.
- **Local Tooling:** Use `latexdiff` for precise change tracking, local compilation for previews.
- **VS Code Environment:** Benefit from VS Code\'s features and extensions (like LaTeX Workshop).
- **Robust Git:** Employ granular version control, branching, and offline work locally.

## Prerequisites

- Overleaf account with Git access enabled for your project (check Overleaf plans).
- An **Overleaf Git authentication token** (starts with `olp_`). Generate one from [Account Settings → Git Integration](https://www.overleaf.com/user/settings). See [Overleaf's token documentation](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens) for step-by-step instructions.
- Git installed locally. Install it using your platform's package manager:
  - **macOS:** `brew install git` (via [Homebrew](./installation.md#homebrew)), or run `xcode-select --install` to get git as part of the Xcode Command Line Tools.
  - **Windows:** Download the installer from [git-scm.com](https://git-scm.com/downloads), or install via `winget install --id Git.Git -e`.
  - **Linux (Ubuntu/Debian):** `sudo apt-get install git`.
- TeXRA installed as either the VS Code extension or the `texra` CLI
  ([Installation Guide](./installation.md)).

## Workflow Steps

The whole loop is a round-trip: pull your project down from Overleaf, edit it locally with TeXRA, then push your commits back.

<OverleafRoundTripFlow />

<p class="hero-caption">Clone or pull brings the project into VS Code, where TeXRA's agents do the heavy lifting; <code>git push</code> sends your committed changes straight back to Overleaf for your collaborators.</p>

### 1. Clone Your Overleaf Project

#### Option A: Use TeXRA's clone command (recommended)

1.  In VS Code, open the command palette (<kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and run **TeXRA: Clone Overleaf/ShareLaTeX Project**.
2.  Paste the Overleaf project URL or 24-character project ID when prompted.
3.  Enter your Overleaf Git token (it begins with `olp_`). TeXRA saves it to VS Code's secret storage so future clones can reuse it.
4.  The command runs `git clone` directly into your workspace root so the cloned project becomes the repository you're working in. Make sure that folder is empty before starting.

<OverleafCloneFlow />

<p class="hero-caption">Three quick-input prompts: pick the command, paste the project URL or 24-character ID, then enter your <code>olp_</code> token — cached to VS Code secret storage for next time.</p>

> **Token storage:** Reset the cached token anytime via the VS Code command **Developer: Clear Secret Storage**.

#### Option B: Use the TeXRA CLI

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

#### Option C: Manual terminal fallback

1.  **Overleaf:** Go to your project > **Menu** > **Git**. Copy the Git **clone URL** (`https://git.overleaf.com/YOUR_PROJECT_ID`).
    ![Overleaf Git Menu](/images/overleaf-git.png)
2.  **Local Terminal:** Navigate to your desired local directory and run:
    ```bash
    git clone https://git.overleaf.com/YOUR_PROJECT_ID your-local-folder
    ```
    When prompted for a password, enter your Overleaf Git token (`olp_…`). For the username, enter any non-empty value (e.g. `git`).

### 2. Edit Locally with TeXRA in VS Code

1.  Open `your-local-folder` in VS Code.
2.  Use TeXRA as usual:
    - Select files, agent, model.
    - Write instructions.
    - Execute (<wa-icon library="texra" name="play"></wa-icon>).
    - Review outputs (`r0/output.tex`, etc.) from task storage.
    - Use `latexdiff` (<wa-icon library="texra" name="diff-single"></wa-icon>) or merge (<wa-icon library="texra" name="merge"></wa-icon>).
    - Leverage features like auto-extract (<wa-icon library="texra" name="wand"></wa-icon>) and tool options (<wa-icon library="texra" name="tools"></wa-icon>).
    - Optionally use LaTeX Workshop for local previews ([Setup](./latex-compilation.md)).

<OverleafEditActions />

<p class="hero-caption">Each toolbar action in the local edit loop, from selecting files and writing instructions through <code>Execute</code>, reviewing outputs, <code>latexdiff</code>/merge, and auto-extract.</p>

### 3. Commit Local Changes

As you work, commit changes frequently using VS Code\'s Source Control (<wa-icon library="texra" name="source-control"></wa-icon>) or the terminal:

```bash
# Stage changes (e.g., all modified files)
git add .
# Commit with a descriptive message
git commit -m "Refined methodology section using TeXRA polish"
```

### 4. Sync Back to Overleaf

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

## Important Considerations

- **Merge Conflicts:** The biggest potential issue. Pulling changes from Overleaf _before_ pushing your local work is the best way to minimize complex conflicts.
- **Authentication:** Git may occasionally re-prompt for Overleaf credentials. If your token expires, generate a new one from [Account Settings](https://www.overleaf.com/user/settings) (see [token docs](https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens)).
- **Large Projects:** Be mindful of potential Overleaf Git size limitations.

This Git-based workflow empowers you to enhance your Overleaf projects with TeXRA\'s powerful local AI and tooling capabilities, offering a flexible and efficient development cycle.

## Next Steps

- [Best Practices](./best-practices.md): Optimize your TeXRA usage.
- [LaTeX Diff](./latex-diff.md): Master change comparison.
- [Intelligent Merge](./intelligent-merge.md): Understand AI-assisted merging.
