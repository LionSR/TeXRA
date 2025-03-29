# Best Practices

This guide provides recommendations for getting the most out of TexRA in your academic writing workflow. Following these best practices will help you achieve better results, work more efficiently, and maximize the benefits of AI-assisted academic writing.

## Effective Prompting

The quality of your instructions significantly impacts the results you get from TexRA. Here are strategies for writing effective instructions:

### Be Specific and Clear

Vague instructions lead to unpredictable results. Instead of:

❌ "Make this better"

Try:

✅ "Improve the clarity of the methodology section by simplifying complex sentences and adding transition phrases between paragraphs. Maintain all technical terminology and mathematical notation."

### Define Boundaries

Clearly state what should and shouldn't be changed:

✅ "Enhance the writing style and clarity of the introduction and discussion sections. Preserve all citations, technical terms, and mathematical expressions exactly as written. Do not modify the results section."

### Provide Context

Help the AI understand the purpose and audience:

✅ "Polish this abstract for submission to the Journal of Quantum Physics. The target audience is physicists with expertise in quantum field theory. Focus on highlighting the novelty and significance of the results."

### Use Structured Instructions

For complex tasks, structure your instructions:

✅ "Please improve this document as follows:

1. Fix grammatical errors and typos throughout
2. Make the introduction more engaging while preserving all key points
3. Ensure consistent terminology for technical concepts
4. Improve transitions between sections
5. Enhance clarity of figure captions without changing their meaning"

### Reference Specific Elements

Point to specific parts of the document:

✅ "Create a TikZ figure that visualizes the network architecture described in Section 3.2, including the input layer, hidden layers, and output layer with their respective dimensions."

## Model Selection

Choosing the right model for each task improves quality and efficiency:

### Match Model to Task Complexity

- **Simple Tasks** (typo correction, basic formatting): Use faster, more economical models like `gemini2f`, `gpt4o-`, or `haiku35`
- **Medium Complexity** (polishing, basic figures): Use balanced models like `sonnet35`, `gpt4o`, or `gemini2p`
- **Complex Tasks** (paper transformation, advanced figures): Use powerful models like `sonnet37`, `opus`, or `o1`

### Consider Response Quality vs. Speed

When quality is critical (e.g., final revisions), use top-tier models:

- `opus` for highest quality text processing
- `o1` for complex reasoning tasks
- `sonnet37` for balanced performance

When speed matters more (e.g., early drafts), use faster models:

- `gemini2f` for quick corrections
- `haiku35` for rapid iterations
- `gpt4o-` for fast feedback

### Leverage Special Capabilities

Use models with specialized capabilities when needed:

- **Thinking-enabled models** (`sonnet37T`, `o1`, `gemini2fT`) for complex reasoning tasks
- **Vision-capable models** (`gpt4o`, `gemini2p`) for image understanding
- **Large context models** (`gemini2p`, `sonnet37`) for processing extensive documents

## File Management

Organize your files effectively to simplify your workflow:

### Project Structure

Maintain a clear project structure:

```
project/
├── main.tex            # Main document
├── chapters/           # Chapter files
│   ├── intro.tex
│   └── methodology.tex
├── figures/            # Figure directory
│   ├── diagram.pdf
│   └── graph.png
├── build/              # Build output
├── history/            # Packed versions
└── diffs/              # LaTeX diffs
```

### Input File Selection

- Include only necessary files in your selections
- For multi-file documents, select files in logical reading order
- Keep file paths relative to your workspace root

### Reference Materials

- Include relevant reference materials that demonstrate desired style or content
- Avoid overwhelming the model with too many references
- Select diverse examples for varied tasks

### Output Management

- Use the "Pack" button regularly to preserve important milestones
- Clean unnecessary outputs to keep your workspace tidy
- Use consistent naming conventions for custom output files

## Workflow Integration

Integrate TexRA effectively into your writing process:

### Staged Approach

Break your writing process into stages and use appropriate agents:

1. **Drafting**: Use `txt2tex` to convert initial drafts to LaTeX
2. **Development**: Use `polish` to enhance clarity and flow
3. **Visualization**: Use `draw` to create figures and diagrams
4. **Finalization**: Use `correct` for final proofreading
5. **Transformation**: Use transformation agents for specific formats

### Iterative Refinement

