# Acknowledgments & Citation

## Acknowledging TeXRA

We are thrilled if TeXRA proves useful for your academic research! While not required, if TeXRA played a significant role in your work—particularly if used as part of a study or evaluation involving LLMs or academic research tools—we would greatly appreciate an acknowledgment or citation if possible.

As the project evolves, we will provide a preferred citation format (e.g., a white paper or software citation). Please refer to the [TeXRA GitHub repository](https://github.com/texra-ai/texra-issues) or the [texra.ai](https://texra.ai) website for future citation details.

Your feedback and potential acknowledgments help support the continued development and improvement of TeXRA. Thank you for using it!

### Supporting TeXRA

If TeXRA helps you publish faster, graduate sooner, or simply reduces your LaTeX-induced stress levels, consider supporting its development:

- [**Sponsor on GitHub**](https://github.com/sponsors/texra-ai)
- [**Buy Me a Coffee**](https://buymeacoffee.com/texra.ai)

## Research produced with TeXRA

TeXRA grew out of real research, and it's built to produce more of it. A selection of work by the TeXRA team and collaborators that uses these multi-agent workflows:

- **Lu, S., Jin, Z., Zhang, T. J., Kos, P., Cirac, J. I., & Schölkopf, B.** (2026). [_Can Theoretical Physics Research Benefit from Language Agents?_](https://arxiv.org/abs/2506.06214) International Conference on Machine Learning (ICML 2026).
  A position paper on how language agents can accelerate theoretical and computational physics — the motivation behind TeXRA.

- **He, X., Lu, S., & Zeng, B.** (2025). [_Co-Designing Quantum Codes with Transversal Diagonal Gates via Multi-Agent Systems_](https://arxiv.org/abs/2510.20728). arXiv:2510.20728.
  A multi-agent system pairs symbolic synthesis and search with Lean 4 formal verification to produce a certified catalogue of 14,116 nonadditive quantum codes with prescribed transversal diagonal gates, and resolves the transversal-T problem for distance-3 codes.

Used TeXRA in your own work? We'd love to hear about it — see [Acknowledging TeXRA](#acknowledging-texra) above, or reach us at [contact@texra.ai](mailto:contact@texra.ai).

## Conceptual Background & References

TeXRA's design draws inspiration from several key concepts in AI and software development:

- **Agentic Workflows & Tool Use [1]:** The core idea involves AI agents executing tasks augmented by specialized tools (e.g., `texcount`). This allows LLMs to leverage external capabilities for tasks requiring precision or specific knowledge beyond their training data.
- **Chain-of-Thought (CoT) Reasoning [2]:** For complex agents, TeXRA employs techniques inspired by Chain-of-Thought prompting, encouraging models to "think step-by-step" (often visible in the `<scratchpad>` sections of logs) before producing a final output.
- **Reflection & Action [3, 4]:** The automatic reflection passes, combined with the agent's ability to act (edit text, use tools), draw inspiration from frameworks like ReAct and Reflexion, allowing iterative refinement based on self-critique or environmental feedback.
- **Structured Prompting (YAML + Jinja):** The use of YAML for structure and Jinja for templating within prompts allows for complex logic, dynamic content injection, and better maintainability, drawing inspiration from approaches seen in libraries like [Prompt Poet](https://github.com/character-ai/prompt-poet). The support for inheritance and modularity allows for a more flexible and reusable prompt design.
- **Scientific discovery workflows [5]:** TeXRA's focus on reproducible, domain-aware assistance aligns with emerging work on language agents that support theoretical and computational physics research.

We believe combining these concepts provides a robust and adaptable platform for AI-powered academic writing assistance.

### References

[1] Schick, T., Dwivedi-Yu, J., Dessì, R., Raileanu, R., Lomeli, M., Zettlemoyer, L., Cancedda, N., & Scialom, T. (2023). Toolformer: Language Models Can Teach Themselves to Use Tools. _arXiv preprint arXiv:2302.04761_.

[2] Wei, J., Wang, X., Schuurmans, D., Bosma, M., Ichter, B., Xia, F., Chi, E., Le, Q., & Zhou, D. (2022). Chain-of-Thought Prompting Elicits Reasoning in Large Language Models. _Advances in Neural Information Processing Systems (NeurIPS)_, 35, 24824–24837.

[3] Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2023). ReAct: Synergizing Reasoning and Acting in Language Models. _International Conference on Learning Representations (ICLR)_.

[4] Shinn, N., Cassano, F., Gopinath, A., Narasimhan, K., & Yao, S. (2023). Reflexion: Language Agents with Verbal Reinforcement Learning. In _Advances in Neural Information Processing Systems 36 (NeurIPS 2023)_.

[5] Lu, S., Jin, Z., Zhang, T. J., Kos, P., Cirac, J. I., & Schölkopf, B. (2026). Can Theoretical Physics Research Benefit from Language Agents? _International Conference on Machine Learning (ICML 2026)_. arXiv:2506.06214.
