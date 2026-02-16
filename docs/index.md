---
layout: home
hero:
  name: TeXRA
  text: Multi-Agent AI for Scientific Discovery
  tagline: An orchestrated team of AI agents that searches literature, drafts and verifies figures, polishes manuscripts, and builds presentations — compressing weeks of research work into hours.
  image:
    src: /logo-1024x1024.svg
    alt: TeXRA Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: Install from Marketplace
      link: vscode:extension/texra-ai.texra
    - theme: alt
      text: Try it on Web
      link: /launch
---

<div class="problem-section">

## Scientific discovery is bottlenecked by everything *around* the science

The hard part of research isn't having ideas — it's the months spent turning them into publications. Literature reviews that take weeks. Figures redrawn six times. Prose polished across dozens of revision cycles. Presentations rebuilt from scratch. Each step is manual, error-prone, and disconnects you from the thinking that matters.

General-purpose chatbots don't help. They hallucinate citations, lose context across files, and can't compile or verify anything. The research cycle needs AI that operates as a *system* — not a single prompt box.

</div>

<div class="solution-section">

## An AI research team that works like you do

TeXRA orchestrates **multiple specialized agents** inside VS Code — one that searches literature with grounded citations, another that generates and compiles figures, another that polishes prose while preserving every equation. Each agent reasons, uses tools, reflects on its own output, and produces auditable results you can verify with diffs.

The result: you stay in the discovery loop while agents handle the execution.

</div>

<div class="how-it-works">

### From idea to publication, accelerated

<div class="workflow-steps">
  <div class="workflow-step">
    <div class="step-number">1</div>
    <div class="step-content">
      <h3>Explore</h3>
      <p>Search agents sweep arXiv, Crossref, and your Zotero library — returning grounded citations, not hallucinations.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">2</div>
    <div class="step-content">
      <h3>Create</h3>
      <p>Agents draft prose, generate TikZ figures, build slide decks — compiling and visually verifying every artifact.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">3</div>
    <div class="step-content">
      <h3>Refine</h3>
      <p>Reflection loops iterate on quality. You review color-coded diffs of every change. Nothing is a black box.</p>
    </div>
  </div>
</div>

</div>

## Agents for every phase of research

<div class="agents-grid">

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">search</span>
      <span class="agent-type">Literature Discovery</span>
    </div>
    <h3>Literature Search</h3>
    <p>Sweeps arXiv, Crossref, and Zotero for relevant work. Returns real titles, abstracts, and BibTeX — grounded in actual databases, not model memory.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">research</span>
      <span class="agent-type">Open-ended Research</span>
    </div>
    <h3>Research Assistant</h3>
    <p>Your general-purpose research partner. Edits files, runs experiments, searches the web, manages references — multi-turn conversation with full tool access.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">draw</span>
      <span class="agent-type">Visualization</span>
    </div>
    <h3>Figure Generation</h3>
    <p>Turns natural-language descriptions into publication-ready TikZ diagrams. Compiles every figure and visually verifies the output before returning it.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">polish</span>
      <span class="agent-type">Manuscript Refinement</span>
    </div>
    <h3>Polish & Correct</h3>
    <p>Rewrites for clarity, fixes errors, improves flow — preserving every equation and citation. Outputs a reviewable diff so you control what lands.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">presenter</span>
      <span class="agent-type">Communication</span>
    </div>
    <h3>Paper to Slides</h3>
    <p>Reads your paper end-to-end, drafts a Beamer slide deck with TikZ diagrams, compiles it, and visually checks every page. Conference-ready in minutes.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">chat</span>
      <span class="agent-type">Brainstorming</span>
    </div>
    <h3>General Chat</h3>
    <p>Open-ended conversation with tool access. Brainstorm hypotheses, debug proofs, discuss methodology, or explore a new direction with your project context loaded.</p>
  </div>

</div>

## Built for how research actually works

<div class="differentiators">

  <div class="diff-item">
    <h3>Agents, not autocomplete</h3>
    <p>Each agent plans, executes, reflects, and iterates — the same loop a skilled collaborator would follow. Search agents verify citations against real databases. Writing agents compile and check their own output.</p>
  </div>

  <div class="diff-item">
    <h3>Auditable by design</h3>
    <p>Every agent run produces versioned output files, color-coded diffs, and full reasoning logs. Your co-authors and reviewers can trace exactly what changed and why — critical for reproducible science.</p>
  </div>

  <div class="diff-item">
    <h3>Your data stays yours</h3>
    <p>API calls go directly from your machine to providers (Anthropic, OpenAI, Google, etc.). No TeXRA servers in the middle. Your unpublished results and API keys never leave your environment.</p>
  </div>

  <div class="diff-item">
    <h3>Understands scientific documents</h3>
    <p>Built for LaTeX from day one. Agents reason across math environments, citation graphs, BibTeX files, TikZ figures, and multi-file projects — not just plaintext.</p>
  </div>

</div>

## Researchers using TeXRA

> **Exploring a new field.** A physicist pivoting into machine learning opens the `search` agent: "Find foundational and recent papers on neural operator methods for PDEs." In seconds she has 15 grounded references with abstracts and BibTeX — a literature map that would have taken a week of manual searching.

