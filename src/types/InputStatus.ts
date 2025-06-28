export interface InputStatus {
  required: {
    path: string;
    varName: string;
    found: boolean;
  }[];
  figures: {
    path: string;
  }[];
}
