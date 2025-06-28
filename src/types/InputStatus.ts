export interface RequiredFileStatus {
  path: string;
  varName: string;
  found: boolean;
}

export interface InputStatus {
  required: RequiredFileStatus[];
  figures: string[];
}
