# Launching TeXRA: The AI Research Assistant That Understands LaTeX

**TL;DR**: We built specialized AI agents that live in VS Code and understand research workflows. TeXRA handles the LaTeX grunt work—notation fixes, TikZ compilation, parallel drafts, paper-to-slides conversion—while you stay in control.

---

## The Breaking Point

It's 11 PM. Your paper is due tomorrow. Your advisor just sent feedback:

> "Section 3 needs more mathematical detail. The notation is inconsistent—sometimes you use ρ, sometimes ϱ. Also, we need slides for Friday's talk. And can you generate a latexdiff showing changes since last week?"

You open ChatGPT. Copy-paste your LaTeX. Get a response. Copy it back. Realize it broke all your custom `\newcommand` macros. Try again. Lose context between messages. Manually track which version you're on. Give up and spend 3 hours doing it by hand.

**This is broken.**

## Why Existing Tools Fail

We've had GPT-4 and Claude for two years. So why hasn't anyone solved LaTeX writing?

**ChatGPT/Claude web interfaces**: You lose context every time you paste. No understanding of your `commands.tex` file. No way to track diffs. Can't compile TikZ figures. No integration with your actual `.tex` files.

**Generic VS Code AI extensions (Copilot, Cody)**: Great for code. Terrible for research. They don't understand `chktex` best practices. They can't run `latexdiff`. They have no concept of multi-file LaTeX projects with bibliography files and custom style files.

**Overleaf**: Doesn't have AI. Still requires manual editing.

**The fundamental problem**: Research writing isn't code autocomplete. It's a multi-step workflow involving:
- Document structure understanding (main file + references + auxiliaries)
- Domain-specific validation (LaTeX linting, notation consistency)
- Specialized transformations (paper → slides, extract TikZ, generate diffs)
- Iterative refinement with verifiable changes
- Model comparison (is Claude or o3 better for this section?)

No existing tool does this.

## What TeXRA Actually Does

TeXRA is purpose-built for research workflows. Here's what makes it different:

### 1. Specialized Agents, Not Generic AI

Instead of one model trying to do everything, TeXRA has **domain-specific agents**:

- **`correct` agent**: Fixes typos, notation inconsistencies, LaTeX errors. Enforces `chktex` compliance (non-breaking spaces in references, proper ellipsis, consistent math mode).

- **`polish` agent**: Chain-of-thought reasoning for prose improvements. First drafts a plan in a `<scratchpad>`, implements changes, then *reflects* on what it did and refines further.

- **`draw` agent**: Generates publication-ready TikZ diagrams from descriptions. Handles complex layouts (neural network architectures, quantum circuits, flowcharts).

- **`paper2slide` agent**: Converts your 30-page paper into 10-15 Beamer slides with proper structure, extracted equations, and figure references.

- **`ocr` agent**: Takes photos of handwritten math and outputs clean LaTeX.

- **`ask` and `chat` tool-use agents**: Interactive debugging. These agents have access to 15+ tools (`grep`, `texcount`, `extract_figures`, `web_search`, `download_arxiv_source`) and can reason through multi-step tasks.

Each agent is **configured via YAML**—you can define new agents without touching code.

### 2. LaTeX-Native Tool Integration

TeXRA isn't just prompting a model. It's a complete LaTeX processing pipeline:

**Automatic TikZ handling**:
```
User: "Make me a diagram of a neural network"
TeXRA draw agent:
  → Generates TikZ code
  → Extracts it into standalone document
  → Compiles to PDF
  → Converts to PNG for preview
  → Returns both LaTeX source and compiled figure
```

**Built-in diffing**:
Every agent run automatically generates `latexdiff` output with configurable granularity (off/whole/coarse/fine for math environments). You see exactly what changed, with red strikethrough and blue additions.

**Multi-file context awareness**:
TeXRA reads your entire project:
- `main.tex` (input file)
- `references.bbl` (bibliography)
- `commands.tex` (custom macros)
- Auxiliary files (style sheets, appendices)
- Figures (auto-extracted from `\includegraphics`)

The agent sees everything. No more "the model doesn't know my macros."

**Word counting and validation**:
Runs `texcount` automatically. Generates statistics (X words, Y equations, Z figures). Validates LaTeX syntax.

### 3. Reproducible Research Workflows

Academic writing demands **verifiability**. TeXRA treats every agent run as a scientific experiment:

