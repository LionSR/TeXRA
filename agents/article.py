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
            "correct_tex",
            "polish_tex",
            "draw_tex",
            "correct_tex_multiple",
            "polish_tex_multiple",
            "draw_tex_multiple",
            "convert_tex",
            "ocr_tex",
        ],
    )

    args = parser.parse_args()

    # OCR agent should use ThinkAndWrite to analyze notation and ensure consistency
    if args.agent.startswith("correct"):
        agent = DirectWrite(args, agent_path)
    else:
        agent = ThinkAndWrite(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
