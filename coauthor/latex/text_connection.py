import os
from openai import OpenAI

from ..logger import logger


def bestConnectionMethod(str1: str, str2: str, openai_api_key: str | None = None) -> tuple[str, str]:
    """
    Use GPT-4 turbo to determine optimal string concatenation method (direct, space, newline) for LaTeX text.
    Example usage
    str1 = "Hello"
    # str2 = "world"
    # print(bestConnectionMethod(str1, str2))
    """

    # Define the strings A, B, C
    A = str1 + str2
    B = str1 + " " + str2
    C = str1 + "\n" + str2

    # Set up the prompt for the GPT model
    prompt = (
        f"Given three strings from a LaTeX document:\n"
        f"A: {A}\n"
        f"B: {B}\n"
        f"C: {C}\n"
        f"Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason."
    )

    # Read API key from environment if not provided
    if openai_api_key is None:
        openai_api_key = os.getenv("OPENAI_API_KEY")

    # Initialize OpenAI client
    client = OpenAI(api_key=openai_api_key)

    # Query the model
    completion = client.chat.completions.create(
        model="gpt-4-turbo",
        temperature=0,
        n=10,
        messages=[
            {
                "role": "developer",
                "content": "You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.",
            },
            {"role": "user", "content": prompt},
        ],
    )

    # Extract the choices from the response
    choices = [choice.message.content.strip() for choice in completion.choices]

    # Determine the majority vote
    majority_choice = max(set(choices), key=choices.count)

    case_dict = {"A": "", "B": " ", "C": "\n"}

    # Return the majority choice directly
    if majority_choice in case_dict:
        return case_dict[majority_choice], majority_choice
    else:
        logger.warning(f"Invalid choice: {majority_choice}. Defaulting to adding a space.")
        return " ", "B"
