import coauthor as coa
from coauthor.logger import logger


def main():
    parser = coa.get_common_argparser()
    args = parser.parse_args()
    logger.debug(f"Args: {args}")

    coa.run_merge(model=args.model, input_file=args.input_file, edited_file=args.edited_file)


if __name__ == "__main__":
    main()
