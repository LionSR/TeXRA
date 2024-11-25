from coauthor.agent_reflect import DirectWrite, ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "meeting2text")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="transcribe_dual",
        help="Agent to choose: 'transcribe_one', 'transcribe_dual', 'text2tex', or 'text2tex_draft'.",
        choices=["transcribe_one", "transcribe_dual", "text2tex", "text2tex_draft"],
    )
    args = parser.parse_args()

    if args.agent == "transcribe_dual" and args.reference_files is None:
        parser.error("The transcribe_dual agent requires --reference_files to be specified.")

    if args.agent == "text2tex":
        text2tex = ThinkAndWrite(args, agent_path)
        text2tex.run()
    elif args.agent == "text2tex_draft":
        text2tex_draft = ThinkAndWrite(args, agent_path)
        text2tex_draft.run()
    else:
        meeting2text = DirectWrite(args, agent_path)
        meeting2text.run()


if __name__ == "__main__":
    main()
