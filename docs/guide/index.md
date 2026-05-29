# TeXRA

A LaTeX research assistant for VS Code and the terminal. Multi-agent
workflows for writing, reviewing, formalizing, and rendering academic
work — with every change returned as a diff you approve.

<GuideIntroHero />

<p class="hero-caption">A single task, split across three specialists in the Progress view — click a delegation to see what it produced.</p>

## Get started

- [**Installation**](./installation.md) — VS Code extension or the `texra` CLI
- [**First run**](./first-run.md) — open a `.tex` file, watch one agent work
- [**Quick start**](./quick-start.md) — the longer walkthrough in VS Code

## Use it

| Task                                       | Workflow                                                      |
| ------------------------------------------ | ------------------------------------------------------------- |
| Tighten prose in a draft                   | [Polish a draft](./workflows/polish-a-draft.md)               |
| Fix LaTeX errors and notation              | `correct` agent — see [Built-in Agents](./built-in-agents.md) |
| Search literature, no fabricated citations | `search` — see [Research Tools](./research-tools.md)          |
| Verify proofs and derivations              | `review` — see [Built-in Agents](./built-in-agents.md)        |
| Formalize in Lean 4                        | [Lean 4 Proofs](./lean.md)                                    |
| Build slides from a paper                  | `paper2slide` — see [Built-in Agents](./built-in-agents.md)   |
| Generate TikZ figures                      | [TikZ Figures](./tikz-figures.md)                             |

## Understand the system

- [**Built-in Agents**](./built-in-agents.md) — the full catalog
- [**Agent Architecture**](./agent-architecture.md) — workflow vs. tool-use, reflection, planning
- [**Models**](./models.md) — picking a model for the job
- [**Custom Agents**](./custom-agents.md) — define your own in YAML

## Why multi-agent

The gap between a result and a publishable manuscript is where most
research time goes. A 40-page paper where notation must be consistent
from Definition 2.1 through Appendix C. A bibliography where every
`\cite` resolves to a real paper. Commutative diagrams that compile.
A Lean formalization where the proof state needs careful tactic
selection.

General-purpose chatbots make this worse, not better:

- **Hallucinated citations** — no grounded search means fabricated references.
- **Lost structure** — one prompt can't reason across theorem environments, `\label`/`\ref` graphs, BibTeX, and multi-file projects at once.
- **No verification** — text output with no way to compile, diff, or type-check what changed.
- **No tools** — no Mathlib search by type signature, no WolframScript, no TikZ compile.

TeXRA solves this by splitting the work across agents — each
specialized, each grounded in real tools, each producing verifiable
output.

## Two surfaces, one system

The VS Code extension and the `texra` CLI share the same agents, the
same sign-in, and the same run history. A run started in the CLI shows
up in the extension's Progress Board, and vice versa.

```mermaid
graph TB
    User[User] --> |selects files + agent| Orchestrator[Agent Orchestrator]
    Orchestrator --> WA[Workflow Agents]
    Orchestrator --> IA[Tool-use Agents]

    WA --> |polish, correct, merge| Output[Versioned Output Files]
    Output --> Diff[Color-Coded Diff]

    IA --> Tools[Tool Access]
    Tools --> Search[arXiv / Crossref / Zotero]
    Tools --> Lean[Lean 4 / Loogle / Mathlib]
    Tools --> Wolfram[WolframScript]
    Tools --> Compile[LaTeX Compilation]
    Tools --> FileOps[File Operations]
    Tools --> Shell[Shell Commands]
```

**Workflow agents** (`polish`, `correct`, `merge`, `ocr`,
`transcribe_audio`, `paper2slide`, `paper2poster`) run a structured
pipeline and write task-scoped output files with diffs.

**Tool-use agents** (`research`, `numerics`, `review`, `lean`,
`presenter`, `latexFixer`, `creator`, `chat`, `setup`) work
conversationally — they read and edit workspace files, search arXiv
and Crossref, query Mathlib by type signature, compile LaTeX, and run
WolframScript.

The system rests on three established AI design patterns: **reflection**
(agents critique their own output and iterate), **tool use** (agents
ground their reasoning in verified data from compilers, LSPs, and search
APIs), and **planning** (agents decompose tasks, execute steps, and
adapt to intermediate results).

## Who uses TeXRA

- **Mathematicians** — papers with complex theorem environments, notation consistency across long proofs, Lean 4 formalization.
- **Theoretical physicists** — multi-file manuscripts with extensive equation environments, Feynman diagrams, large bibliographies.
- **Computational scientists** — papers combining numerical methods, algorithm descriptions, convergence plots, reproducible workflows.
- **PhD students** — thesis chapters with consistent notation, literature surveys in new subfields, seminar talks from written work.
- **Research groups** — collaborations where every change is traceable and auditable by co-authors and referees.

## Privacy and data handling

**Bring-your-own-key mode.** API calls go directly from your machine
to the model provider you chose. TeXRA does not sit between you and
the provider. Your unpublished proofs, manuscripts, and API keys
never leave your machine except to the provider endpoint.

**Hosted access** (signed in with GitHub or Google). Requests to
hosted models are proxied through TeXRA's service so we can manage
provider credentials and quota on your behalf. Switch any run back
to direct mode with `--api-mode personal` (CLI) or by providing your
own key in Settings (extension).

API keys, whichever mode you use, are stored in your operating
system's secure credential store — VS Code's built-in Secret Storage
in the extension, the OS keychain (or a local config file) for the
CLI. They can also be supplied via environment variables or a `.env`
file in your project.

## Support

Issues and feature requests: [GitHub](https://github.com/texra-ai/texra-issues).
Contact: [contact@texra.ai](mailto:contact@texra.ai).
