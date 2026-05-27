# Lean 4 Proofs

You're formalizing a theorem and Lean is fighting you: the proof state isn't what you expected, you can't remember the name of the Mathlib lemma you need, and the build cache is stale. TeXRA drives a real Lean 4 language server so its agents can read compiler diagnostics, inspect the proof state at any point, search Mathlib, and manage your build — all without leaving your editor.

## Prerequisites

TeXRA doesn't ship a Lean toolchain — you bring your own. It then drives Lean in one of two ways, depending on how you run TeXRA.

::: tip You always need a Lake project
Lean tools only work on `.lean` files that live inside a **Lake project** — a folder (or ancestor folder) containing a `lakefile.lean` or `lakefile.toml`. If there's no lakefile, the language server has nothing to attach to. Create one with `lake new myproject` or `lake init`.
:::

### <wa-icon library="texra" name="beaker"></wa-icon> In VS Code

1. Install the official **Lean 4** extension (`leanprover.lean4`) from the Marketplace.
2. Open a folder containing a `lakefile.lean` or `lakefile.toml`.
3. The Lean 4 extension auto-installs **elan** and the Lean toolchain on first open.

TeXRA detects the running Lean 4 extension and routes its tools through it — so you share the exact same language server, diagnostics, and proof state you see in the editor.

<a href="https://marketplace.visualstudio.com/items?itemName=leanprover.lean4" target="_blank" style="display: inline-block; background-color: #007ACC; color: white; padding: 8px 12px; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 10px 0;">Install the Lean 4 extension</a>

### <wa-icon library="texra" name="terminal"></wa-icon> In the CLI or Desktop App

There's no Lean 4 extension to lean on, so TeXRA spawns its own server (`lake env lean --server`, one process per project). You need `lake` on your `PATH`:

1. Install **elan** (the Lean version manager):
   ```bash
   curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
   ```
2. Confirm it works in a fresh shell:
   ```bash
   lake --version
   ```
3. Open a folder containing a `lakefile.lean` or `lakefile.toml`.

If you don't have elan yet, see the [Lean community install guide](https://leanprover-community.github.io/install/).

## Activating Lean

There is **no switch to flip**. Lean support turns on automatically the moment a Lean-capable agent runs a Lean tool on a `.lean` file in a Lake project. To get going, just pick a Lean-capable agent (see below) and ask it to work on your proof.

::: tip Check that it's working
Open **Dashboard → Tools** (<wa-icon library="texra" name="tools"></wa-icon>) → **Lean 4 Proof Assistant** (<wa-icon library="texra" name="beaker"></wa-icon>) to confirm your setup is detected. The panel shows whether the Lean 4 extension is available (VS Code) or whether `lake` was found (CLI/desktop), and lists any active language servers — one per Lake project root.
:::

## Choosing an Agent

The built-in `lean` agent is always available. The **Lean Project** team adds four more agents — a `leanOrchestrator` plus the specialists it delegates to — which are [remote agents](./remote-agents.md), so [sign in](./remote-agents.md) to sync them.

| Agent              | Availability       | Best for                                                                 |
| ------------------ | ------------------ | ------------------------------------------------------------------------ |
| `lean`             | Built-in           | Writing and debugging proofs; iterating until a file compiles            |
| `leanSearch`       | Remote / Lean team | Finding the right Mathlib lemma, exploring APIs, formalization questions |
| `leanSimplifier`   | Remote / Lean team | Cleaning up proofs to Mathlib-quality, upstream-ready standards          |
| `leanBlueprint`    | Remote / Lean team | Building dependency-tracked LeanBlueprint LaTeX that bridges math ↔ Lean |
| `leanOrchestrator` | Remote / Lean team | Coordinating a whole formalization project across the agents above       |

To load the full set, open the **Multi-Agent** tab and select the **Lean Project** team. Formalizing a paper that's also part LaTeX? The **Mathematician** team bundles the `lean` agent alongside the LaTeX and research agents.

