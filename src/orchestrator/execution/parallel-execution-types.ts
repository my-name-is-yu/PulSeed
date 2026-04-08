export interface SubtaskResult {
  task_id: string;
  verdict: "pass" | "partial" | "fail";
  output: string;
  error?: string;
}
