import re


def extract_figure_paths_from_latex(latex_file_path):
    figure_paths = []

    # Regular expression to match figure inclusion commands
    figure_pattern = re.compile(r"\\includegraphics(?:\[.*?\])?\{(.+?)\}")

    try:
        with open(latex_file_path, encoding="utf-8") as file:
            content = file.read()

        # Find all matches in the content
        matches = figure_pattern.findall(content)

        # Add matched file paths to the list
        figure_paths.extend(matches)

    except FileNotFoundError:
        print(f"Error: File '{latex_file_path}' not found.")
    except Exception as e:
        print(f"An error occurred: {str(e)}")

    return figure_paths


# Example usage
if __name__ == "__main__":
    latex_file = "path/to/your/latex/document.tex"
    figures = extract_figure_paths_from_latex(latex_file)

    print("Extracted figure file paths:")
    for figure in figures:
        print(figure)
