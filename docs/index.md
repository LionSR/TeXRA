---
layout: home
hero:
  name: TeXRA
  text: AI Agents for Rigorous Research
  tagline: Specialized agents that search literature, generate and compile figures, verify proofs against Mathlib, run symbolic computation, and polish manuscripts — grounded in real tools, auditable at every step.
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

## The gap between your results and the published paper

You have the theorem. You have the computation. Now you need a 40-page manuscript where every `\label` resolves, every citation is real, notation is consistent from Definition 2.1 through Appendix C, the commutative diagrams compile, and the bibliography has no phantoms. You need to survey a field where 300 papers appeared this year. You need the Beamer deck that does the proof justice.

This is where general-purpose AI fails researchers. Chatbots hallucinate citations, can't parse multi-file LaTeX projects, don't know that your `\mathcal{O}` in Section 3 contradicts your `\mathscr{O}` in Section 7, and have no way to compile, verify, or diff anything. For work that demands precision — proofs, physical arguments, numerical methods — ungrounded AI is worse than useless.

</div>

<div class="solution-section">

## Agents with real tools, not a text box

TeXRA orchestrates **specialized agents** inside VS Code — each equipped with the tools your discipline actually uses. A search agent queries arXiv and Crossref and returns verified BibTeX. A figure agent generates TikZ — commutative diagrams, Feynman diagrams, phase portraits — and compiles every one. A Lean agent searches Mathlib by type signature and inspects proof states. A writing agent polishes prose, preserves all mathematics, and produces a diff you review line by line.

Every agent reasons, calls tools, reflects on its output, and iterates. Every result is versioned and auditable.

</div>

<div class="how-it-works">

### A system built around verification

<div class="workflow-steps">
  <div class="workflow-step">
    <div class="step-number">1</div>
    <div class="step-content">
      <h3>Ground</h3>
      <p>Search agents query arXiv, Crossref, and your Zotero library. Every citation is fetched from a real database — nothing is fabricated from model memory.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">2</div>
    <div class="step-content">
      <h3>Build</h3>
      <p>Agents draft LaTeX, generate TikZ figures, write Lean tactic proofs, run WolframScript computations — and compile every artifact to confirm it works.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">3</div>
    <div class="step-content">
      <h3>Verify</h3>
      <p>Reflection loops check their own output. You review color-coded diffs of every change. Lean diagnostics confirm the proof compiles. Nothing is a black box.</p>
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
    <p>Sweeps arXiv, Crossref, and Zotero for relevant work. Returns verified titles, abstracts, and BibTeX entries — grounded in actual databases. You get a structured literature map, not a list of plausible-sounding names.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">research</span>
      <span class="agent-type">Open-ended Research</span>
    </div>
    <h3>Research Assistant</h3>
    <p>Multi-turn agent with full tool access. Search Mathlib for a lemma by type signature, run a WolframScript computation, edit your LaTeX source, manage references — all in one conversation with persistent workspace context.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">draw</span>
      <span class="agent-type">Visualization</span>
    </div>
    <h3>Figure Generation</h3>
    <p>Generates publication-quality TikZ: commutative diagrams (<code>tikz-cd</code>), Feynman diagrams (<code>tikz-feynman</code>), phase portraits, lattice structures, numerical plots. Compiles every figure and visually verifies the PDF output.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">polish</span>
      <span class="agent-type">Manuscript Refinement</span>
    </div>
    <h3>Polish & Correct</h3>
    <p>Rewrites for clarity and precision — preserving every equation, theorem environment, and cross-reference. Catches notation drift across sections. Outputs a line-by-line diff so you control exactly what changes.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">presenter</span>
      <span class="agent-type">Communication</span>
    </div>
    <h3>Paper to Slides</h3>
    <p>Reads your paper end-to-end and drafts a Beamer deck that preserves the logical structure — definitions before theorems, diagrams redrawn in TikZ, key equations on their own slides. Compiles and visually checks every page.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">chat</span>
      <span class="agent-type">Technical Discussion</span>
    </div>
    <h3>Working Session</h3>
    <p>Open-ended conversation with your full project loaded. Work through a proof strategy, sanity-check a bound, explore whether a construction generalizes, or trace where a sign error propagates — with tool access throughout.</p>
  </div>