::: tip
Pick any agent from the **Agent** dropdown (<wa-icon library="texra" name="sparkle"></wa-icon>). Check **Dashboard → Agents** (<wa-icon library="texra" name="sparkle"></wa-icon>) to see exactly which tools each one has enabled.
:::

## What You Can Do

Just describe the task in plain language — the agent decides which tools to call. Here's what's happening under the hood.

### <wa-icon library="texra" name="alert"></wa-icon> Read Diagnostics

```
Check Proofs/GroupTheory.lean for errors and fix the first one.
```

The `lean_diagnostics` tool reports compilation errors, type mismatches, unsolved goals, warnings, and hints with their locations. Use it to check whether a file compiles after each change.

### <wa-icon library="texra" name="search"></wa-icon> Inspect the Proof State

```
What's the goal state at line 42 of Analysis/Limits.lean?
```

The `lean_inspect` tool reads the **tactic proof state** (`goal`), the **expected type** in term mode (`term_goal`), or the **type signature and docs** of an identifier (`hover`) at a given position — the same information Lean shows in its infoview.

### <wa-icon library="texra" name="book"></wa-icon> Search Mathlib

```
Find a Mathlib lemma that says the sum of two continuous functions is continuous.
```

The `lean_loogle` tool queries [Loogle](https://loogle.lean-lang.org/) to find lemmas by name, type signature, or the constants they mention — so the agent cites real Mathlib lemmas instead of inventing them.

### <wa-icon library="texra" name="sync"></wa-icon> Refresh a Stuck File

```
The diagnostics for this file look stale — restart the Lean server for it.
```

The `lean_file` tool runs file-scoped commands: `restart` (reload the language server for one file) and `refresh_dependencies` (a lighter refresh). Reach for these when results look out of date.

### <wa-icon library="texra" name="tools"></wa-icon> Manage the Project

```
Download the Mathlib build cache, then build the project.
```

The `lean_project` tool runs project-wide commands without a target file:

- **Server:** `restart_server`, `stop_server`
- **Build:** `build`, `clean`, `fetch_cache` (whole project), `fetch_file_cache` (current file's imports — faster)
- **Setup:** `install_elan`, `update_elan`, `install_deps`, `select_toolchain`

::: tip Build output
`lean_project`'s `build` command starts a build but doesn't capture its output. To see errors afterward, the agent runs `lean_diagnostics` on the relevant files (or `lake build` directly via the bash tool when it needs the raw log).
:::

## Troubleshooting

**"No Lean project found"** — The file isn't inside a Lake project. Make sure a `lakefile.lean` or `lakefile.toml` exists in the file's folder or an ancestor. Create one with `lake new` / `lake init`.

**"Failed to spawn `lake env lean --server`" (CLI/desktop)** — `lake` isn't on your `PATH`. Install elan and confirm `lake --version` works in a fresh shell.

**Tools fail in VS Code** — Install the **Lean 4** extension (`leanprover.lean4`) and open the project so its language server starts.

**Diagnostics look stale** — Ask the agent to run `lean_file` with `restart`, or `lean_project` with `restart_server`. A missing Mathlib cache can also cause long stalls — try `fetch_cache`.

**The Lean Project agents aren't in my list** — `leanSearch`, `leanSimplifier`, `leanBlueprint`, and `leanOrchestrator` are remote agents. [Sign in](./remote-agents.md) and select the **Lean Project** team to sync them. The built-in `lean` agent works without signing in.

## Next Steps

- [Built-in Agents](./built-in-agents.md) — full reference for the `lean` agent and others
- [Remote Agents](./remote-agents.md) — sign in to unlock the Lean Project specialist agents
- [Research Tools](./research-tools.md) — literature search, citations, and Wolfram verification
- [Workflow Agents](./agent-architecture.md) — how the orchestrator coordinates multi-agent runs
