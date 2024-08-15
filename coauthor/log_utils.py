import os
import re
from datetime import datetime
from termcolor import colored

from .model_utils import compute_api_price
from .file_utils import append_file


def log_start(args):
    # Get the directory of the output name override or input file, or use appropriate fallback
    if args.output_name_override:
        input_dir = os.path.dirname(args.output_name_override)
        base_filename = os.path.basename(args.output_name_override)
    elif args.input_file:
        input_dir = os.path.dirname(args.input_file)
        base_filename = os.path.basename(args.input_file)
    else:
        input_dir = os.getcwd()
        base_filename = "default.xml"

    base_name = os.path.splitext(base_filename)[0]

    log_dir = os.path.join(input_dir, "Log")
    os.makedirs(log_dir, exist_ok=True)

    log_filename = f"{base_name}_log.xml"
    log_file = os.path.join(log_dir, log_filename)

    with open(log_file, "a+") as f:
        f.write("\n<log_entry>\n")
        f.write("  <metadata>\n")
        f.write(f"    <time>{datetime.now()}</time>\n")
        f.write(f"    <agent>{args.agent}</agent>\n")
        f.write(f"    <model>{args.model}</model>\n")

        optional_output_fields = ["output_name_override", "input_file", "input_files", "auxiliary_files", "figure_inputs"]

        for field in optional_output_fields:
            value = getattr(args, field, None)
            if value:
                f.write(f"    <{field}>{value}</{field}>\n")

        f.write("  </metadata>\n")
        f.write(f"  <instruction>{args.instruction}</instruction>\n")

    return log_file


def log_end(log_file):
    append_file(log_file, "</log_entry>\n")


def log_and_print_statistics(state, model, log_file=None, prompt_caching=False):
    total_input_tokens = state.get("total_input_tokens", 0)
    total_output_tokens = state.get("total_output_tokens", 0)
    total_response_time = state.get("total_response_time", 0)

    # Print the statistics to the command line
    print("Total input tokens  : {}".format(colored(total_input_tokens, "cyan")))
    print("Total output tokens : {}".format(colored(total_output_tokens, "cyan")))
    print("Total response time : {} seconds".format(colored(total_response_time, "green")))

    if prompt_caching:
        total_input_tokens_cached = state.get("total_input_tokens_cached", 0)
        total_output_tokens_cached = state.get("total_output_tokens_cached", 0)
        cost = compute_api_price(model, total_input_tokens, total_output_tokens, total_input_tokens_cached, total_output_tokens_cached)
        print(f"Total input tokens (cached): {total_input_tokens_cached}")
        print(f"Total output tokens (cached): {total_output_tokens_cached}")
    else:
        cost = compute_api_price(model, total_input_tokens, total_output_tokens)

    print("Total cost          : ${}".format(colored(f"{cost:.2f}", "yellow")))

    # Log the statistics to the log file if exists in the directory
    if os.path.exists(log_file):
        statistics_xml = f"""  <statistics
    total_input_tokens="{total_input_tokens}"
    total_output_tokens="{total_output_tokens}"
    total_response_time="{total_response_time:.2f}"
    total_cost="${cost:.2f}"
  />
"""
        append_file(log_file, statistics_xml)


def log_output_files(output_file, log_file):
    round_match = re.search(r"_r(\d+)_", output_file)
    round = int(round_match.group(1)) if round_match else 0
    tag = "reflection_output_file" if round > 0 else "output_file"
    append_file(log_file, f"  <{tag}>{output_file}</{tag}>\n")