</div>

## Built for work that demands precision

<div class="differentiators">

  <div class="diff-item">
    <h3>Agents, not autocomplete</h3>
    <p>Each agent plans, executes, reflects, and iterates — the same loop a careful collaborator would follow. Search agents verify every citation against real databases. Writing agents compile and check their own LaTeX output. Nothing ships without verification.</p>
  </div>

  <div class="diff-item">
    <h3>Lean 4 and Mathlib integration</h3>
    <p>Search Mathlib theorems by type signature via Loogle. Inspect tactic proof states, check diagnostics, build projects, and fetch Mathlib cache — all from within your agent workflow. Formal verification as a first-class tool, not an afterthought.</p>
  </div>

  <div class="diff-item">
    <h3>Auditable by design</h3>
    <p>Every agent run produces versioned output files, color-coded diffs, and full reasoning traces. Your co-authors and referees can see exactly what changed and why. No black boxes in your publication pipeline.</p>
  </div>

  <div class="diff-item">
    <h3>Symbolic and numerical computation</h3>
    <p>Agents call WolframScript to evaluate integrals, check identities, simplify expressions, or verify numerical results. The computation runs on your machine — not approximated by a language model.</p>
  </div>

  <div class="diff-item">
    <h3>Your data stays yours</h3>
    <p>API calls go directly from your machine to the model provider you choose (Anthropic, OpenAI, Google, etc.). No TeXRA servers in the middle. Your unpublished results, proofs, and API keys never leave your environment.</p>
  </div>

  <div class="diff-item">
    <h3>Native LaTeX comprehension</h3>
    <p>Agents reason across theorem environments, <code>\label</code>/<code>\ref</code> graphs, BibTeX databases, TikZ source, and multi-file projects with <code>\input</code> and <code>\subfile</code> — not flattened plaintext.</p>
  </div>

</div>

## How researchers use TeXRA

> **Surveying a field with precision.** A mathematician studying optimal transport needs to understand recent connections to mean-field games. She runs the `search` agent across arXiv and Crossref with structured queries. The agent returns 20 verified references — real titles, real abstracts, real BibTeX — organized by relevance. She reviews the results, discards three that are tangential, and has a grounded related-work section anchored in the actual literature.

> **Maintaining consistency across a long manuscript.** A theoretical physicist is finalizing a 45-page paper on anomalies in 4d gauge theories. Notation has drifted: `\mathcal{A}` and `A_\mu` refer to the same connection in different sections, and two `\label` keys are duplicated. He runs `correct` on the full project. The agent identifies every inconsistency, proposes unified notation, and outputs a diff. He reviews each change before accepting — the content is his, the bookkeeping is handled.

> **Formalizing a result in Lean.** A researcher is writing a Lean 4 formalization of a combinatorial identity. She's stuck on which Mathlib lemma handles the inductive step. The `research` agent searches Loogle for `Finset.sum_bij`, inspects the type signature, and suggests the right import. She checks the proof state at the sticking point — the agent reads the goal and proposes a tactic sequence. The proof compiles.

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

**Does it work with Lean 4?**
Yes. TeXRA includes dedicated Lean tools: Loogle search for Mathlib theorems by type signature, LSP-based proof state inspection, diagnostics, project build and cache management. Requires the Lean 4 VS Code extension.

**Is my data private?**
All API calls go directly from your machine to the model provider. TeXRA does not operate any intermediate servers. Your documents and API keys never leave your machine except to the provider you choose.

**Can I build custom agents?**
Yes. Agents are configured via YAML files. You can modify built-in agents or create entirely new ones — for your specific subfield, notation conventions, or workflow. See [Custom Agents](/guide/custom-agents).

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
.how-it-works > h3 {
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
