import re
import os
import subprocess


def extract_figure_paths(latex_file_path):
    figure_paths = []
    latex_dir = os.path.dirname(latex_file_path)

    # Regular expressions to match figure inclusion commands
    figure_patterns = [re.compile(r"\\includegraphics(?:\[.*?\])?\{(.+?)\}"), re.compile(r"\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}")]

    try:
        with open(latex_file_path, "r", encoding="utf-8") as file:
            content = file.read()

        # Find all matches in the content for both patterns
        for pattern in figure_patterns:
            matches = pattern.findall(content)
            for match in matches:
                # Normalize the path, but keep it relative
                norm_path = os.path.normpath(os.path.join(latex_dir, match))
                rel_path = os.path.relpath(norm_path, start=latex_dir)
                figure_paths.append(rel_path)

        # Find all matches in the content for both patterns
        # for pattern in figure_patterns:
        #     matches = pattern.findall(content)
        #     figure_paths.extend(matches)

    except FileNotFoundError:
        print(f"Error: File '{latex_file_path}' not found.")
    except Exception as e:
        print(f"An error occurred: {str(e)}")

    return figure_paths


def extract_tikzpictures(latex_file):
    with open(latex_file, "r") as file:
        content = file.read()

    # Regular expression to match tikzpicture environments
    pattern = r"\\begin{tikzpicture}.*?\\end{tikzpicture}"
    tikzpictures = re.findall(pattern, content, re.DOTALL)

    return tikzpictures


def create_standalone_latex(tikzpicture, index):
    standalone_content = f"""
\\documentclass[tikz,border=10pt]{{standalone}}
\\usepackage{{tikz}}
\\begin{{document}}
{tikzpicture}
\\end{{document}}
"""

    filename = f"tikzpicture_{index}.tex"
    with open(filename, "w") as file:
        file.write(standalone_content)

    return filename


def compile_latex_to_pdf(tex_file):
    try:
        subprocess.run(["pdflatex", "-interaction=nonstopmode", tex_file], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"Compiled {tex_file} successfully.")
    except subprocess.CalledProcessError:
        print(f"Error compiling {tex_file}")


def extract_and_compile_tikzpictures(latex_file):
    tikzpictures = extract_tikzpictures(latex_file)
    compiled_files = []

    for index, tikzpicture in enumerate(tikzpictures, start=1):
        tex_file = create_standalone_latex(tikzpicture, index)
        compile_latex_to_pdf(tex_file)
        compiled_files.append(tex_file.replace(".tex", ".pdf"))

        # Clean up auxiliary files
        for ext in [".aux", ".log", ".tex"]:
            aux_file = tex_file.replace(".tex", ext)
            if os.path.exists(aux_file):
                os.remove(aux_file)

    return compiled_files