- **Full execution logs**: Prompts, model responses, tool calls, token usage, timing
- **Replay capability**: Re-run any previous execution with different models or parameters
- **Diff comparison**: Visual side-by-side comparison in VS Code
- **Model A/B testing**: Run the same task with Claude Opus 4, OpenAI o3, and Gemini 2.5 Pro simultaneously. Compare outputs. Pick the best one.

Example workflow:
```
1. Select "polish_multiple" agent
2. Instruction: "Improve introduction clarity and add transition sentences"
3. Generate 2 parallel versions:
   - Version A: Claude Sonnet 4 (fast, cheap)
   - Version B: OpenAI o3 (reasoning model, expensive but thorough)
4. Review latexdiff for both
5. Merge best parts using the Merge agent
```

### 4. Multi-Model Economics

TeXRA supports 20+ frontier models across 8 providers:

- **Anthropic**: Claude Opus 4.1, Sonnet 4.5, Haiku 4.5 (all with thinking variants)
- **OpenAI**: GPT-5, o3/o1 reasoning models
- **Google**: Gemini 2.5 Pro/Flash
- **DeepSeek**: V3.1, R1 reasoning model
- **Others**: xAI Grok 4, Qwen, Kimi, OpenRouter

Why does this matter? **Cost-quality tradeoffs**:

- Quick typo fixes? → Haiku 4.5 ($0.25/M tokens)
- Critical section rewrite? → o3 reasoning model ($50/M tokens)
- Parallel drafts? → Run Gemini Flash + Sonnet side-by-side

You control the economics. TeXRA tracks token usage and costs per run.

## Real Examples

### Example 1: Notation Consistency

**Setup**: You wrote a quantum computing paper. Sometimes you use `|ψ⟩`, sometimes `\ket{\psi}`. Some references say "Fig. 3", others "Figure~\ref{fig:bloch}".

**With TeXRA**:
1. Add your paper to Input, `commands.tex` to Auxiliary
2. Choose `correct` agent with Claude Sonnet 4
3. Instruction: "Standardize all quantum states to use `\ket{}` and `\bra{}` notation. Fix cross-references to use non-breaking spaces."
4. Execute

**Result (30 seconds later)**:
- New `.tex` file with consistent notation
- Latexdiff PDF showing every change
- Log: "Changed 47 instances of `|...⟩` to `\ket{...}`, fixed 23 cross-references"
- Original preserved for rollback

### Example 2: Paper to Presentation

**Setup**: You need to defend your work at a conference. You have a 25-page paper. You need 12 slides by Friday.

**With TeXRA**:
1. Select your paper as Input
2. Choose `paper2slide` agent with Gemini 2.5 Pro
3. Instruction: "Generate a 12-slide Beamer presentation focusing on the main theorem and experimental results."
4. Execute

**Result**:
- Complete Beamer `.tex` file with:
  - Title slide
  - Motivation/problem statement (1-2 slides)
  - Key equations (extracted from paper)
  - Main theorem with proof sketch
  - Experimental results with figures
  - Conclusion
- Auto-extracted TikZ diagrams compiled to includable PDFs
- Full LaTeX source ready to compile

### Example 3: Interactive Debugging

**Setup**: Your LaTeX won't compile. You're getting cryptic errors about undefined references.

**With TeXRA**:
1. Open `chat` tool-use agent
2. Message: "Why am I getting 'undefined reference' warnings?"
3. Agent uses `grep` tool to search for `\ref{` patterns
4. Finds: You reference `\ref{eq:main_result}` but the label is `\label{eq:result}`
5. Agent proposes fix, you approve
6. Agent uses `edit_file` tool to correct it
7. Agent runs `texcount` to verify
8. Fixed in one conversation

## The Technical Innovation

What makes this possible? Four key architectural decisions:

### 1. Agent System with Reflection

TeXRA agents don't just generate text. They **think, plan, execute, and reflect**.

Example: `polish` agent workflow:
```
1. Read full document + references + auxiliaries
2. In <scratchpad>:
   - List specific improvements (e.g., "Add transition sentence between
     paragraphs 2 and 3 of Section 2.1")
   - Explain rationale
   - Plan implementation steps
3. Generate first draft
4. In second <scratchpad>:
   - Critically evaluate: "Did I follow instructions? Are changes coherent?"
   - List additional improvements
5. Generate refined version incorporating reflection
```

