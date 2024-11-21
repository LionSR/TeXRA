import coauthor as coa
from coauthor.agent_reflect import ThinkAndWrite, DirectWrite

agent_path = coa.get_agent_path(coa, "article")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="correct",
        choices=[
            "correct",
            "polish",
            "draw",
            "correct_multiple",
            "polish_multiple",
            "draw_multiple",
            "convert",
            "ocr",
        ],
    )

    args = parser.parse_args()

    # OCR agent should use ThinkAndWrite to analyze notation and ensure consistency
    if args.agent.startswith("correct"):
        edit_tex = DirectWrite(args, agent_path)
    else:
        edit_tex = ThinkAndWrite(args, agent_path)
    edit_tex.run()


if __name__ == "__main__":
    main()
