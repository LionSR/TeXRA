# Glossary

This glossary provides definitions for technical terms used throughout the TeXRA documentation. Reference this resource to understand specific terminology related to TeXRA, AI models, LaTeX, and academic research.

## TeXRA-Specific Terms

### Agent

A specialized AI assistant in TeXRA that performs a specific type of task, such as correcting errors, polishing writing, or creating figures. Each agent has custom prompts and settings optimized for its purpose.

### Chain of Thought (CoT)

An agent type in TeXRA that uses structured XML output with scratchpad thinking for complex reasoning. CoT agents can show their work and reasoning process.

### Direct Agent

An agent type in TeXRA that provides simpler, more straightforward output without intermediate reasoning steps. Direct agents are optimized for less complex tasks.

### Intelligent Merge

A feature that combines changes from multiple document versions by understanding the context and intent of modifications, rather than just performing text-level merging.

### LaTeX Diff

A feature that compares two LaTeX documents and generates a new document with additions, deletions, and modifications visually highlighted.

### ProgressBoard

TeXRA's logging interface that shows detailed information about the processing steps, model responses, and any issues encountered during execution.

### Tool Config

Settings that control how TeXRA interacts with external tools and processes, including reflection, TeX counting, and prefilling options.

### Auto Extract

A feature that automatically identifies and extracts figures or TikZ diagrams from LaTeX documents for processing by AI models.

### Reflection

A process where the AI reviews and improves its own work, leading to higher quality outputs. Enabled through the "Reflect" option in tool config.

## AI and Language Model Terms

### LLM (Large Language Model)

An AI system trained on vast amounts of text data, capable of understanding and generating human-like text. Examples include Claude, GPT-4, and Gemini.

### Token

The basic unit of text processed by language models. Tokens are typically word fragments—a word might be one or several tokens depending on its length and complexity. Models have limits on how many tokens they can process at once.

### Context Window

The maximum number of tokens a language model can consider at one time, including both the prompt and the generated response. Larger context windows allow for processing longer documents.

### Temperature

A parameter that controls the randomness of model outputs. Lower values (0.0-0.3) produce more deterministic, focused responses, while higher values (0.7-1.0) produce more creative, varied responses.

### Prompt

Instructions and context provided to an AI model to guide its response. In TeXRA, prompts are carefully engineered for specific academic research tasks.

### API (Application Programming Interface)

A set of rules that allows different software applications to communicate with each other. TeXRA uses APIs to interact with language models from providers like Anthropic, OpenAI, and Google.

### Vision Capability

The ability of some AI models to process and understand images in addition to text. Models with vision capability can analyze figures, diagrams, and other visual elements.

### Reasoning

The process by which an AI model works through complex problems step by step. Models with explicit reasoning capabilities show their thought process.

### Embedding

A numerical representation of text that captures semantic meaning, allowing AI models to understand relationships between concepts.

### Hallucination

When an AI model generates information that is factually incorrect or not based on its input. TeXRA's structured approach helps minimize hallucinations in academic research.

## LaTeX and Document Terms

### LaTeX

A document preparation system especially suited for scientific and mathematical content. LaTeX uses plain text markup rather than visual formatting, allowing precise control over document structure and appearance.

### TikZ

A powerful LaTeX package for creating vector graphics programmatically. TikZ is particularly useful for academic and technical documents because it integrates seamlessly with LaTeX.

### latexdiff

A tool that compares two LaTeX files and marks up significant differences, generating a new LaTeX document with changes highlighted.

### latexindent

A tool that formats LaTeX documents with consistent indentation and structure, making them more readable and maintainable.

### texcount

A tool that analyzes LaTeX documents to count words, headings, equations, and other elements, providing detailed document statistics.

### Document Class

A LaTeX specification that defines the overall structure and formatting of a document. Common classes include article, report, book, and beamer.

### Package

A LaTeX extension that provides additional functionality. LaTeX packages enable features like custom formatting, specialized symbols, or specific document elements.

### Preamble

The portion of a LaTeX document before the `\begin{document}` command, containing document class declarations, package imports, and custom command definitions.

### Environment

A LaTeX structure delimited by `\begin{name}` and `\end{name}` commands that defines a specific context for content formatting, such as figures, tables, or equations.

### BibTeX/BibLaTeX

Systems for managing bibliographies in LaTeX documents, allowing automatic formatting of citations and references according to specific styles.

## Academic Writing Terms

### Abstract

A concise summary of a research paper that provides an overview of its purpose, methodology, findings, and conclusions.

### Bibliography

A list of sources cited in a document, formatted according to a specific citation style.

### Citation

A reference to a source of information, typically formatted according to a specific style guide (e.g., APA, MLA, Chicago).

### Literature Review

A comprehensive analysis of existing research related to a specific topic, identifying patterns, gaps, and relationships between different works.

### Methodology

The section of a research paper that describes the procedures and techniques used to conduct the research.

### Peer Review

The evaluation of scholarly work by others in the same field, typically to assess its suitability for publication.

### Proceedings

A collection of academic papers presented at a conference or workshop.

### Revision

The process of modifying a document to improve its quality, clarity, or accuracy.

### Thesis/Dissertation

A substantial research document submitted in support of candidature for an academic degree.

### Technical Report

A document that describes the process, progress, or results of technical or scientific research.

## File Management Terms

### Auxiliary Files

Supporting files needed for document processing, such as LaTeX class files, style files, or bibliography databases.

### Reference Files

Documents that provide examples or additional context for the AI, such as sample documents or published papers with similar content.

### Figure Files

Image files used in a document, including various formats like PNG, JPG, PDF, or SVG.

### Output Files

Files generated by TeXRA after processing input documents. These follow a naming pattern that includes the agent and model used.

### Working Directory

The main directory where TeXRA operates, typically the root of your project or document collection.

### Git Repository

A version-controlled storage of your project files that tracks changes over time, enabling comparison and collaboration.

### Commit

A snapshot of changes made to files in a Git repository, representing a specific version of the project.

## Tool Integration Terms

### GraphicsMagick/ImageMagick

Software suites for creating, editing, and converting images in various formats, used by TeXRA for processing figures and diagrams.

### Ghostscript
