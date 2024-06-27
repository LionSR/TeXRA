from datetime import datetime
from termcolor import colored
from .model_utils import compute_api_price


def log_start(args):
    log_file_path = args.input_file.replace(".tex", "_log.txt")
    with open(log_file_path, "a+") as log_file:
        log_file.write("\n--------------------------------\n")
        log_file.write(f"Time: {datetime.now()}\n")
        log_file.write(f"Task: {args.task}\n")
        log_file.write(f"Model: {args.model}\n")

        if args.figure_inputs:
            log_file.write(f"Figure inputs: {args.figure_inputs}\n")

        log_file.write(f"Input file: {args.input_file}\n")

        if args.input_files:
            log_file.write(f"Additional input files: {args.input_files}\n")

        if args.auxiliary_files:
            log_file.write(f"Auxiliary files: {args.auxiliary_files}\n")

        log_file.write(f"Instruction:\n<request>\n{args.instruction}\n</request>\n")

    return log_file_path


def log_and_print_statistics(state, model, log_file_path):
    total_input_tokens = state.get("total_input_tokens", 0)
    total_output_tokens = state.get("total_output_tokens", 0)
    total_response_time = state.get("total_response_time", 0)
    cost = compute_api_price(total_input_tokens, total_output_tokens, model)

    # Print the statistics to the command line
    print("Total input tokens  : {}".format(colored(total_input_tokens, "cyan")))
    print("Total output tokens : {}".format(colored(total_output_tokens, "cyan")))
    print("Total response time : {} seconds".format(colored(total_response_time, "green")))
    print("Total cost          : ${}".format(colored("{:.2f}".format(cost), "yellow")))

    # Log the statistics to the log file
    with open(log_file_path, "a") as log_file:
        log_file.write(
            f"Statistics: Total input tokens: {total_input_tokens}, Total output tokens: {total_output_tokens}, Total response time: {total_response_time:.2f} seconds, Total cost: ${cost:.2f}\n"
        )


def log_output_files(log_file_path, output_file):
    with open(log_file_path, "a") as log_file:
        if "reflect" in log_file_path:
            log_file.write(f"Reflection output file: {output_file}\n")
        else:
            log_file.write(f"Output file: {output_file}\n")
