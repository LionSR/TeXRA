from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "lecture2text")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="transcribe",
        help="Mode of operation, either 'transcribe', 'punctuate', '2tex', or 'reflect'.",
        choices=["transcribe", "punctuate", "2tex", "reflect"],
    )
    args = parser.parse_args()

    lecture2text = DirectWrite(args, agent_path)
    lecture2text.run()


if __name__ == "__main__":
    main()
