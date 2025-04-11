---
layout: home
hero:
  name: TeXRA
  text: Your Intelligent Academic Research Assistant
  tagline: AI assistance to help with your academic research in VS Code
  image:
    src: /logo-1024x1024.svg
    alt: TeXRA Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: Install from Marketplace
      link: https://marketplace.visualstudio.com/items?itemName=texra-ai.texra
    - theme: alt
      text: View on GitHub
      link: https://github.com/texra-ai/texra-issues

features:
  - icon: 📝
    title: Advanced AI Agents
    details: Specialized AI agents for correcting, polishing, drawing, and transforming academic content with intelligent reflection capabilities.

  - icon: 🧩
    title: Seamless LaTeX Integration
    details: Work directly with LaTeX documents, extract and compile TikZ figures, generate diffs, and merge changes intelligently.

  - icon: 🔧
    title: Powerful Tool Integration
    details: Leverage external tools for document statistics, formatting, and visualization to enhance the AI's capabilities.

  - icon: 🖼️
    title: Multi-modal Support
    details: Process text, images, and PDFs in a unified interface designed specifically for academic research workflows.
---

<div class="custom-block info intro-block">
  <p class="intro-text">
    TeXRA brings the power of cutting-edge Large Language Models directly into your VS Code editor, helping with academic writing and research tasks.
  </p>
  <p class="tagline-emphasis">Stop copy-pasting, stay in your flow.</p>
</div>

## Why TeXRA?

Standard LLM interfaces struggle with the nuances of academic work – complex formatting, precise terminology, large documents, and multi-step reasoning. TeXRA overcomes these limitations by integrating AI deeply into your workflow with:

- **Agentic Design**: Specialized agents tackle specific tasks like correcting, polishing, drawing, and transforming documents.
- **Reflection & Tool Use**: Agents can critique their own work and leverage external tools (like `latexdiff`, `texcount`) for enhanced accuracy and observability.
- **Context Awareness**: Seamlessly handles multi-file projects and references, giving you control over the context provided to the LLM (up to its limits).
- **Transparency & Control**: Uses a structured, customizable agent system – not a black box.

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

<style>
.custom-block.info { /* Style for the top block */
  margin: 2rem 0;
  padding: 1.5rem;
  border-radius: 8px;
  border: 1px solid var(--vp-c-brand-soft);
  background-color: var(--vp-c-brand-dimm);
}
.intro-block .intro-text {
  font-size: 1.1rem; /* Slightly larger */
  margin-bottom: 0.5rem; /* Space before tagline */
}
.intro-block .tagline-emphasis {
  font-weight: 600;
  color: var(--vp-c-brand-dark);
  font-size: 1.05rem;
  margin: 0;
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
  background-color: transparent;
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-brand);
}
.cta-button-alt:hover {
  background-color: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-dark); /* Ensure text color contrasts */
}
</style>
