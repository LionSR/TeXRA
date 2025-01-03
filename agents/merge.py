import coauthor as coa
from coauthor.logger import logger


def main():
    parser = coa.get_common_argparser()
    args = parser.parse_args()
    logger.debug(f"Args: {args}")

    coa.run_merge_agent(model=args.model, inputFile=args.inputFile, editedFile=args.editedFile)


if __name__ == "__main__":
    main()