Refine your documents through multiple passes:

1. Start with broader instructions
2. Review the results and identify specific areas for improvement
3. Use more targeted instructions in subsequent passes
4. Enable the "Reflect" option for critical tasks

### Collaborative Writing

When collaborating with others:

1. Use version control (Git) to track document evolution
2. Use LaTeXdiff to visualize changes between versions
3. Use the intelligent merge feature to combine contributions
4. Establish clear guidelines for model and agent usage

## Performance Optimization

Optimize TexRA's performance for your workflow:

### Resource Management

- Use lighter models for routine tasks
- Break large documents into manageable chunks
- Use the "Clean" button to remove unnecessary outputs

### Context Optimization

- Include only essential context in prompts
- Focus instructions on specific sections when possible
- Remove irrelevant boilerplate from reference documents
- Keep auxiliary files as simple as possible

## Quality Assurance

Ensure high-quality output with these verification practices:

### Review Process

Always review AI-generated content:

1. Compile the document to check for LaTeX errors
2. Verify all cross-references and citations
3. Check figure and table numbering
4. Review mathematical expressions for correctness
5. Look for content omissions or duplications

### Validation Checks

Implement validation checks as part of your workflow:

- Run LaTeX linters to catch formatting issues
- Use spell-checkers for a final review
- Verify bibliography entries
- Check for consistent terminology and notation

### Comparison Review

Use comparison tools to evaluate changes:

1. Use LaTeXdiff to visualize specific changes
2. Review the ProgressBoard log to understand the AI's process
3. Compare multiple versions to select the best elements

## LaTeX-Specific Practices

### Document Structure

- Use logical document structure with proper sectioning
- Maintain clean preambles with necessary packages
- Use consistent label naming conventions
- Organize content into logical files for complex documents

### TikZ Figures

- Break complex figures into meaningful components
- Comment TikZ code for clarity
- Use consistent styling across figures
- Leverage specialized TikZ libraries for domain-specific diagrams

### Bibliography Management

- Use BibTeX/BibLaTeX consistently
- Maintain a single, well-organized bibliography file
- Use consistent citation styles
- Verify citation keys match bibliography entries

## Examples of Effective Instructions

### For the Correct Agent

```
Fix grammatical errors, typos, and LaTeX syntax issues throughout the document.
Pay special attention to the mathematical expressions in Section 3, ensuring
consistency in notation and proper use of math environments. Do not change
technical terminology or the overall structure. Ensure consistency with the
IEEE formatting style.
```

### For the Polish Agent

```
Improve the clarity and flow of this paper for submission to Nature Communications.
The target audience consists of interdisciplinary researchers in computational
biology. Enhance the introduction to better highlight our novel contributions.
Make the methodology section more accessible while maintaining technical accuracy.
Strengthen the conclusion by emphasizing broader impacts. Maintain all citations,
mathematical notation, and technical terms.
```

### For the Draw Agent

```
Create a TikZ figure illustrating the hierarchical network architecture described
in Section 2.3. The network should show:
1. Input layer (4 nodes) labeled "Input Features"
2. Two hidden layers (8 nodes each) labeled "Hidden Layer 1" and "Hidden Layer 2"
3. Output layer (2 nodes) labeled "Classification"
4. Connections between layers with forward arrows
5. Use blue for input, green for hidden layers, and red for output
Include a coordinate grid in the background and add a title "Network Architecture"
```

### For the Paper2Slide Agent

```
Convert this paper into approximately 15 beamer slides suitable for a 20-minute
conference presentation. Structure the slides as follows:
1. Title slide with authors and affiliation
2. Outline slide showing the presentation structure
3. 2-3 slides on background and motivation
4. 2-3 slides on methodology
5. 4-5 slides on results (include the key figures from the paper)
6. 2 slides on discussion and implications
7. Conclusion slide with key takeaways
8. References slide
Use the Bergen theme with a blue color scheme. Emphasize visual elements
over text and include bullet points rather than full paragraphs.
```

## Next Steps

Now that you're familiar with TexRA best practices, you might want to explore:

- [Configuration](/guide/configuration) - Learn how to customize TexRA
- [Custom Agents](/guide/custom-agents) - Create specialized agents for your workflow
- [Intelligent Merge](/guide/intelligent-merge) - Master the art of document merging
