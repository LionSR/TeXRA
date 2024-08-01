from coauthor.base_tasks import ThinkWriteAndReflect
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "write")


class WriteTex(ThinkWriteAndReflect):
    def get_user_vars(self):
        user_vars = coa.get_user_vars(self.args)

        if self.args.sample_files:
            user_vars["REFERENCE_CONTENT"] = "\n".join([coa.read_file(sample) for sample in self.args.sample_files])
        else:
            user_vars["REFERENCE_CONTENT"] = ""

        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    def handle_output(self, state, end_turn, output_file):
        if end_turn:
            if "<scratchpad>" in self.output_settings["prefill_first"]:
                coa.ensure_correct_xml_structure(output_file, self.task_settings["document_tag"])
                output_file = coa.split_scratchpad_output_xml(output_file, self.task_settings["document_tag"])

            if self.output_settings["output_type"] == "tex":
                coa.run_latexdiff(self.args.input_file, output_file, self.args.task, self.args.model)

        coa.log_output_files(output_file, self.log_file)
        coa.log_and_print_statistics(state, self.args.model, self.log_file)


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--task", type=str, default="paper2cover", choices=["paper2cover", "proposal", "slide2paper", "paper2slide"])
    args = parser.parse_args()

    write_tex = WriteTex(args, prompt_path)
    write_tex.run()


if __name__ == "__main__":
    main()
