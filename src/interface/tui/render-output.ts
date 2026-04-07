const ANSI_ONLY_CHUNK = /^(?:\u001b\[[0-9;?]*[ -/]*[@-~])+$/;

export function isRenderableFrameChunk(chunk: string): boolean {
  return chunk.length > 0 && !ANSI_ONLY_CHUNK.test(chunk);
}
