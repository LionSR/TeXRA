<script setup>
import LeanToolsHero from '../.vitepress/components/LeanToolsHero.vue';
import LeanProofHero from '../.vitepress/components/LeanProofHero.vue';
import LeanProjectCommands from '../.vitepress/components/LeanProjectCommands.vue';
import CliLeanHero from '../.vitepress/components/CliLeanHero.vue';
</script>

# Lean 4 proofs

TeXRA runs a Lean 4 language server for your project so the assistant can read compiler diagnostics, inspect tactic goal states at any cursor position, search Mathlib via Loogle, and run project builds.

## Prerequisites

Every build (VS Code, the desktop app and the CLI) drives Lean the same way: it spawns its own headless server process (`lake env lean --server`), one per Lake project, which stops when the last run using it ends. So the one thing TeXRA needs is `lake` on your `PATH`.

::: tip You always need a Lake project
Lean tools only work on `.lean` files that live inside a **Lake project**: a folder (or ancestor folder) containing a `lakefile.lean` or `lakefile.toml`. If there's no lakefile, the language server has nothing to attach to. Create one with `lake new myproject` or `lake init`.
:::

1. Install **elan** (the Lean version manager):
   ```bash
   curl https://elan.lean-lang.org/elan-init.sh -sSf | sh
   ```
   In VS Code, the official **Lean 4** extension (`leanprover.lean4`) can install elan and the Lean toolchain for you when you first open a Lean file; it is also the editor you will want for reading proofs, but TeXRA's tools do not go through it.
2. Confirm it works in a fresh shell:
   ```bash
   lake --version
   ```
3. Open a folder containing a `lakefile.lean` or `lakefile.toml`.

<CliLeanHero />

<p class="hero-caption">No extension underneath: TeXRA talks to Lake directly, and the same <code>lean_*</code> tools run against its own server process in every build.</p>

If you don't have elan yet, follow the [Lean community install guide](https://leanprover-community.github.io/install/).

## Activating Lean

There is **no switch to flip**. Lean support turns on the moment the assistant runs a Lean tool on a `.lean` file in a Lake project: ask it to work on your proof.

::: tip Check that it's working
Open **Settings → Plugins** (<wa-icon library="texra" name="cube"></wa-icon>) → **Lean 4 Proof Assistant** (<wa-icon library="texra" name="beaker"></wa-icon>) to confirm your setup is detected. The panel shows whether `lake` was found and lists any active language servers.
:::

## Working on proofs

Ask the assistant: it uses the Lean tools below whenever `lake` is found, so
the same conversation can search Mathlib, write and debug a proof, clean it up
to Mathlib style, and edit the LaTeX paper it formalizes. For a whole
formalization project it can split the work across helper agents
([Multi-agent workflows](./multi-agent-workflows.md)), and for a job with a
built-in check it starts one of the Lean programs.

## Lean programs

The Lean plugin also ships two programs: fixed procedures that check their own work with Lean's tools before they hand it back. Each runs a helper agent on the files you name, then checks the result; when the check fails, the helper gets another round with the findings.

| Program     | What it does                                                                  | How it checks each round                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prove`     | Completes the proofs in the `.lean` files you pass, keeping their statements. | Lean's diagnostics for every file: no error and no `sorry`, and no `axiom` declared in a file that was not there before. Up to three rounds.                        |
| `blueprint` | Writes or brings up to date a LeanBlueprint document (its `.tex` files).      | `leanblueprint web` builds it and `leanblueprint checkdecls` finds every `\lean` declaration in the built project. Up to two rounds. Needs the `leanblueprint` CLI. |

The instruction narrows the job ("prove only `oddSum_eq_sq`", "add entries for the new lemmas in `Basic.lean`"). Each program answers with its check's verdict and the agent's account of what it did. A new blueprint starts from `leanblueprint new`; pass the files it creates. `blueprint` stops at once if `leanblueprint` is not installed (`pip install leanblueprint`). `prove` finds a new axiom by reading the files you pass, so it does not see one declared in another file they import; `#print axioms` on a theorem is the full answer. The assistant is told of the two programs only where `lake` is found, as it is offered the Lean tools only there.

```bash
texra run prove --input Proofs/Basic.lean --instruction "Prove the two lemmas about oddSum"
texra run blueprint --input blueprint/src/content.tex
```

