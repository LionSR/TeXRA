# Welcome to TeXRA

TeXRA helps you write better papers. It uses AI to correct, polish, review, and restructure your LaTeX manuscripts -- right inside VS Code.

The shortest path is: choose a credential, run setup once, then let the orchestrator handle the daily paper work.

## 1. Choose a credential

A credential is the one step no agent can do for you. Three ways in:

- **Use ChatGPT subscription** -- ChatGPT Plus/Pro/Team can route Codex models through your ChatGPT plan.
- **Sign in with Researcher Access** -- Free for academics; no API key needed. Signing in also unlocks remote agents, including the orchestrator.
- **Use your own provider API key** -- Anthropic, OpenAI, Google, and more. Except for Codex through ChatGPT subscription, chat subscriptions (Claude Pro, ChatGPT for non-Codex models, etc.) do not include API access; you need a key from the provider's developer platform.

You can also pick **Skip for now** and come back later, but nothing below runs without a credential.

## 2. The setup assistant takes it from here

Once a credential is in place, one conversation covers the rest. The setup assistant:

- checks your environment and installs any missing LaTeX tools,
- asks what you're working on and applies the matching team,
- runs your first task -- a polish pass on your draft or the sample project -- and lands you at a diff,
- then hands off to the orchestrator for daily work.

It asks before every command and explains what it's about to do. You stay in control.

- Command Palette > **TeXRA: Run Setup Assistant**, or click **Run Setup Assistant** in the walkthrough step on the left.
- Already have LaTeX and a credential? It'll say so and skip straight to your first run.

## 3. Meet the orchestrator

After setup, the **orchestrator** is the habit. You don't pick from 23 agents -- give it your paper, it figures out what needs work, and hands each task to the right agent. You just approve the proposals as they come in. On your own API key, start with **assistant** instead; the orchestrator is served through Researcher Access.

You can still run any single agent yourself when you want one specific thing -- fix grammar, draw a diagram, get a review.

## Prefer to do it manually?

The remaining steps in the checklist on the left mirror what the setup assistant does, for when you'd rather drive yourself:

1. **Try the sample project** -- a small LaTeX project you can play with safely.
2. **Pick your files** -- at minimum, just add your manuscript as an Input file.
3. **Auto-extract figures** -- optional; pulls out figures and TikZ blocks before editing.
4. **Hit Execute!** -- the orchestrator proposes tasks for you to approve in the Progress view. Press **y** to approve or **n** to reject.
5. **Check what it did** -- compare the output against your original with VS Code's diff view.
6. **Clean up** -- pack results into History, or delete them to start fresh.

> **Tip:** Reopen this walkthrough anytime: Command Palette > **TeXRA: Open Getting Started Walkthrough**.
