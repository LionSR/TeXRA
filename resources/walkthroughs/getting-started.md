# Welcome to TeXRA

TeXRA is your AI-powered LaTeX research assistant. It uses large language models to help you correct, polish, review, and restructure your academic papers — all within VS Code.

**The recommended way to use TeXRA** is through the **orchestrator** agent. It analyzes your paper, decides what needs to be done, and delegates work to specialized agents:

- **correct** -- fix grammar, structure, and LaTeX errors
- **polish** -- improve clarity, flow, and academic tone
- **draw** -- generate TikZ diagrams from descriptions or sketches
- **review** -- get critical, reviewer-style feedback
- **research** -- search literature and discuss topics

You can also run any of these agents individually for focused, single-task work.

## Getting started

Follow the checklist on the left. Each step links directly to the relevant command.

1. **Create the sample workspace** -- A bundled LaTeX project you can experiment with safely.
2. **Connect your API key** -- You need an API key from Anthropic, OpenAI, Google, or another supported provider. Note: chat subscriptions (ChatGPT Plus, Claude Pro, etc.) do **not** include API access -- you need a separate developer API key.
3. **Choose your files** -- Tell TeXRA which files to read: your manuscript (Input), references, auxiliary files, and media.
4. **Select the orchestrator** -- The recommended agent. It coordinates all the specialized agents on your behalf.
5. **Choose a mode preset** -- Pick a preset for your discipline (Physicist, Mathematician, Lean Project) to configure which agents the orchestrator can use.
6. **Auto-extract figures** -- Optionally let TeXRA find figures and TikZ blocks before editing.
7. **Run and approve proposals** -- The orchestrator proposes subtasks for you to approve, adjust, or reject in the Progress view.
8. **Review results** -- Compare generated files against your originals using VS Code's diff view.
9. **Archive or clean up** -- Save outputs to a `History/` folder with Pack, or delete them with Clean.

> **Tip:** You can reopen this walkthrough anytime from the Command Palette: **TeXRA: Open Getting Started**.
