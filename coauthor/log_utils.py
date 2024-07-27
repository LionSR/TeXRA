from datetime import datetime
from termcolor import colored
from .model_utils import compute_api_price
from .file_utils import append_file
import os


def log_start(args):
    # Get the directory of the output name override or input file, or use appropriate fallback
    if args.output_name_override:
        input_dir = os.path.dirname(args.output_name_override)
    elif args.input_file:
        input_dir = os.path.dirname(args.input_file)
    else:
        input_dir = os.getcwd()

    # Create the Log subdirectory if it doesn't exist
    log_dir = os.path.join(input_dir, "Log")
    os.makedirs(log_dir, exist_ok=True)

    # Create the log file path
    if args.output_name_override:
        base_filename = os.path.basename(args.output_name_override)
    elif args.input_file:
        base_filename = os.path.basename(args.input_file)
    else:
        base_filename = "default"

    log_filename = base_filename.replace(".tex", "_log.txt")
    log_file = os.path.join(log_dir, log_filename)

    with open(log_file, "a+") as f:
        f.write("\n--------------------------------\n")
        f.write(f"Time: {datetime.now()}\n")
        f.write(f"Task: {args.task}\n")
        f.write(f"Model: {args.model}\n")

        optional_output_fields = ["output_name_override", "input_file", "input_files", "auxiliary_files", "figure_inputs"]

        for field in optional_output_fields:
            value = getattr(args, field, None)
            if value:
                f.write(f"{field}: {value}\n")

        f.write(f"<instruction>\n{args.instruction}\n</instruction>\n")

    return log_file


def log_end(log_file):
    append_file(log_file, "--------------------------------\n")


def log_and_print_statistics(state, model, log_file=None):
    total_input_tokens = state.get("total_input_tokens", 0)
    total_output_tokens = state.get("total_output_tokens", 0)
    total_response_time = state.get("total_response_time", 0)
    cost = compute_api_price(total_input_tokens, total_output_tokens, model)

    # Print the statistics to the command line
    print("Total input tokens  : {}".format(colored(total_input_tokens, "cyan")))
    print("Total output tokens : {}".format(colored(total_output_tokens, "cyan")))
    print("Total response time : {} seconds".format(colored(total_response_time, "green")))
    print("Total cost          : ${}".format(colored("{:.2f}".format(cost), "yellow")))

    # Log the statistics to the log file if exists in the directory
    if os.path.exists(log_file):
        append_file(
            log_file,
            f"Statistics: (Total input tokens: {total_input_tokens}, Total output tokens: {total_output_tokens}, Total response time: {total_response_time:.2f} seconds, Total cost: ${cost:.2f})\n",
        )


def log_output_files(output_file, log_file):
    if "reflect" in log_file:
        append_file(log_file, f"Reflection output file: {output_file}\n")
    else:
        append_file(log_file, f"Output file: {output_file}\n")
