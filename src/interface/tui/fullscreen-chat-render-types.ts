export type RenderSegment = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
};

export type RenderLine = {
  key: string;
  text?: string;
  segments?: RenderSegment[];
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  protected?: boolean;
};

export type SelectionState = {
  anchor: number;
  focus: number;
};

export type SelectionRange = {
  start: number;
  end: number;
};

export type CollapsedPasteRange = {
  start: number;
  end: number;
  label: string;
};

export type BodySelectionPoint = {
  rowIndex: number;
  offset: number;
};

export type BodySelectionState = {
  anchor: BodySelectionPoint;
  focus: BodySelectionPoint;
};

export type BodySelectionRange = {
  start: BodySelectionPoint;
  end: BodySelectionPoint;
};

export type InputCell = {
  text: string;
  width: number;
  offsetBefore: number;
  offsetAfter: number;
  selected?: boolean;
  placeholder?: boolean;
  dim?: boolean;
};

export type InputRow = {
  cells: InputCell[];
  startOffset: number;
  endOffset: number;
};

export type ComposerRender = {
  lines: RenderLine[];
  inputRows: InputRow[];
  inputRowStartIndex: number;
  contentStartCol: number;
};

export type ComposerLayout = {
  startLine: number;
  contentStartCol: number;
  rows: InputRow[];
};