This chain-of-thought process produces **dramatically better** results than single-pass generation.

### 2. Tool-Use Architecture

Tool-use agents (`ask`, `chat`) run in an **agentic loop**:
```
User request
  → Model plans tool usage
  → Execute tools (grep, read_file, web_search, etc.)
  → Model receives tool results
  → Model reasons about results
  → Execute more tools OR return final answer
```

These agents can:
- Search your entire codebase for notation patterns
- Download arXiv papers and extract methodology
- Run Wolfram Alpha queries for symbolic math
- Compile TikZ figures and check output
- Edit files interactively with user confirmation

**Session persistence**: Tool-use conversations survive VS Code restarts. You can close your editor, come back tomorrow, and continue where you left off.

### 3. Streaming with Thinking Blocks

When you use reasoning models (Claude Thinking, o3, DeepSeek R1), TeXRA streams their internal reasoning in real-time:

```
Progress Board shows:
├─ Thinking: Analyzing notation consistency across equations...
├─ Thinking: Found 3 inconsistent symbols in Section 2...
├─ Output: Generating corrected LaTeX...
└─ Complete: 2847 tokens, $0.14, 23 changes
```

You see the model's thought process as it happens. This builds trust and lets you stop bad runs early.

### 4. Configuration-Driven Extensibility

All agents are defined in YAML. Want a custom agent for your subfield? Create `my_agent.yaml`:

```yaml
name: quantum_polish
settings:
  agentType: cot  # Chain-of-thought
  outputExt: tex
prompts:
  systemPrompt: |
    You are a quantum information theorist. Ensure all notation
    follows Nielsen & Chuang conventions.
  userRequest: |
    Review for quantum-specific issues:
    - Hilbert space dimensions
    - Trace preservation in CPTP maps
    - Proper use of partial trace notation
```

Add it to your workspace, and it appears in the agent picker. No coding required.

## Who This Is For

**Research scientists** writing papers in LaTeX (physics, math, CS, engineering)

**PhD students** who need to:
- Iterate quickly on drafts
- Generate slides for group meetings
- Keep notation consistent across 100+ page theses
- Respond to advisor feedback efficiently

**Academic groups** who want:
- Reproducible editing workflows
- Shared agent configurations (everyone uses the same `polish` agent)
- Cost tracking across projects
- Version control integration (every run is logged)

## Why This Matters

TeXRA represents a shift from **"AI as general tool"** to **"AI as domain specialist"**.

Generic AI is like hiring a random person off the street to edit your paper. Sometimes they're helpful. Often they break your LaTeX, misunderstand your field, or give generic advice.

TeXRA is like hiring a postdoc who:
- Knows LaTeX inside-out (chktex rules, notation standards, TikZ compilation)
- Understands research workflows (drafting, revision, slides, posters)
- Works in your environment (VS Code, your files, your tools)
- Documents everything (reproducible logs, diffs, comparisons)
- Never gets tired (parallel drafts, background processing)

And unlike a postdoc, you can run 10 versions in parallel and pick the best one.

## Getting Started

**Install from VS Code Marketplace**: [texra-ai.texra](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)

**Quick start**:
1. Run command: `TeXRA: Create Sample Project`
2. Follow the interactive walkthrough
3. Set your API keys (Anthropic, OpenAI, or Google)
4. Execute your first agent

**The sample project includes**:
- Pre-configured LaTeX document
- Example agents (correct, polish, draw)
- Step-by-step guide
- Full documentation

**Try risk-free**: TeXRA preserves originals and shows diffs before you commit. Every change is reversible.

## What's Next

We're actively building:
- **Collaborative workflows**: Share agent runs with co-authors
- **Multi-document projects**: Better support for books and theses
- **Custom tool creation**: Define your own tools for agents
- **LaTeX linting integration**: Real-time error detection
- **Template library**: Pre-built agents for common venues (NeurIPS, Physical Review, ACM)

## Join the Community

**Try TeXRA**: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=texra-ai.texra)

**Read the docs**: [texra.ai/guide](https://texra.ai/guide/)

**Questions or feedback**: [contact@texra.ai](mailto:contact@texra.ai)

---

If you've ever spent hours fixing LaTeX notation, wrestling with TikZ compilation, or copy-pasting into ChatGPT and losing context—TeXRA is for you.

**Built by researchers, for researchers.**

*TeXRA: The first AI assistant that actually understands your research workflow.*
