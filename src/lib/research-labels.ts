export const ORIGIN_LABEL: Record<string, string> = {
  chatgpt_original: "ChatGPT original",
  chatgpt_reconstructed: "ChatGPT reconstruction",
  claude_targeted_update: "Claude targeted update",
  claude_full: "Claude full research",
  manual: "Entered by you",
};

export const EXTRACTION_LABEL: Record<string, string> = {
  verbatim: "Original text",
  reconstructed: "Reconstructed",
  summary_only: "Summary only",
  truncated: "Truncated",
  missing: "Missing",
};