Both programs are always registered: `texra run` lists them beside the document programs, with or without Lean installed. `prove` needs `lake` on your `PATH`, since its check is Lean's own diagnostics. In the app, ask the assistant for the job (for example "finish the proofs in Proofs/Basic.lean") and it proposes the program.

## What you can do

Describe the task in plain language; the assistant decides which tools to call. Below are the five Lean tools it reaches for, as they surface in the tool-call log.

<LeanToolsHero />

<p class="hero-caption">The agent picks the tool (read diagnostics, inspect the proof state, search Mathlib, refresh a file, or manage the build) and you watch each call land in the run log.</p>

### <wa-icon library="texra" name="alert"></wa-icon> Read diagnostics

```
Check Proofs/GroupTheory.lean for errors and fix the first one.
```

The `lean_diagnostics` tool reports compilation errors, type mismatches, unsolved goals, warnings, and hints with their locations. Use it to check whether a file compiles after each change.

### <wa-icon library="texra" name="search"></wa-icon> Inspect the proof state

```
What's the goal state at line 42 of Analysis/Limits.lean?
```

The `lean_inspect` tool reads the **tactic proof state** (`goal`), the **expected type** in term mode (`term_goal`), or the **type signature and docs** of an identifier (`hover`) at a given position: the same information Lean shows in its infoview.

<LeanProofHero />

<p class="hero-caption">The agent reads the unsolved-goals diagnostic, inspects the goal state, finds the right lemma, and iterates the proof until it compiles with 0 errors and 0 <code>sorry</code>.</p>

### <wa-icon library="texra" name="book"></wa-icon> Search Mathlib

```
Find a Mathlib lemma that says the sum of two continuous functions is continuous.
```

The `lean_loogle` tool queries [Loogle](https://loogle.lean-lang.org/) to find lemmas by name, type signature, or the constants they mention, so the agent cites real Mathlib lemmas instead of inventing them. Like the other Lean tools, it is offered only when Lean support is available (`lake` on your `PATH`).

### <wa-icon library="texra" name="sync"></wa-icon> Refresh a stuck file

```
The diagnostics for this file look stale. Restart the Lean server for it.
```

The `lean_file` tool restarts the language server's state for one file: it closes the file and opens it again, so Lean re-elaborates it and re-reads its imports. Use it when results look out of date.

### <wa-icon library="texra" name="tools"></wa-icon> Manage the project

```
Download the Mathlib build cache, then build the project.
```

The `lean_project` tool runs project-wide commands without a target file, grouped into server control and project operations:

<LeanProjectCommands />

<p class="hero-caption">Both groups run in every build. <code>fetch_cache</code> pulls the Mathlib build cache for the whole project.</p>

::: tip Toolchain setup
In VS Code, the setup assistant can run the Lean 4 extension's installers (install or update elan, install dependencies, select the default toolchain). In any build, you can manage your toolchain with `elan` and `lake` directly (for example `elan self update`, `elan toolchain install`, or `lake update`). Follow the [Lean install guide](https://leanprover-community.github.io/install/).
:::

::: tip Build output
`lean_project`'s `build` command starts a build but doesn't capture its output. To see errors afterward, the agent runs `lean_diagnostics` on the relevant files (or `lake build` directly via the bash tool when it needs the raw log).
:::

## Troubleshooting

**"No Lean project found"**: the file isn't inside a Lake project. Make sure a `lakefile.lean` or `lakefile.toml` exists in the file's folder or an ancestor. Create one with `lake new` / `lake init`.

**"Failed to spawn `lake env lean --server`"**: `lake` isn't on your `PATH`. Install elan and confirm `lake --version` works in a fresh shell.

**Lean shows "Needs setup" in VS Code with the Lean 4 extension installed**: the extension is not what TeXRA's tools run on. Make sure `lake --version` works in a fresh login shell. The TeXRA service reads its `PATH` from your login shell when it starts, so after installing elan run `texra service restart` (see [the CLI guide](./texra-cli.md)) and reload the VS Code window.

**Diagnostics look stale**: ask the agent to run `lean_file` on the file, or `lean_project` with `restart_server`. A missing Mathlib cache can also cause long stalls; run `fetch_cache`.

## Next steps

- [The assistant and programs](./programs.md): every program, Lean's included
- [Research tools](./research-tools.md): literature search, citations, and Wolfram verification
- [Multi-agent workflows](./multi-agent-workflows.md): how the assistant splits a large job
