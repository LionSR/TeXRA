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
      text: Try it on Web
      link: /launch
    - theme: alt
      text: View on GitHub
      link: https://github.com/texra-ai/texra-issues
---

<div class="hero-install-dropdown" data-hero-install>
  <button class="hero-install-trigger" id="hero-install-trigger" type="button">
    Install Extension
    <span class="hero-install-caret" aria-hidden="true"></span>
  </button>
  <div class="hero-install-menu" aria-labelledby="hero-install-trigger" role="menu">
    <a class="hero-install-link" href="vscode:extension/texra-ai.texra" role="menuitem">
      Open in VS Code
    </a>
    <a class="hero-install-link" href="vscode-insiders:extension/texra-ai.texra" role="menuitem">
      Open in VS Code Insiders
    </a>
    <a class="hero-install-link" href="cursor:extension/texra-ai.texra" role="menuitem">
      Open in Cursor
    </a>
    <a class="hero-install-link" href="windsurf:extension/texra-ai.texra" role="menuitem">
      Open in Windsurf
    </a>
    <a
      class="hero-install-link hero-install-link--marketplace"
      href="https://marketplace.visualstudio.com/items?itemName=texra-ai.texra"
      role="menuitem"
    >
      View Marketplace Listing
    </a>
  </div>
</div>

<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';

let dropdownEl: HTMLElement | null = null;
let triggerEl: HTMLButtonElement | null = null;
let menuLinks: NodeListOf<HTMLAnchorElement> | undefined;

const toggleOpenClass = () => {
  if (!dropdownEl) {
    return;
  }

  dropdownEl.classList.toggle('is-open');
  triggerEl?.setAttribute(
    'aria-expanded',
    dropdownEl.classList.contains('is-open') ? 'true' : 'false',
  );
};

const closeDropdown = () => {
  if (!dropdownEl) {
    return;
  }

  dropdownEl.classList.remove('is-open');
  triggerEl?.setAttribute('aria-expanded', 'false');
};

const handleTriggerClick = (event: MouseEvent) => {
  event.preventDefault();
  toggleOpenClass();
};

const handleDocumentClick = (event: MouseEvent) => {
  if (!dropdownEl) {
    return;
  }

  if (dropdownEl.contains(event.target as Node)) {
    return;
  }

  closeDropdown();
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeDropdown();
  }
};

const handleLinkClick = () => {
  closeDropdown();
};

onMounted(() => {
  if (typeof window === 'undefined') {
    return;
  }

  dropdownEl = document.querySelector('[data-hero-install]');
  triggerEl = dropdownEl?.querySelector<HTMLButtonElement>('.hero-install-trigger') ?? null;
  const menuEl = dropdownEl?.querySelector<HTMLDivElement>('.hero-install-menu') ?? null;
  menuLinks = dropdownEl?.querySelectorAll<HTMLAnchorElement>('.hero-install-link') ?? undefined;

  const heroActions = document.querySelector('.VPHero .actions');

  if (dropdownEl && heroActions) {
    const insertPosition = heroActions.children[1] ?? null;
    heroActions.insertBefore(dropdownEl, insertPosition);
    dropdownEl.classList.add('is-ready');
  }

  if (triggerEl) {
    triggerEl.setAttribute('aria-haspopup', 'true');
    triggerEl.setAttribute('aria-expanded', 'false');
    triggerEl.addEventListener('click', handleTriggerClick);
  }

  if (menuEl) {
    menuEl.setAttribute('role', 'menu');
  }

  menuLinks?.forEach((link) => link.addEventListener('click', handleLinkClick));

  document.addEventListener('click', handleDocumentClick);
  document.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  triggerEl?.removeEventListener('click', handleTriggerClick);
  menuLinks?.forEach((link) => link.removeEventListener('click', handleLinkClick));
  document.removeEventListener('click', handleDocumentClick);
  document.removeEventListener('keydown', handleKeydown);
});
</script>

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
        <p>Select a specialized agent (correct, polish)</p>
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

.hero-install-dropdown {
  position: relative;
  display: none;
  flex-shrink: 0;
}

.hero-install-dropdown.is-ready {
  display: inline-flex;
}

.hero-install-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.6rem 1.4rem;
  border-radius: 999px;
  border: 1px solid var(--vp-button-alt-border, var(--vp-c-divider));
  background-color: var(--vp-button-alt-bg, rgba(255, 255, 255, 0.05));
  color: var(--vp-button-alt-text, var(--vp-c-text-1));
  font-weight: 600;
  font-size: 1rem;
  line-height: 1.2;
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease,
    box-shadow 0.2s ease;
  box-shadow: var(--vp-shadow-1, 0 1px 2px rgba(15, 23, 42, 0.08));
}

.hero-install-trigger:hover,
.hero-install-dropdown.is-open .hero-install-trigger {
  background-color: var(--vp-button-alt-hover-bg, var(--vp-c-bg-soft));
  border-color: var(--vp-button-alt-hover-border, var(--vp-c-brand));
  color: var(--vp-button-alt-hover-text, var(--vp-c-brand));
  box-shadow: var(--vp-shadow-2, 0 4px 12px rgba(15, 23, 42, 0.12));
}

.hero-install-trigger:focus-visible {
  outline: 2px solid var(--vp-c-brand);
  outline-offset: 2px;
}

.hero-install-caret {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: rotate(45deg);
  transition: transform 0.2s ease;
  margin-top: -0.1rem;
}

.hero-install-dropdown.is-open .hero-install-caret {
  transform: rotate(225deg);
  margin-top: 0.1rem;
}

.hero-install-menu {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  min-width: 16rem;
  padding: 0.5rem;
  display: none;
  flex-direction: column;
  gap: 0.25rem;
  border-radius: 0.75rem;
  border: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg);
  box-shadow: var(--vp-shadow-3, 0 18px 40px rgba(15, 23, 42, 0.18));
  z-index: 30;
}

.hero-install-dropdown.is-open .hero-install-menu {
  display: flex;
}

.hero-install-link {
  display: flex;
  align-items: center;
  padding: 0.55rem 0.75rem;
  border-radius: 0.5rem;
  color: var(--vp-c-text-1);
  font-weight: 500;
  text-decoration: none;
  transition: background-color 0.2s ease, color 0.2s ease;
}

.hero-install-link:hover,
.hero-install-link:focus-visible {
  background-color: var(--vp-c-bg-soft);
  color: var(--vp-c-brand);
}

.hero-install-link--marketplace {
  margin-top: 0.25rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--vp-c-divider);
}

@media (max-width: 640px) {
  .hero-install-dropdown {
    width: 100%;
  }

  .hero-install-trigger {
    width: 100%;
  }

  .hero-install-menu {
    position: static;
    width: 100%;
    margin-top: 0.5rem;
    box-shadow: var(--vp-shadow-1, 0 1px 2px rgba(15, 23, 42, 0.08));
  }
}
</style>
