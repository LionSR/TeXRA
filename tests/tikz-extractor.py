import re
import os
import subprocess


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


def main(latex_file):
    tikzpictures = extract_tikzpictures(latex_file)

    for index, tikzpicture in enumerate(tikzpictures, start=1):
        tex_file = create_standalone_latex(tikzpicture, index)
        compile_latex_to_pdf(tex_file)

        # Clean up auxiliary files
        for ext in [".aux", ".log"]:
            aux_file = tex_file.replace(".tex", ext)
            if os.path.exists(aux_file):
                os.remove(aux_file)


if __name__ == "__main__":
    latex_file = input("Enter the path to your LaTeX file: ")
    main(latex_file)
