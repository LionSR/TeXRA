# Welcome to TeXRA

TeXRA helps you write better papers. It uses AI to correct, polish, review, and restructure your LaTeX manuscripts -- right inside VS Code.

**The easiest way to start** is with the **orchestrator**. You give it your paper, it figures out what needs work, and hands each task to the right agent. You just approve the proposals as they come in.

You can also run individual agents yourself if you want to do one specific thing -- fix grammar, draw a diagram, get a review, etc.

## First-time setup

**The quickest path:** run the **Setup Assistant Agent**. It's a conversational agent that probes your environment, installs any missing LaTeX tools, sets up a credential, and verifies everything end-to-end.

- Command Palette > **TeXRA: Run Setup Assistant Agent (Setup Wizard)**, or click **Run Setup Assistant Agent** in the first step of the walkthrough on the left.
- The assistant asks before every command and explains what it's about to do. You stay in control.
- Already have LaTeX and a credential? It'll say so and skip straight to verification.

**Prefer to do it yourself?** The checklist on the left walks you through the same steps manually.

## Getting started

Follow the checklist on the left. Each step links to the right command.

1. **Run the setup assistant agent** -- One click; the setup assistant agent handles the rest. (Or skip and follow the manual steps below.)
2. **Try the sample project** -- A small LaTeX project you can play with safely.
3. **Add your API key** -- You'll need one from Anthropic, OpenAI, Google, or similar. Chat subscriptions (ChatGPT Plus, Claude Pro) don't include API access.
4. **Or just sign in** -- The Researcher Access Program gives you free model access, no API key needed. Signing in also unlocks extra agents.
5. **Pick your files** -- At minimum, just add your manuscript as an Input file.
6. **Use the orchestrator** -- It plans a pipeline and dispatches agents. Ask it which agent to use, or leave the instruction blank and the orchestrator decides.
7. **Pick your field** -- Choose a team (Physicist, Mathematician, Lean) so the orchestrator has the right tools.
8. **Auto-extract figures** -- Optional. Pulls out figures and TikZ blocks before editing.
9. **Hit Execute!** -- The orchestrator proposes tasks for you to approve in the Progress view. Press **y** to approve or **n** to reject.
10. **Check what it did** -- Compare the output against your original with VS Code's diff view.
11. **Clean up** -- Pack results into History, or delete them to start fresh.

> **Tip:** Reopen this walkthrough anytime: Command Palette > **TeXRA: Open Getting Started**.
