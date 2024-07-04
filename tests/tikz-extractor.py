import re
import subprocess
import argparse
from string import Template
from pathlib import Path

TEMPLATE_TEX = Template(
    r"""
\documentclass[tikz,border=10pt]{standalone}
% \input{commands}
\usepackage{tikz}
\usetikzlibrary{positioning}
\begin{document}
$tikzpicture
\end{document}
"""
)


def extract_tikzpictures_with_labels(latex_file):
    with open(latex_file, "r") as file:
        content = file.read()

    # Regular expression to match entire figure environments with labels and tikzpicture environments
    figure_pattern = re.compile(r"(\\begin{figure}.*?\\label\{.*?\}.*?\\end{figure})", re.DOTALL)
    tikz_pattern = re.compile(r"\\begin{tikzpicture}.*?\\end{tikzpicture}", re.DOTALL)

    print("LaTeX file content:")
    print(content)

    print("Figure matches:")
    figures = figure_pattern.findall(content)
    print(figures)

    print("TikZ matches:")
    tikzpictures = tikz_pattern.findall(content)
    print(tikzpictures)

    labeled_tikzpictures = []
    for figure in figures:
        label_match = re.search(r"\\label\{(.*?)\}", figure)
        if label_match:
            label = label_match.group(1)
            tikz_matches = tikz_pattern.findall(figure)
            for tikz in tikz_matches:
                labeled_tikzpictures.append((label, tikz))

    return labeled_tikzpictures


def create_standalone_latex_with_labels(tikzpicture, label, index, build_dir):
    standalone_content = (
        r"""
\documentclass[tikz,border=10pt]{standalone}
\usepackage{tikz}
\begin{document}
"""
        + tikzpicture
        + r"""
\end{document}
"""
    )

    filename = build_dir / f"{label}_{index}.tex"
    with open(filename, "w") as file:
        file.write(standalone_content)

    return filename


def extract_and_compile_tikzpictures_with_labels(latex_file):
    input_file = Path(latex_file)
    build_dir = input_file.parent / "build" / input_file.stem
    build_dir.mkdir(parents=True, exist_ok=True)

    print("Extracting TikZ pictures with labels...")
    labeled_tikzpictures = extract_tikzpictures_with_labels(latex_file)
    print(f"Found {len(labeled_tikzpictures)} labeled TikZ pictures.")

    compiled_files = []

    for index, (label, tikzpicture) in enumerate(labeled_tikzpictures, start=1):
        print(f"Creating standalone LaTeX file for label: {label}, index: {index}")
        tex_file = create_standalone_latex_with_labels(tikzpicture, label, index, build_dir)
        print(f"Compiling LaTeX file: {tex_file}")
        compile_latex_to_pdf(tex_file)
        compiled_files.append(tex_file.with_suffix(".pdf"))

        # Clean up auxiliary files
        for ext in [".aux", ".log"]:
            aux_file = tex_file.with_suffix(ext)
            if aux_file.exists():
                aux_file.unlink()
    
    extracted_tikz_figures = [str(fig) for fig in compiled_files]
    return extracted_tikz_figures


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


def main(latex_file):
    extract_and_compile_tikzpictures_with_labels(latex_file)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract and compile TikZ pictures from a LaTeX file.")
    parser.add_argument("input_file", help="Path to the input LaTeX file")
    args = parser.parse_args()

    main(args.input_file)
