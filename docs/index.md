---
layout: home
hero:
  name: TeXRA
  text: Multi-Agent AI for Scientific Discovery
  tagline: Specialized AI agents that read your papers, search literature, generate figures, and polish your LaTeX — orchestrated in reproducible workflows.
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

## Researchers waste hours on formatting, not discovery

You spend your best thinking time wrestling with LaTeX, hunting for references, and manually polishing prose. General-purpose chatbots lose context across files, hallucinate citations, and can't compile your documents. You need AI that understands academic workflows end-to-end.

</div>

<div class="solution-section">

## TeXRA: a team of specialized agents, not a single chatbot

TeXRA orchestrates **multiple specialized agents** inside VS Code — each designed for a specific part of the research lifecycle. Agents share context, use tools, and produce auditable outputs you can verify with diffs.

</div>

<div class="how-it-works">

### How it works

<div class="workflow-steps">
  <div class="workflow-step">
    <div class="step-number">1</div>
    <div class="step-content">
      <h3>Select files & agent</h3>
      <p>Pick your LaTeX files, references, and figures. Choose a specialized agent for the task.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">2</div>
    <div class="step-content">
      <h3>Agents execute</h3>
      <p>Agents reason, call tools (compile, search, verify math), and iterate through reflection loops.</p>
    </div>
  </div>
  <div class="workflow-arrow">&rarr;</div>
  <div class="workflow-step">
    <div class="step-number">3</div>
    <div class="step-content">
      <h3>Review & verify</h3>
      <p>Every change is captured in a color-coded diff. Logs, reasoning, and outputs are fully transparent.</p>
    </div>
  </div>
</div>

</div>

## The agent team

<div class="agents-grid">

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">polish</span>
      <span class="agent-type">Workflow Agent</span>
    </div>
    <h3>Polish & Correct</h3>
    <p>Improves clarity, fixes grammar, repairs LaTeX errors — while preserving all math and technical content. Outputs a reviewable diff.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">search</span>
      <span class="agent-type">Interactive Agent</span>
    </div>
    <h3>Literature Search</h3>
    <p>Searches arXiv, Crossref, and your Zotero library. Returns titles, abstracts, and BibTeX entries — no hallucinated citations.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">draw</span>
      <span class="agent-type">Workflow Agent</span>
    </div>
    <h3>Figure Generation</h3>
    <p>Creates TikZ diagrams from natural language descriptions. Compiles and visually verifies every figure before returning it.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">presenter</span>
      <span class="agent-type">Interactive Agent</span>
    </div>
    <h3>Paper to Slides</h3>
    <p>Reads your paper, drafts a Beamer slide deck with TikZ diagrams, compiles it, and checks every page visually.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">research</span>
      <span class="agent-type">Interactive Agent</span>
    </div>
    <h3>Research Assistant</h3>
    <p>Edits files, runs shell commands, searches the web, and manages references — all in one conversation with tool access.</p>
  </div>

  <div class="agent-card">
    <div class="agent-header">
      <span class="agent-icon">chat</span>
      <span class="agent-type">Interactive Agent</span>
    </div>
    <h3>General Chat</h3>
    <p>Open-ended conversation with full tool access. Ask questions, brainstorm ideas, or get help with any part of your project.</p>
  </div>

</div>

## Why researchers choose TeXRA

<div class="differentiators">

  <div class="diff-item">
    <h3>Reproducible, not magic</h3>
    <p>Every agent run produces logs, diffs, and versioned output files (<code>*_r0_*</code>, <code>*_r1_*</code>). You and your collaborators can verify every change.</p>
  </div>

  <div class="diff-item">
    <h3>Multi-agent, not one-shot</h3>
    <p>Agents use reflection loops, tool calls, and planning — not a single prompt. Workflow agents iterate; interactive agents have persistent context across tool calls.</p>
  </div>

  <div class="diff-item">
    <h3>Your models, your keys</h3>
    <p>API calls go directly from your machine to providers (Anthropic, OpenAI, Google, etc.). No TeXRA servers see your content. Keys stay in VS Code's secure storage.</p>
  </div>

  <div class="diff-item">
    <h3>LaTeX-native</h3>
    <p>Built for LaTeX from day one. Understands document structure, math environments, citations, BibTeX, TikZ, and multi-file projects.</p>
  </div>

</div>

## See it in action

> **Deadline crunch.** A PhD student has 48 hours to polish a 30-page thesis chapter. She selects the chapter, picks the `polish` agent: "Improve clarity and flow for a machine-learning audience. Keep all math intact." Two minutes later she's reviewing a colour-coded diff of every change.

> **Literature sweep.** A new collaborator joins the project. She opens the `search` agent: "Find the five most-cited papers on physics-informed neural networks from 2022-2024." In seconds she has titles, abstracts, and BibTeX entries added to her `.bib` file.

> **Conference talk.** A postdoc needs slides for next week. He opens the `presenter` agent, points it at his paper, and asks for a 15-slide Beamer deck. The agent reads his paper, drafts slides with TikZ diagrams, compiles them, and visually checks every page.

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
