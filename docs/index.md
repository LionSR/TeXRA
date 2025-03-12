---
layout: home
hero:
  name: CoAuthor
  text: Your Intelligent Academic Writing Assistant
  tagline: Enhance your research writing with powerful AI integration in VS Code
  image:
    src: /quantum-deer.png
    alt: CoAuthor Logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/LionSR/coauthor

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

<div class="custom-block">
  <p>
    CoAuthor is a VS Code extension that brings the power of large language models to your academic writing workflow. It's designed to help researchers, professors, and students produce high-quality academic content by leveraging AI to handle formatting, corrections, and creative aspects of document preparation.
  </p>
</div>

## Why CoAuthor?

Traditional LLM interfaces like ChatGPT or Claude often lead to shallow conversations that fail to exploit the models' full potential in academic contexts due to:

- Limited context windows and output cutoffs
- Lack of integration with academic tools
- Inability to handle multi-step reasoning processes effectively

CoAuthor addresses these limitations by implementing:

- **Reflection**: The LLM examines its own work to identify improvements
- **Tool use**: The LLM leverages external tools to gather information or process data
- **Planning**: The LLM develops and executes multi-step plans to achieve complex goals

## Key Features

### Academic Text Processing

- **Correct**: Fix typos and minor errors in LaTeX documents
- **Polish**: Improve writing style and clarity
- **Write**: Generate new content based on instructions

### Document Transformation

- **Paper2Note**: Transform research papers into lecture notes
- **Paper2Slide**: Convert research papers into presentations
- **Paper2Poster**: Create academic posters from papers
- **Txt2Tex**: Convert plain text to LaTeX format

### Figure Management

- **Draw**: Create or enhance TikZ figures
- **Extract**: Automatically identify and process figures in documents
- **Compile**: Standalone TikZ figure compilation

### Document Management

- **LaTeX Diff**: Compare document versions with highlighted changes
- **Intelligent Merge**: Combine changes from multiple versions
- **Version Control**: Integration with Git for document history

## Designed for Academic Research

CoAuthor is specially designed to understand the unique requirements of academic writing:

- Mathematical notation and formulas
- Citation management
- Complex technical figures
- Specialized terminology
- Research-specific formatting

## Quotes from Users

> "CoAuthor has transformed my paper writing process. What used to take weeks now takes days."
>
> — Professor in Computer Science

> "I'm continually amazed by how well it adapts my dense research papers into clear lecture notes."
>
> — Assistant Professor in Physics

## Get Started Today

Installing and using CoAuthor is simple. Follow our [Installation Guide](/guide/installation) to get set up in minutes.

<div class="cta-container">
  <a href="/guide/" class="cta-button">Explore the Documentation</a>
  <a href="/guide/quick-start" class="cta-button cta-button-alt">Quick Start Guide</a>
</div>

<style>
.custom-block {
  margin: 2rem 0;
  padding: 1.5rem;
  border-radius: 8px;
  background-color: rgba(100, 108, 255, 0.08);
}

.custom-block p {
  margin: 0;
  line-height: 1.6;
}

.cta-container {
  display: flex;
  gap: 1rem;
  margin-top: 2rem;
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
  background-color: rgba(100, 108, 255, 0.08);
}
</style>
