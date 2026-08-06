// Atlassian Document Format helpers.
//
// Jira's v3 API takes ADF rather than plain text or wiki markup, so a comment
// typed in a textarea has to be converted before it can be posted. This covers
// the shape a comment box actually needs — paragraphs and line breaks — and
// deliberately does not attempt rich text: silently mangling someone's markup
// would be worse than posting it literally.

export const ADF_VERSION = 1;

export function emptyDoc() {
  return { type: "doc", version: ADF_VERSION, content: [] };
}

// Blank lines separate paragraphs; single newlines become hard breaks inside
// one paragraph, which is how people expect a textarea to behave.
export function textToAdf(text) {
  const normalised = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalised) return emptyDoc();

  const paragraphs = normalised.split(/\n{2,}/);
  const content = [];

  for (const para of paragraphs) {
    const lines = para.split("\n");
    const inline = [];
    lines.forEach((line, i) => {
      if (i > 0) inline.push({ type: "hardBreak" });
      if (line.length) inline.push({ type: "text", text: line });
    });
    if (inline.length) content.push({ type: "paragraph", content: inline });
  }

  return { type: "doc", version: ADF_VERSION, content };
}

export function isEmptyAdf(doc) {
  return !doc?.content?.length;
}

// Fallback for rendering a comment when Jira didn't return renderedBody:
// walks the ADF and pulls out its text so something readable still shows.
export function adfToPlainText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return String(node.text ?? "");
  if (node.type === "hardBreak") return "\n";

  const inner = Array.isArray(node.content)
    ? node.content.map(adfToPlainText).join("")
    : "";

  // Block-level nodes end with a break so paragraphs don't run together.
  const BLOCKS = new Set([
    "paragraph", "heading", "blockquote", "codeBlock",
    "listItem", "bulletList", "orderedList", "panel", "rule",
  ]);
  return BLOCKS.has(node.type) ? `${inner}\n` : inner;
}
