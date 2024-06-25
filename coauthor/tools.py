import re


def extract_figure_paths(latex_file_path):
    figure_paths = []

    # Regular expressions to match figure inclusion commands
    figure_patterns = [re.compile(r"\\includegraphics(?:\[.*?\])?\{(.+?)\}"), re.compile(r"\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}")]

    try:
        with open(latex_file_path, "r", encoding="utf-8") as file:
            content = file.read()

        # Find all matches in the content for both patterns
        for pattern in figure_patterns:
            matches = pattern.findall(content)
            figure_paths.extend(matches)

    except FileNotFoundError:
        print(f"Error: File '{latex_file_path}' not found.")
    except Exception as e:
        print(f"An error occurred: {str(e)}")

    return figure_paths
