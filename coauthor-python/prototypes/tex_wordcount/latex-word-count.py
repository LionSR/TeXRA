import subprocess
import os


def count_words_in_latex(file_path):
    """
    Count words in a LaTeX document using the texcount Perl script.

    :param file_path: Path to the LaTeX file
    :return: Word count as an integer, or None if an error occurred
    """
    if not os.path.exists(file_path):
        print(f"Error: File {file_path} does not exist.")
        return None

    try:
        # Run texcount command
        result = subprocess.run(["texcount", "-total", "-quiet", file_path], capture_output=True, text=True, check=True)

        # Extract the word count from the output
        word_count = int(result.stdout.strip())
        return word_count

    except subprocess.CalledProcessError as e:
        print(f"Error running texcount: {e}")
        return None
    except ValueError:
        print("Error: Unable to parse texcount output.")
        return None
