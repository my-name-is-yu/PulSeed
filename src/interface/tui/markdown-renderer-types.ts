export interface MarkdownSegment {
  text: string;
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  color?: string;
}

export interface MarkdownLine {
  text: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  segments?: MarkdownSegment[];
  language?: string;
}
