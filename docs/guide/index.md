<script setup>
import RunParityHero from '../.vitepress/components/RunParityHero.vue';
</script>

# TeXRA

An AI theorist for VS Code, the desktop app, and the terminal. It
attempts real theory work (deriving results, checking derivations,
formalizing proofs in Lean 4) and takes on open problems in long
autonomous runs with a team of specialist agents. Paper editing, LaTeX
tooling, and figures come along as supporting capabilities.

<GuideIntroHero />

<p class="hero-caption">A single task, split across three specialists in the Progress view. Select a delegation to see what it produced.</p>

## Get started

- [**Installation**](./installation.md): VS Code extension or the `texra` CLI
- [**First run**](./first-run.md): open a `.tex` file, watch one agent work
- [**Quick start**](./quick-start.md): the longer walkthrough in VS Code

## Use it

| Task                                       | Workflow                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| Verify proofs and derivations              | `review`, see [Built-in agents](./built-in-agents.md)        |
| Formalize in Lean 4                        | [Lean 4 proofs](./lean.md)                                   |
| Search literature, no fabricated citations | `assistant`, see [Research tools](./research-tools.md)       |
| Tighten prose in a draft                   | [Polish a draft](./workflows/polish-a-draft.md)              |
| Fix LaTeX errors and notation              | `correct` agent, see [Built-in agents](./built-in-agents.md) |
| Build slides from a paper                  | `paper2slide`, see [Built-in agents](./built-in-agents.md)   |
| Generate TikZ figures                      | [TikZ figures](./tikz-figures.md)                            |

## Understand the system

- [**Built-in agents**](./built-in-agents.md): the full catalog
- [**Agent architecture**](./agent-architecture.md): workflow vs. tool-use, reflection, planning
- [**Multi-agent workflows**](./multi-agent-workflows.md): how a team lead fans work out to specialists in parallel
- [**Models**](./models.md): picking a model for the job
- [**Custom agents**](./custom-agents.md): define your own in YAML

## Why multi-agent

Theory work is long chains of dependent steps. A derivation where one
sign error in section 3 invalidates appendix C. A Lean formalization
where the proof state needs careful tactic selection. A numerical
cross-check that has to agree with the closed form. And then the
manuscript: notation consistent from Definition 2.1 onward, every
`\cite` resolving to a real paper, diagrams that compile.

General-purpose chatbots make this worse, not better:

- **Hallucinated citations**: no grounded search means fabricated references.
- **Lost structure**: one prompt can't reason across theorem environments, `\label`/`\ref` graphs, BibTeX, and multi-file projects at once.
- **No verification**: text output with no way to check an algebra step, type-check a proof, or diff what changed.
- **No tools**: no WolframScript, no Mathlib search by type signature, no compiler in the loop.

TeXRA splits the work across agents, each specialized, each grounded
in real tools, each producing verifiable output.

## Two surfaces, one system

The VS Code extension and the `texra` CLI share the same agents, the
same sign-in, and the same run history. A run started in the CLI shows
up in the extension's ProgressBoard, and vice versa.

<RunParityHero />

<p class="hero-caption">One run, two surfaces: the same execution id lands in the terminal's output and the extension's Progress view.</p>

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

TeXRA's agents come in two classes:

<AgentClasses />

<p class="hero-caption">Workflow agents run a structured pipeline and return a diff; tool-use agents work conversationally with grounded tools.</p>

The system rests on three established AI design patterns: **reflection**
(agents critique their own output and iterate), **tool use** (agents
ground their reasoning in verified data from compilers, LSPs, and search
APIs), and **planning** (agents decompose tasks, execute steps, and
adapt to intermediate results).

## Who uses TeXRA

<FeatureCards
  min="220px"
  :cards="[
    {
      icon: 'book',
      title: 'Mathematicians',
      desc: 'Complex theorem environments, notation consistency across long proofs, Lean 4 formalization.',
    },
    {
      icon: 'bolt',
      title: 'Theoretical physicists',
      desc: 'Multi-file manuscripts with heavy equation environments, Feynman diagrams, large bibliographies.',
    },
    {
      icon: 'chart-line',
      title: 'Computational scientists',
      desc: 'Numerical methods, algorithm descriptions, convergence plots, reproducible workflows.',
    },
    {
      icon: 'graduation-cap',
      title: 'PhD students',
      desc: 'Thesis chapters with consistent notation, literature surveys in new subfields, talks from written work.',
    },
    {
      icon: 'users',
      title: 'Research groups',
      desc: 'Collaborations where every change is traceable and auditable by co-authors and referees.',
    },
  ]"
/>

## Privacy and data handling

**Bring-your-own-key mode.** API calls go directly from your machine
to the model provider you chose. TeXRA does not sit between you and
the provider. Your unpublished proofs, manuscripts, and API keys
never leave your machine except to the provider endpoint.

**Provider subscriptions** (ChatGPT, Grok, Kimi Code, GLM Coding Plan,
and GitHub Copilot in VS Code). Requests still go straight from your
machine to that provider: ChatGPT and Grok via OAuth sign-in, Kimi Code
and the GLM Coding Plan via a plan-specific key. In the VS Code extension
the **Dashboard → Subscriptions** tab can also route models through a
GitHub Copilot subscription, with no provider API key needed. Connect one
from that tab, or with `texra auth chatgpt login` / `/api` in the CLI.

API keys, whichever mode you use, stay on your machine: VS Code's
built-in Secret Storage in the extension, an owner-only `secrets.json`
under `~/.texra` for the CLI. You can also supply them via environment
variables or a `.env` file in your project (extension only).

## Support

Issues and feature requests: [GitHub](https://github.com/LionSR/TeXRA).
Contact: [contact@texra.ai](mailto:contact@texra.ai).
