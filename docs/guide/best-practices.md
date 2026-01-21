# Best Practices

## Effective Prompting

Specific instructions reduce ambiguity - the model doesn't have to guess your intent and uses tokens more efficiently for your actual goal.

### Be Specific

Instead of "Make this better", try:

> Improve the clarity of the methodology section by simplifying complex sentences and adding transition phrases. Maintain all technical terminology.

### Define Boundaries

State what should and should not change:

> Enhance writing style in the introduction and discussion. Preserve all citations and mathematical expressions. Do not modify the results section.

### Provide Context

> Polish this abstract for submission to Nature Physics. Target audience: physicists with expertise in quantum field theory.

### Use Structured Instructions

For complex tasks:

> 1. Fix grammatical errors throughout
> 2. Make the introduction more engaging
> 3. Ensure consistent terminology
> 4. Improve transitions between sections

## Model Selection

Match model capability to task complexity - overpowered models waste money, underpowered ones produce poor results.

- **Simple tasks** (corrections): Use fast, cheap models (`gemini25f-`, `gpt5--`)
- **Complex tasks** (transformations): Use powerful models (`opus45`, `gpt52pro`)
- **Reasoning-heavy**: Use thinking models (`sonnet45T`, `o1`, `deepseekT`)

See the [AI Models Guide](./models.md) for detailed comparisons.

## File Management

### Project Structure

```
project/
├── main.tex
├── chapters/
├── figures/
├── build/
├── history/
└── diffs/
```

### Best Practices

- Include only necessary files in selections
- Use the Pack button to preserve milestones
- Clean unnecessary outputs regularly

## Workflow Integration

### Staged Approach

1. **Drafting**: `txt2tex` to convert to LaTeX
2. **Development**: `polish` for clarity
3. **Visualization**: `draw` for figures
4. **Finalization**: `correct` for proofreading

### Quality Assurance

Always review AI-generated content:

1. Compile to check for LaTeX errors
2. Verify cross-references and citations
3. Check figure and table numbering
4. Review mathematical expressions
5. Look for omissions or duplications

Use [LaTeX Diff](./latex-diff.md) to visualize changes between versions.

## LaTeX Tips

- Use logical document structure with proper sectioning
- Maintain clean preambles
- Use consistent label naming
- Comment TikZ code for clarity
- Use BibTeX consistently with a single bibliography file

## Next Steps

- [Configuration](/guide/configuration): Customize TeXRA
- [Custom Agents](/guide/custom-agents): Create specialized agents
- [Intelligent Merge](/guide/intelligent-merge): Merge document versions
