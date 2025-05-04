# Power Up Overleaf with TeXRA: A Git-Based Workflow

Overleaf is the go-to platform for collaborative LaTeX writing. But what if you could combine its convenience with the advanced AI editing, local tool integration (like `latexdiff`), and VS Code power offered by TeXRA? You can, using Overleaf\'s Git integration!

This guide outlines a workflow to clone your Overleaf project, leverage TeXRA locally in VS Code, and seamlessly sync your changes back. Get the best of both worlds: Overleaf for collaboration, TeXRA for AI-powered local editing.

## Why Bridge Overleaf and TeXRA?

- **AI Superpowers:** Apply TeXRA\'s specialized agents (`correct`, `polish`, `draw`, `paper2slide`, etc.) locally.
- **Local Tooling:** Use `latexdiff` for precise change tracking, local compilation for previews.
- **VS Code Environment:** Benefit from VS Code\'s features and extensions (like LaTeX Workshop).
- **Robust Git:** Employ granular version control, branching, and offline work locally.

## Prerequisites

- Overleaf account with Git access enabled for your project (check Overleaf plans).
- Git installed locally ([git-scm.com](https://git-scm.com/downloads)).
- TeXRA installed in VS Code ([Installation Guide](./installation.md)).

## Workflow Steps

### 1. Get Overleaf Git URL & Clone

1.  **Overleaf:** Go to your project > **Menu** > **Git**. Copy the Git **clone URL** (`https://git.overleaf.com/YOUR_PROJECT_ID`).
    ![Overleaf Git Menu](/images/overleaf-git.png)
2.  **Local Terminal:** Navigate to your desired local directory and run:
    ```bash
    git clone https://git.overleaf.com/YOUR_PROJECT_ID your-local-folder
    ```
    (Enter Overleaf credentials if prompted).

### 2. Edit Locally with TeXRA in VS Code

1.  Open `your-local-folder` in VS Code.
2.  Use TeXRA as usual:
    - Select files, agent, model.
    - Write instructions.
    - Execute (<i class="codicon codicon-play"></i>).
    - Review outputs (`*_r0_*.tex`, etc.).
    - Use `latexdiff` (<i class="codicon codicon-diff-single"></i>) or merge (<i class="codicon codicon-merge"></i>).
    - Leverage features like auto-extract (<i class="codicon codicon-wand"></i>) and tool options (<i class="codicon codicon-tools"></i>).
    - Optionally use LaTeX Workshop for local previews ([Setup](./latex-compilation.md)).

### 3. Commit Local Changes

As you work, commit changes frequently using VS Code\'s Source Control (<i class="codicon codicon-source-control"></i>) or the terminal:

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
- **Authentication:** Git may occasionally re-prompt for Overleaf credentials.
- **Large Projects:** Be mindful of potential Overleaf Git size limitations.

This Git-based workflow empowers you to enhance your Overleaf projects with TeXRA\'s powerful local AI and tooling capabilities, offering a flexible and efficient development cycle.

## Next Steps

- [Best Practices](./best-practices.md): Optimize your TeXRA usage.
- [LaTeX Diff](./latex-diff.md): Master change comparison.
- [Intelligent Merge](./intelligent-merge.md): Understand AI-assisted merging.
