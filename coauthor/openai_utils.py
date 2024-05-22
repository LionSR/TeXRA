import os
from openai import OpenAI

model_mapping = {
    "gpt-4o": "gpt-4o-2024-0513",
    "gpt-4-turbo": "gpt-4-turbo-2024-04-09",
}


def best_connection_method(str1, str2, openai_api_key=None):
    # Define the strings A, B, C
    A = str1 + str2
    B = str1 + " " + str2
    C = str1 + "\n" + str2

    # Set up the prompt for the GPT model
    prompt = f"Given three strings from a LaTeX document:\nA: {A}\nB: {B}\nC: {C}\nWhich is more grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason."

    # Read API key from environment if not provided
    if openai_api_key is None:
        openai_api_key = os.getenv("OPENAI_API_KEY")

    # Initialize OpenAI client
    client = OpenAI(api_key=openai_api_key)

    # Query the model
    completion = client.chat.completions.create(
        model="gpt-4-turbo",
        # model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": "You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.",
            },
            {"role": "user", "content": prompt},
        ],
    )

    # Extract the choice from the response
    choice = completion.choices[0].message.content.strip()

    # Return the choice directly
    return choice


# Example usage
# str1 = "Hello"
# str2 = "world"
# print(best_connection_method(str1, str2))
