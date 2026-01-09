---
layout: home
hero:
  name: TeXRA
  text: Reliable AI Workflows for Scientific Discovery
  tagline: Agentic research assistant for AI scientists, physicists, and research engineers
  image:
    src: /logo-1024x1024.svg
    alt: TeXRA Logo
---

<div class="hero-buttons">
  <div class="dropdown">
    <button class="dropdown-button brand">
      Get started
      <span class="chevron">▼</span>
    </button>
    <div class="dropdown-menu">
      <a href="vscode:extension/texra-ai.texra">VS Code*</a>
      <a href="cursor://texra-ai.texra">Cursor*</a>
      <a href="windsurf://texra-ai.texra">Windsurf*</a>
      <a href="https://marketplace.visualstudio.com/items?itemName=texra-ai.texra">VS Code Marketplace</a>
      <a href="/launch">Web (Codespaces)</a>
      <span class="dropdown-note">*Requires app install</span>
    </div>
  </div>
  <a href="https://github.com/texra-ai/texra-issues" class="alt-button">View on GitHub</a>
</div>

<div class="workflow-container">
  <div class="workflow-steps">
    <div class="workflow-step">
      <div class="step-number">1</div>
      <div class="step-content">
        <h3>Select Content</h3>
        <p>Choose your input files, references, figures, and specify output</p>
        <div class="step-icon">📄</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">2</div>
      <div class="step-content">
        <h3>Choose Agent/Model</h3>
        <p>Select a specialized agent and model</p>
        <div class="step-icon">🤖</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">3</div>
      <div class="step-content">
        <h3>Execute</h3>
        <p>TeXRA handles the rest with powerful language models</p>
        <div class="step-icon">⚡</div>
      </div>
    </div>
    <div class="workflow-arrow">→</div>
    <div class="workflow-step">
      <div class="step-number">4</div>
      <div class="step-content">
        <h3>Review Changes</h3>
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

## Why TeXRA?

AI scientists need more than a chat window. TeXRA keeps research grounded in reproducible workflows and transparent reasoning:

- **Reliable scientific loops** – capture every run with logs, diffs, and audit trails so collaborators can verify changes.
- **Specialized agent roster** – summon correction, polishing, figure generation, and document transformation agents tuned for LaTeX-heavy projects.
- **Integrated verification tools** – trigger `latexdiff`, `texcount`, compilation checks, and custom scripts directly from the agent run.
- **Context you control** – work across multi-file projects, reference libraries, and datasets without losing track of provenance.

## Key Capabilities

<div class="features-grid">

  <div class="feature-item">
    <h3>📝 Smart Editing & Polishing</h3>
    <p>Go beyond simple grammar checks. Improve clarity, flow, and style while preserving technical accuracy. Fix subtle LaTeX errors and ensure consistency.</p>
    <div class="feature-example">
      <span style="color: var(--vp-c-red); text-decoration: line-through;">The results shows significant increase.</span><br/>
      <span style="color: var(--vp-c-brand);">The results show a significant increase.</span>
    </div>
  </div>

  <div class="feature-item">
    <h3>🎨 TikZ Figure Generation</h3>
    <p>Create complex TikZ diagrams from natural language descriptions or enhance existing figures. TeXRA handles the code generation and compilation.</p>
    <div class="feature-example">
      <!-- Placeholder for a small TikZ example graphic or code snippet -->
      <code>"Draw a flowchart for..."</code> &#8594; `\begin{tikzpicture}...`
    </div>
  </div>

  <div class="feature-item">
    <h3>🔄 Document Transformation</h3>
    <p>Effortlessly convert papers into slides (`paper2slide`), lecture notes (`paper2note`), posters (`paper2poster`), or even draft cover letters (`paper2cover`).</p>
    <div class="feature-example">
      <code>Paper Abstract</code> &#8594; `Beamer Slides Outline`
    </div>
  </div>

  <div class="feature-item">
    <h3>📊 LaTeX-Aware Processing</h3>
    <p>Understands LaTeX structure, math, citations, and environments. Includes integrated `latexdiff` for visualizing changes and `texcount` for analysis.</p>
    <div class="feature-example">
      <span style="color: var(--vp-c-red); text-decoration: line-through;">E = mc</span><br/>
      <span style="color: var(--vp-c-brand);">E = mc^2 \label{eq:einstein}</span> (via `correct` agent)
    </div>
  </div>

  <div class="feature-item">
    <h3>🧩 Multi-File Projects</h3>
    <p>Handle books, theses, or papers split across multiple files. Apply changes consistently or target specific sections.</p>
    <div class="feature-example">
      <code>[ch1.tex, ch2.tex]</code> &#8594; <code>[ch1_polished.tex, ch2_polished.tex]</code>
    </div>
  </div>

  <div class="feature-item">
    <h3>🖼️ Multimodal Understanding</h3>
    <p>Leverage vision-capable models to analyze images, figures, and PDFs directly within your workflow.</p>
    <div class="feature-example">
      <code>&lt;figure.png&gt; + "Write caption"</code> &#8594; <code>\caption{...}</code>
    </div>
  </div>

</div>

## Get Started Today

Installing TeXRA is simple. Follow our [Installation Guide](/guide/installation) to get set up in minutes.

<div class="cta-container">
  <a href="/guide/" class="cta-button">Explore the Documentation</a>
  <a href="/guide/quick-start" class="cta-button cta-button-alt">Quick Start Guide</a>
</div>

If you run into a bug, drop us a line at [contact@texra.ai](mailto:contact@texra.ai).

<style>
/* Hero buttons with dropdown */
.hero-buttons {
  display: flex;
  justify-content: center;
  gap: 1rem;
  margin: -1rem 0 2rem;
  flex-wrap: wrap;
}
.dropdown {
  position: relative;
  display: inline-block;
}
.dropdown-button {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.25rem;
  font-size: 1rem;
  font-weight: 500;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.dropdown-button.brand {
  background: var(--vp-c-brand);
  color: white;
}
.dropdown-button.brand:hover {
  background: var(--vp-c-brand-dark);
}
.dropdown-button .chevron {
  font-size: 0.7rem;
  transition: transform 0.2s;
}
.dropdown:hover .chevron {
  transform: rotate(180deg);
}
.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 200px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: all 0.2s;
  z-index: 100;
}
.dropdown:hover .dropdown-menu {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}
.dropdown-menu a {
  display: block;
  padding: 0.75rem 1rem;
  color: var(--vp-c-text-1);
  text-decoration: none;
  font-size: 0.95rem;
  transition: background 0.15s;
}
.dropdown-menu a:first-child {
  border-radius: 8px 8px 0 0;
}
.dropdown-menu a:last-child {
  border-radius: 0 0 8px 8px;
}
.dropdown-menu a:hover {
  background: var(--vp-c-bg-soft);
}
.dropdown-note {
  display: block;
  padding: 0.5rem 1rem;
  font-size: 0.8rem;
  color: var(--vp-c-text-3);
  border-top: 1px solid var(--vp-c-divider);
}
.alt-button {
  display: inline-flex;
  align-items: center;
  padding: 0.75rem 1.25rem;
  font-size: 1rem;
  font-weight: 500;
  color: var(--vp-c-brand);
  background: transparent;
  border: 1px solid var(--vp-c-brand);
  border-radius: 8px;
  text-decoration: none;
  transition: all 0.2s;
}
.alt-button:hover {
  background: var(--vp-c-brand-soft);
}

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
