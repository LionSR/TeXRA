import re
import os
import subprocess
from pathlib import Path
from string import Template

TIKZ_TEMPLATE = Template(
    r"""
\documentclass[tikz,border=10pt]{standalone}
\usepackage{tikz}
\usetikzlibrary{positioning}
\begin{document}
$tikzpicture
\end{document}
"""
)


def extract_figure_paths(latex_file_path):
    figure_paths = []
    latex_dir = os.path.dirname(latex_file_path)
    graphicspaths = [latex_dir]  # Start with the directory of the LaTeX file

    # Regular expressions to match figure inclusion commands and graphicspath
    figure_patterns = [re.compile(r"\\includegraphics(?:\[.*?\])?\{(.+?)\}"), re.compile(r"\\begin\{overpic\}(?:\[.*?\])?\{(.+?)\}")]
    graphicspath_pattern = re.compile(r"\\graphicspath\s*\{(.+?)\}")

    try:
        with open(latex_file_path, "r", encoding="utf-8") as file:
            content = file.read()

        # Find all graphicspaths
        graphicspath_matches = graphicspath_pattern.findall(content)
        print(f"Graphicspath matches: {graphicspath_matches}")  # Debug print

        for match in graphicspath_matches:
            paths = [match.strip("{}")]  # Remove outer braces
            print(f"Paths found in graphicspath: {paths}")  # Debug print
            for path in paths:
                normalized_path = os.path.normpath(os.path.join(latex_dir, path.strip("/")))
                graphicspaths.append(normalized_path)
                print(f"Added graphicspath: {normalized_path}")

        # Debug print to check graphicspaths
        print(f"Graphicspaths: {graphicspaths}")

        # Find all matches in the content for both patterns
        for pattern in figure_patterns:
            matches = pattern.findall(content)
            for match in matches:
                for base_path in graphicspaths:
                    norm_path = os.path.normpath(os.path.join(base_path, match))
                    if os.path.exists(norm_path):
                        rel_path = os.path.relpath(norm_path, start=latex_dir)
                        figure_paths.append(rel_path)
                        print(f"Found figure: {rel_path}")
                        break

    except FileNotFoundError:
        print(f"Error: File '{latex_file_path}' not found.")
    except Exception as e:
        print(f"An error occurred: {str(e)}")

    print(f"Found figure paths: {figure_paths}")
    return figure_paths


def extract_tikzpictures_with_labels(latex_file):
    with open(latex_file, "r") as file:
        content = file.read()

    # Regular expression to match entire figure environments with labels and tikzpicture environments
    figure_pattern = re.compile(r"(\\begin{figure}.*?\\label\{.*?\}.*?\\end{figure})", re.DOTALL)
    tikz_pattern = re.compile(r"\\begin{tikzpicture}.*?\\end{tikzpicture}", re.DOTALL)

    labeled_tikzpictures = []
    for figure in figure_pattern.findall(content):
        label_match = re.search(r"\\label\{(.*?)\}", figure)
        if label_match:
            label = label_match.group(1)
            tikz_matches = tikz_pattern.findall(figure)
            if tikz_matches:
                labeled_tikzpictures.append((label, tikz_matches))

    return labeled_tikzpictures


def create_standalone_latex_with_labels(tikzpicture, label, suffix, build_dir):
    standalone_content = TIKZ_TEMPLATE.substitute(tikzpicture=tikzpicture)

    filename = build_dir / f"{label}_{suffix}.tex"
    with open(filename, "w") as file:
        file.write(standalone_content)

    return filename


def compile_latex_to_pdf(tex_file):
    try:
        result = subprocess.run(
            ["pdflatex", "-interaction=nonstopmode", f"-output-directory={tex_file.parent}", tex_file], check=True, capture_output=True, text=True
        )
        print(f"Compiled {tex_file} successfully.")
    except subprocess.CalledProcessError as e:
        print(f"Error compiling {tex_file}")
        print("Error message:")
        print(e.stdout)
        print(e.stderr)


def extract_and_compile_tikzpictures_with_labels(latex_file):
    input_file = Path(latex_file)
    build_dir = Path("build") / input_file.stem
    build_dir.mkdir(parents=True, exist_ok=True)

    labeled_tikzpictures = extract_tikzpictures_with_labels(latex_file)
    compiled_files = []

    for label, tikzpictures in labeled_tikzpictures:
        for i, tikzpicture in enumerate(tikzpictures):
            suffix = chr(97 + i)  # Convert index to letter (0 -> 'a', 1 -> 'b', etc.)
            tex_file = create_standalone_latex_with_labels(tikzpicture, label, suffix, build_dir)
            compile_latex_to_pdf(tex_file)
            compiled_files.append(tex_file.with_suffix(".pdf"))

            # Clean up auxiliary files
            for ext in [".aux", ".log", ".tex"]:
                aux_file = tex_file.with_suffix(ext)
                if aux_file.exists():
                    aux_file.unlink()

    return compiled_files
