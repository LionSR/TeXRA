"""Contains patterns and utilities for handling confirmation prompts in the chat."""

# Patterns that indicate the assistant is asking for confirmation
CONFIRMATION_PROMPT_PATTERNS = [
    "Would you like me to",
    "Should I",
    "Do you want me to",
    "Would you prefer",
    "Shall I",
    "Let me know if you'd like me to",
    "I can",
    "I could",
    "Would it be helpful if I",
    "Would that be helpful",
    "Would you find it helpful if I",
    "Is this what you're looking for",
    "Is this what you want",
    "Is this helpful",
    "Is that helpful",
    "Does this help",
    "Does that help",
    "How does this sound",
    "How does that sound",
    "What do you think",
    "Let me know if",
    "Please let me know if",
]


def wrapConfirmationPrompts(text: str) -> str:
    """Process text to wrap confirmation prompts in monologue tags."""
    lines = text.split("\n")
    processed_lines = []

    for i, line in enumerate(lines):
        line = line.strip()
        # Skip if line is already wrapped in monologue tags
        if line.startswith("<monologue>") and line.endswith("</monologue>"):
            processed_lines.append(line)
            continue

        # Check if line contains confirmation prompt
        if any(pattern.lower() in line.lower() for pattern in CONFIRMATION_PROMPT_PATTERNS):
            # Check if line is already wrapped in separate monologue tags
            if i > 0 and i < len(lines) - 1 and lines[i - 1].strip() == "<monologue>" and lines[i + 1].strip() == "</monologue>":
                # pass
                processed_lines.append(line)
            else:
                processed_lines.append(f"<monologue>{line}</monologue>")
        else:
            processed_lines.append(line)

    return "\n".join(processed_lines)
