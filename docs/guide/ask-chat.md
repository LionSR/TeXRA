# Ask & Chat Agents

Meet the conversational duo that powers TeXRA's day-to-day research loops. `ask` scouts, cites, and keeps its hands off the keyboard; `chat` plans, edits, and wields tools with surgical precision. Together they let you interrogate a project, run derivations, and apply fixes without losing the thread—or the audit trail.

## Why two agents?

Think of `ask` as your cautious postdoc and `chat` as the labmate who insists on touching everything (but signs their work). Splitting the roles keeps reconnaissance safe while giving you a buttoned-up environment for actual modifications.

| Agent | Access Level | Typical Use | Tool Loadout |
|-------|--------------|-------------|---------------|
| `ask` | Read-only | Reconnaissance, contextual Q&A, citing prior results | `read_file`, `glob`, `grep`, `ls` |
| `chat` | Read/Write + execution | Derivations, file edits, shell commands, multi-step plans | Everything from `ask` plus `write_file`, `edit_file`, `bash`, `file_op`, and friends |

Both agents stream their actions into the ProgressBoard so you can replay every tool call later. No hidden keystrokes, no mystery shell sessions.

## `ask`: the research scout

- **Use it when** you need to comb through proofs, inspect notes, or quote a reference without altering anything.
- **Best prompts** are pointed questions: “List every occurrence of `\alpha_k` in `chapter2.tex`,” “Summarize the boundary conditions defined in `appendix/bc.tex`,” or “Show the last update to the bibliography.”
- **Output style** favors direct citations and short summaries. When math appears, `ask` mirrors the source rather than inventing new derivations.
- **Paging through files**: `read_file` returns the first 400 lines by default. Ask for `range: {"start": 401, "end": 520}` to inspect later sections while keeping responses digestible.

`ask` shines when you want to build a plan or gather context before involving more invasive agents.

## `chat`: the tool-wielding scientist

- **Use it when** you are ready to transform the workspace: running derivations, applying patches, scripting quick experiments, or coordinating follow-up agents.
- **Tool arsenal** includes file writers, shell commands (`bash`), templated edits (`edit_file`), and everything `ask` can already do.
- **Derivation etiquette**: TeXRA nudges `chat` to render math inside `\begin{aligned} … \end{aligned}` blocks. This keeps indices aligned and makes copy-paste into LaTeX painless.
- **Safety rails**: All edits happen within the VS Code workspace, and every command is echoed in the log. If you dislike a change, revert using your usual Git or filesystem tooling.

When `chat` finishes a run, the resulting files and diffs appear alongside the tool log so you can verify the outcome immediately.

## Switching between them

1. **Scout with `ask`** – Gather lemmas, locate relevant files, and outline the approach.
2. **Promote to `chat`** – Reference the discoveries from `ask`, then execute the plan with edits, derivations, or shell commands.
3. **Hand off to a specialist** – Once the heavy lifting is done, call in agents like `polish`, `correct`, or `derive` for targeted follow-ups.

Because both agents operate within the same workspace context, you can shuttle instructions between them without manually restating file paths.

## Derivation playbook

When you need crisp math steps:

1. Ask `ask` to restate the assumptions and list the relevant equations.
2. Switch to `chat` with a prompt such as:

   ```
   Using the boundary conditions from Section 3 and Equation (7), derive the normal mode frequencies.
   Present the work in an aligned environment and explain any index relabeling.
   ```

3. Review the resulting `\begin{aligned}` block, then copy it directly into your manuscript or pass it to the `derive` agent for further refinement.

This handshake keeps exploratory reasoning separate from executable edits while still delivering math you can defend.

## Limitations to remember

- `ask` will never edit files or run shell commands—if you need changes, escalate to `chat`.
- `chat` respects the same 400-line paging limits when reading files; request ranges for deep dives.
- Neither agent fabricates features: if a tool is unavailable, the log will say so, and the agent will explain the gap.

Lean on this duo as your daily driver, and the rest of TeXRA's agent roster becomes a finishing toolkit rather than a first resort.
