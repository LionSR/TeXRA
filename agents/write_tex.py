from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "write")


class WriteTex(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)

        if self.args.sample_files:
            user_vars["REFERENCE_CONTENT"] = "\n".join([coa.read_file(sample) for sample in self.args.sample_files])
        else:
            user_vars["REFERENCE_CONTENT"] = ""

        coa.update_user_vars_single_output(self.args, user_vars)

        if self.args.input_files:
            for file in self.args.input_files:
                if "main" in file.lower():
                    user_vars["PAPER_CONTENT"] = coa.read_file(file)
                    break

        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="paper2cover",
        choices=["paper2cover", "proposal", "slide2paper", "paper2slide", "paper2referee", "revise_referee"],
    )
    args = parser.parse_args()

    write_tex = WriteTex(args, agent_path)
    write_tex.run()


if __name__ == "__main__":
    main()
