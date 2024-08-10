from coauthor.base_tasks import ThinkAndWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "write")


class WriteTex(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)

        if self.args.sample_files:
            user_vars["REFERENCE_CONTENT"] = "\n".join([coa.read_file(sample) for sample in self.args.sample_files])
        else:
            user_vars["REFERENCE_CONTENT"] = ""

        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    # The handle_output method is inherited from ThinkAndWrite


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="paper2cover", choices=["paper2cover", "proposal", "slide2paper", "paper2slide"])
    args = parser.parse_args()

    write_tex = WriteTex(args, prompt_path)
    write_tex.run()


if __name__ == "__main__":
    main()
