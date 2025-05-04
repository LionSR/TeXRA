# Best Practices

This guide provides recommendations for getting the most out of TeXRA in your academic research workflow. Following these best practices will help you achieve better results, work more efficiently, and maximize the benefits of AI-assisted academic research.

## Effective Prompting

The quality of your instructions significantly impacts the results you get from TeXRA. Here are strategies for writing effective instructions:

### Be Specific and Clear

Vague instructions lead to unpredictable results. Think of it like asking a new research assistant to "make this better" – you might get _anything_! Instead of:

❌ "Make this better"

Try:

✅ "Improve the clarity of the methodology section by simplifying complex sentences and adding transition phrases between paragraphs. Maintain all technical terminology and mathematical notation."

### Define Boundaries

Clearly state what should and shouldn't be changed:

✅ "Enhance the writing style and clarity of the introduction and discussion sections. Preserve all citations, technical terms, and mathematical expressions exactly as written. Do not modify the results section."

### Provide Context

Help the AI understand the purpose and audience:

✅ "Polish this abstract for submission to the Journal of Quantum Physics. The target audience is scientists with expertise in quantum field theory. Focus on highlighting the novelty and significance of the results."

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

Choosing an appropriate model can significantly impact the quality, speed, and cost of your results. It's a bit like choosing between a calculator and a supercomputer – pick the right tool for the job! Refer to the [AI Models Guide](./models.md) for detailed comparison tables. Key considerations include:

- **Task Complexity**: Simple tasks (like basic correction) often work well with faster, cheaper models (e.g., those marked '$' or 'Fast'/'Very Fast'). Complex tasks requiring deep reasoning or high-quality generation (like transforming papers or intricate drawing) benefit from more powerful, albeit slower and more expensive, models (e.g., '$$$$' or 'Slow').
- **Budget & Speed**: Balance your needs using the relative cost ($ - $$$$) and speed indicators provided in the [AI Models Guide](./models.md).
- **Special Capabilities**: Does your task require specific features like explicit reasoning (`*T` models, `o*` series), vision, native PDF/audio handling, or an exceptionally large context window? Choose a model that supports these needs (check the tables in the [AI Models Guide](./models.md)).
- **Experimentation**: Often, trying a task with a couple of different relevant models is the best way to find the optimal balance for your specific needs.

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

Integrate TeXRA effectively into your writing process:

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
3. Establish clear guidelines for model and agent usage

## Performance Optimization

Optimize TeXRA's performance for your workflow:

### Resource Management

- Use lighter models for routine tasks
- Break large documents into manageable chunks
- Use the "Clean" button to remove unnecessary outputs

### Context Optimization

LLMs have impressive memories, but they aren't infinite. Help them focus by:

- Including only essential context in prompts
- Focusing instructions on specific sections when possible
- Remove irrelevant boilerplate from reference documents
- Keep auxiliary files as simple as possible
- Keep the prompt and the input files as least confusing as possible. Try not to have self-conflicting definitions and instructions (surprisingly hard to do!).

## Quality Assurance

Ensure high-quality output with these verification practices:

### Review Process

Always review AI-generated content – the AI is smart, but it hasn't defended a PhD... yet.

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

1. Use LaTeXdiff (see the [LaTeX Diff Guide](./latex-diff.md), including tips on source comparison) to visualize specific changes.
2. Review the [ProgressBoard log](./progress-board.md) to understand the AI's process.
3. Compare multiple versions to select the best elements.

## Workspace Optimization

Customize your VS Code environment for a smoother TeXRA experience:

### TeXRA View Placement

For easier access, especially on wider screens, consider moving the TeXRA view to the secondary sidebar:

1.  Ensure the secondary sidebar is visible: Open VS Code's Command Palette (Ctrl+Shift+P or Cmd+Shift+P on macOS) and run "View: Toggle Secondary Side Bar Visibility" (or use Alt+Cmd+B on macOS).
2.  Drag the TeXRA icon from the primary sidebar (usually on the left) to the secondary sidebar (usually on the right).

### Cross-Computer Sync for Outputs

To sync TeXRA's `Diffs` and `History` directories across computers, use cloud storage (e.g., Dropbox, Google Drive). You can either store your entire project in the cloud directory, ensuring these output folders are included:

```
~/CloudStorage/texra-papers/ProjectName/
├── ... (source files)
├── Diffs/      <-- Synced
└── History/    <-- Synced
```

Alternatively, if your project source files remain local (outside cloud storage), you can sync _only_ the TeXRA outputs by creating symbolic links within your local project directory that point to the `Diffs` and `History` folders located within your cloud storage.

**macOS/Linux:**

```bash
# In your local project directory:
ln -s /path/to/CloudStorage/texra-papers/ProjectName/Diffs .
ln -s /path/to/CloudStorage/texra-papers/ProjectName/History .
```

**Windows (Admin Cmd):**

```cmd
:: In your local project directory:
mklink /D Diffs C:\path\to\CloudStorage\texra-papers\ProjectName\Diffs
mklink /D History C:\path\to\CloudStorage\texra-papers\ProjectName\History
```

## LaTeX-Specific Practices

Working with LaTeX can sometimes feel like wrangling an octopus. These practices help keep things smooth:

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

### Draft to Publication Workflow (Example)

1.  **Initial Cleanup/Structuring**: Use `correct` if starting from a rough draft or existing file.
2.  **Content Enhancement**: Use `polish` to improve style, clarity, and flow.
3.  **Figure Creation/Refinement**: Use `draw` to add or enhance TikZ figures.
4.  **Final Proofreading**: Use `correct` again for a final pass on grammar and syntax.
5.  **(Optional) Transformation**: Use `paper2slide` or `paper2poster` if needed.

## Next Steps

Now that you're familiar with TeXRA best practices, you might want to explore:

- [Configuration](/guide/configuration) - Learn how to customize TeXRA
- [Custom Agents](/guide/custom-agents) - Create specialized agents for your workflow
- [Intelligent Merge](/guide/intelligent-merge) - Master the art of document merging