> **From idea to draft.** A postdoc has a new result but no paper. He opens the `research` agent, describes the theorem and proof sketch, and asks it to draft a LaTeX write-up with proper notation. The agent creates the file, structures the sections, and adds placeholder references. He then runs `polish` to tighten the prose. Two hours from idea to reviewable draft.

> **Communicating results.** A PhD student needs to present at a group meeting tomorrow. She opens `presenter`, points it at her latest paper, and asks for a 12-slide Beamer deck focused on the experimental results. The agent reads the paper, creates slides with TikZ recreations of her figures, compiles the PDF, and visually verifies every page. She spends her evening on the science, not on slide formatting.

<div class="cta-container">
  <a href="/guide/quick-start" class="cta-button">Quick Start Guide</a>
  <a href="/guide/built-in-agents" class="cta-button cta-button-alt">Browse All Agents</a>
</div>

<div class="faq-section">

## Common questions

**What models does it support?**
Anthropic Claude, OpenAI GPT, Google Gemini, DeepSeek, xAI Grok, and more via OpenRouter. Bring your own API key.

**Does it work with Overleaf?**
Yes. TeXRA integrates with Overleaf via git sync. See the [Overleaf guide](/guide/working-with-overleaf).

**Is my data private?**
All API calls go directly from your machine to the model provider. TeXRA does not operate any intermediate servers. Your documents and API keys never leave your machine except to the provider you choose.

**Can I build custom agents?**
Yes. Agents are configured via YAML files. You can modify built-in agents or create entirely new ones. See [Custom Agents](/guide/custom-agents).

**Where do I get help?**
Email [contact@texra.ai](mailto:contact@texra.ai) or open an issue on [GitHub](https://github.com/texra-ai/texra-issues).

</div>

<style>
/* Problem / solution sections */
.problem-section {
  max-width: 720px;
  margin: 0 auto 2rem;
  text-align: center;
}
.problem-section h2 {
  color: var(--vp-c-text-1);
  font-size: 1.5rem;
  margin-bottom: 0.75rem;
}
.problem-section p {
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.7;
}
.solution-section {
  max-width: 720px;
  margin: 0 auto 3rem;
  text-align: center;
}
.solution-section h2 {
  color: var(--vp-c-brand);
  font-size: 1.5rem;
  margin-bottom: 0.75rem;
}
.solution-section p {
  color: var(--vp-c-text-2);
  font-size: 1.05rem;
  line-height: 1.7;
}

/* How it works */
.how-it-works {
  max-width: 900px;
  margin: 0 auto 3rem;
}
.how-it-works h3:first-child {
  text-align: center;
  font-size: 1.3rem;
  margin-bottom: 1.5rem;
}
.workflow-steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.workflow-step {
  flex: 1;
  min-width: 200px;
  max-width: 250px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  background-color: var(--vp-c-bg-soft);
  padding: 1.25rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}
.step-number {
  font-size: 1.75rem;
  font-weight: 600;
  color: var(--vp-c-brand);
  margin-bottom: 0.5rem;
}
.step-content h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
  font-size: 1.1rem;
}
.step-content p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.4;
}
.workflow-arrow {
  font-size: 1.5rem;
  color: var(--vp-c-brand);
  display: flex;
  align-items: center;
}

/* Agent cards */
.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
  margin-top: 1.5rem;
  margin-bottom: 3rem;
}
.agent-card {
  background-color: var(--vp-c-bg-soft);
  padding: 1.25rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}
.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}
.agent-icon {
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  color: var(--vp-c-brand);
  background-color: var(--vp-c-bg-mute);
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
}
.agent-type {
  font-size: 0.75rem;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.agent-card h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
  font-size: 1.05rem;
}
.agent-card p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.9rem;
  line-height: 1.5;
}

/* Differentiators */
.differentiators {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.25rem;
  margin-top: 1.5rem;
  margin-bottom: 3rem;
}
.diff-item {
  padding: 1rem 0;
}
.diff-item h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
  font-size: 1.05rem;
  color: var(--vp-c-text-1);
}
.diff-item p {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.95rem;
  line-height: 1.6;
}

/* FAQ */
.faq-section {
  max-width: 720px;
  margin: 3rem auto;
}
.faq-section h2 {
  text-align: center;
  margin-bottom: 1.5rem;
}
.faq-section p {
  margin-bottom: 1rem;
  line-height: 1.6;
}
.faq-section strong {
  color: var(--vp-c-text-1);
}

/* CTAs */
.cta-container {
  display: flex;
  gap: 1rem;
  margin: 3rem 0;
  justify-content: center;
  flex-wrap: wrap;
}
.cta-button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  background-color: var(--vp-c-brand);
  color: white;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 0.2s;
}
.cta-button:hover {
  background-color: var(--vp-c-brand-dark);
}
.cta-button-alt {
  background-color: var(--vp-c-bg);
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-brand);
}
.cta-button-alt:hover {
  background-color: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-dark);
}

/* Responsive */
@media (max-width: 768px) {
  .workflow-steps {
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }
  .workflow-arrow {
    transform: rotate(90deg);
    margin: 0.25rem 0;
  }
  .workflow-step {
    width: 100%;
    max-width: 300px;
  }
}
</style>
