---
layout: home
hero:
  name: TeXRA
  text: TeX Research Assistant for restless theorists
  tagline: Dense, tool-savvy AI scientist who keeps derivations and drafts on-leash
  image:
    src: /logo-1024x1024.svg
    alt: TeXRA Logo
  actions:
    - theme: brand
      text: Meet the Guidebook
      link: /guide/
    - theme: alt
      text: Install from Marketplace
      link: vscode:extension/texra-ai.texra
    - theme: alt
      text: Try it on Web
      link: /launch
    - theme: alt
      text: View on GitHub
      link: https://github.com/texra-ai/texra-issues
---

<div class="workflow-container">
  <div class="workflow-intro">
    <h2>Conversation-first research loops</h2>
    <p>
      TeXRA pairs a read-only <strong>ask</strong> scout with a tool-savvy <strong>chat</strong> tactician.
      Bounce between them to question, calculate, tweak, and verify without losing your train of thought (or your files).
    </p>
  </div>
  <div class="workflow-steps">
    <div class="workflow-step">
      <div class="step-number">1</div>
      <div class="step-content">
        <h3>Prime the Ask scout</h3>
        <p>Interrogate your workspace, surface lemmas, and gather citations without touching a single byte.</p>
        <div class="step-icon">🕵️</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">2</div>
      <div class="step-content">
        <h3>Summon the Chat tactician</h3>
        <p>Promote the plan, unleash derivations, and edit files with auditable tool calls.</p>
        <div class="step-icon">🛠️</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">3</div>
      <div class="step-content">
        <h3>Run the experiment</h3>
        <p>TeXRA executes agents, records logs, and leaves breadcrumbs for every intermediate artifact.</p>
        <div class="step-icon">⚡</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">4</div>
      <div class="step-content">
        <h3>Audit like a referee</h3>
        <div class="step-image">
          <a href="/examples/draft_polish_r1_gemini25p_diff.pdf" target="_blank">
            <img src="/images/latexdff-v1.png" alt="LaTeX Diff visualization" class="workflow-diff-image">
            <div class="view-pdf">View full PDF example</div>
          </a>
        </div>
      </div>
    </div>
  </div>
</div>

## Why theorists pick TeXRA first

AI scientists need more than a cheerful chatbot. TeXRA stays grounded in reproducible, math-literate workflows:

- **Ask + Chat duet** – interrogate projects safely with `ask`, then escalate to `chat` when you need derivations, file edits, or shell commands.
- **Dense derivation muscle** – math steps land in LaTeX-friendly `\begin{aligned}` blocks, so you can drop them straight into drafts or notebooks.
- **Audit-ready trails** – every run captures prompts, tool calls, diffs, and outputs so collaborators can replay the reasoning without guesswork.
- **Context you actually steer** – select inputs, references, figures, and auxiliary files with precision while TeXRA tracks provenance across multi-file projects.

Curious how the duet works? Jump into the [Ask & Chat Guide](/guide/ask-chat) for transcripts, tool access notes, and derivation etiquette.

## Key Capabilities

<div class="features-grid">

  <div class="feature-item">
    <h3>🎙️ Ask + Chat Duet</h3>
    <p>The `ask` scout reads and cites; the `chat` tactician plans, edits, and runs tools. Swap between them mid-investigation without losing context.</p>
    <div class="feature-example">
      <code>ask:</code> "Locate the Gauss constraint proof."<br/>
      <code>chat:</code> "Refactor Section 3 using that lemma."</div>
  </div>

  <div class="feature-item">
    <h3>🧠 Derivation-Friendly Reasoning</h3>
    <p>Agents like `derive` unpack intermediate steps, keep indices aligned, and surface aligned math blocks ready for your TeX editor.</p>
    <div class="feature-example">
      <code>Given H(k), derive dE/dk</code> → <code>\begin{aligned} ... \end{aligned}</code>
    </div>
  </div>

  <div class="feature-item">
    <h3>📝 Smart Editing & Polishing</h3>
    <p>Improve clarity, flow, and notation while preserving technical intent. Perfect for tuning drafts before your advisor sees them.</p>
    <div class="feature-example">
      <span style="color: var(--vp-c-red); text-decoration: line-through;">The results shows significant increase.</span><br/>
      <span style="color: var(--vp-c-brand);">The results show a significant increase.</span>
    </div>
  </div>

  <div class="feature-item">
    <h3>🎨 TikZ Figure Generation</h3>
    <p>Describe the topology; TeXRA sketches the TikZ. Iterate with chat to tweak labels, colors, and geometry until it matches your mental diagram.</p>
    <div class="feature-example">
      <code>"Draw a flowchart for..."</code> → `\begin{tikzpicture}...`
    </div>
  </div>

  <div class="feature-item">
    <h3>🔄 Document Transformation</h3>
    <p>Spin manuscripts into slides, posters, or lecture notes using purpose-built agents that respect citations, math, and sectioning.</p>
    <div class="feature-example">
      <code>Paper Abstract</code> → `Beamer Slides Outline`
    </div>
  </div>

  <div class="feature-item">
    <h3>📊 LaTeX-Aware Processing</h3>
    <p>Trigger `latexdiff`, `texcount`, compilation checks, and diagnostics directly from the run so reviews stay rooted in actual outputs.</p>
    <div class="feature-example">
      <span style="color: var(--vp-c-red); text-decoration: line-through;">E = mc</span><br/>
      <span style="color: var(--vp-c-brand);">E = mc^2 \label{eq:einstein}</span> (courtesy of `correct`)
    </div>
  </div>

