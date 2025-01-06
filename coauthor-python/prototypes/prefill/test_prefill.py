import argparse
import anthropic
import os


def main(input_file, append_mode=False):
    # Read the prefill content for the assistant from the prefill file
    with open(input_file) as file:
        prefill = file.read().strip()

    # output_file = "test_prefill_output.txt"
    output_file = input_file.replace(".txt", "_output.txt")

    # Initialize the Anthropic client
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    # Prepare messages list with prefill for the assistant
    messages = [
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": (
                        "You will be writing a 20 chapters novel about the Real Madrid. First, brainstorm some ideas for the plot, characters, themes, and setting of the novel. "
                        "Consider how you can tell an engaging fictional story while still being respectful of and true to the key facts of CR7's life. \n\n"
                        "Write the first draft of the full novel inside <novel> tag. Aim for a length of approximately 20,000 words. Be sure to:\n"
                        "- Develop memorable characters with distinct personalities, motivations, and arcs\n"
                        "- Use vivid descriptions to bring the scenes to life in the reader's imagination\n"
                        "- Include engaging dialogue that sounds natural and reveals character\n"
                        "- Create a compelling plot with rising action, high stakes, and a satisfying resolution\n"
                        "- Explore meaningful themes about life, loss, ambition, family, and CR7's legacy\n"
                        "- Stay true to the key facts of CR7 Bryant's life and career, even as you craft a fictional story\n\n"
                        "Be creative, but approach the subject matter with sensitivity and respect. The goal is to write an original novel that celebrates CR7's life and achievements."
                    ),
                },
            ],
        },
    ]
    messages.append({"role": "assistant", "content": prefill})

    # Create a message with the Claude model
    message = client.messages.create(
        model="claude-3-haiku-20240307",
        # model="claude-3-sonnet-20240229",
        max_tokens=4096,
        temperature=0.5,
        messages=messages,
    )

    input_tokens = message.usage.input_tokens
    output_tokens = message.usage.output_tokens

    print(f"Input tokens: {input_tokens}")
    print(f"Output tokens: {output_tokens}")

    # Extract the text content and strip it
    output_text = message.content[0].text.strip()

    # Save the output content to a file
    if append_mode:
        with open(input_file, "a") as file:
            file.write(output_text)
    else:
        with open(output_file, "w") as file:
            file.write(output_text)

    print(f"Output saved to {output_file}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test prefilling more than 4096 tokens with Claude model and save output.")
    parser.add_argument(
        "input_file",
        type=str,
        help="Input file containing the assistant's prefill content.",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append the output to the input file instead of creating a new output file.",
    )
    args = parser.parse_args()
    main(args.input_file, args.append)