</div>

## Get started today

Installing TeXRA is simple. Follow our [Installation Guide](/guide/installation) to get set up in minutes.

<div class="cta-container">
  <a href="/guide/" class="cta-button">Explore the Documentation</a>
  <a href="/guide/quick-start" class="cta-button cta-button-alt">Launch the Quick Start</a>
</div>

If you run into a bug, drop us a line at [contact@texra.ai](mailto:contact@texra.ai).

<style>
.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1.5rem;
  margin-top: 2rem;
}
.feature-item {
  background-color: var(--vp-c-bg-soft);
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}
.feature-item h3 {
  margin-top: 0;
  margin-bottom: 0.75rem;
  font-size: 1.1rem;
  font-weight: 600;
}
.feature-item p {
  margin-bottom: 0.75rem;
  line-height: 1.6;
  font-size: 0.95rem;
  color: var(--vp-c-text-2);
}
.feature-example {
  background-color: var(--vp-c-bg-mute);
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  border: 1px solid var(--vp-c-divider);
  margin-top: 1rem;
  line-height: 1.4;
}
.cta-container {
  display: flex;
  gap: 1rem;
  margin-top: 3rem; /* Increased margin */
  justify-content: center;
  flex-wrap: wrap;
}
.cta-button {
  display: inline-block;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  background-color: transparent;
  color: white;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 0.2s;
}
.cta-button:hover {
  background-color: var(--vp-c-brand-dark);
}
.cta-button-alt {
  background-color: transparent;
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-brand);
}
.cta-button-alt:hover {
  background-color: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-dark); /* Ensure text color contrasts */
}
.workflow-container {
  margin: 2.5rem auto;
  max-width: 1100px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.workflow-intro {
  text-align: center;
  margin-bottom: 2.5rem;
  width: 100%;
}
.workflow-intro h2 {
  margin-bottom: 0.5rem;
  font-size: 1.8rem;
  background: linear-gradient(to right, var(--vp-c-brand), var(--vp-c-brand-dark));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.workflow-intro p {
  font-size: 1.1rem;
  color: var(--vp-c-text-2);
  max-width: 640px;
  margin: 0 auto;
}
.workflow-steps {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  width: 100%;
  flex-wrap: wrap;
}
.workflow-step {
  flex: 1;
  min-width: 200px;
  max-width: 220px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-bottom: 1rem;
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
.step-content {
  margin-bottom: 1rem;
  width: 100%;
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
  line-height: 1.3;
}
.step-icon {
  font-size: 2rem;
  color: var(--vp-c-brand);
  margin-top: 0.5rem;
}
.workflow-arrow {
  font-size: 1.5rem;
  color: var(--vp-c-brand);
  display: flex;
  align-items: center;
}
.step-image {
  margin-top: 0.5rem;
  max-width: 180px;
  position: relative;
}
.workflow-diff-image {
  width: 100%;
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  transition: transform 0.2s;
}
.step-image a:hover .workflow-diff-image {
  transform: translateY(-3px);
}
.view-pdf {
  margin-top: 0.5rem;
  color: var(--vp-c-brand);
  font-size: 0.85rem;
  text-align: center;
  font-weight: 500;
}
@media (max-width: 960px) {
  .workflow-steps {
    gap: 1rem;
    justify-content: center;
  }
  .workflow-step {
    min-width: 160px;
    max-width: 200px;
  }
  .workflow-arrow {
    font-size: 1.25rem;
  }
}
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
    margin-bottom: 0.5rem;
  }
  .workflow-intro h2 {
    font-size: 1.6rem;
  }
  .step-image {
    max-width: 220px;
  }
}
</style>
