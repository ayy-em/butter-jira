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

// True when `textToAdf` could have produced this document: paragraphs of
// unmarked text and line breaks, nothing else. An editor that round-trips a
// description through a textarea uses it to warn before saving over lists,
// links, tables or code that the plain text cannot carry.
export function isPlainAdf(doc) {
  if (!doc || typeof doc !== "object") return true;
  return (doc.content || []).every(
    (block) =>
      block?.type === "paragraph" &&
      (block.content || []).every(
        (node) =>
          node?.type === "hardBreak" ||
          (node?.type === "text" && !(Array.isArray(node.marks) && node.marks.length))
      )
  );
}

// The text a textarea should start from when editing a document, written so
// that `textToAdf` turns it back into the same thing wherever it can: blocks
// separated by a blank line (its paragraph break), hard breaks as single
// newlines. What it cannot carry — list structure, headings — is kept as
// readable text ("- item", "1. item") rather than dropped, so a flattening
// save loses the formatting and never the words.
export function adfToEditText(doc) {
  const inline = (node) => {
    if (!node || typeof node !== "object") return "";
    if (node.type === "text") return String(node.text ?? "");
    if (node.type === "hardBreak") return "\n";
    // Mentions, emoji, dates and inline cards carry their own display text.
    if (!Array.isArray(node.content)) return String(node.attrs?.text ?? node.attrs?.shortName ?? node.attrs?.url ?? "");
    return node.content.map(inline).join("");
  };
  const block = (node) => {
    if (!node || typeof node !== "object") return "";
    switch (node.type) {
      case "bulletList":
        return (node.content || []).map((item) => `- ${listItem(item)}`).join("\n");
      case "orderedList": {
        const start = Number(node.attrs?.order) || 1;
        return (node.content || []).map((item, i) => `${start + i}. ${listItem(item)}`).join("\n");
      }
      case "paragraph":
      case "heading":
      case "codeBlock":
        return inline(node);
      case "rule":
        return "---";
      default:
        return Array.isArray(node.content)
          ? node.content.map(block).filter((t) => t !== "").join("\n\n")
          : inline(node);
    }
  };
  // A list item's own blocks stay on consecutive lines, nested lists indented,
  // so the item reads as one entry rather than breaking the list apart.
  const listItem = (item) =>
    (item?.content || [])
      .map((child) => (child?.type?.endsWith("List") ? block(child).replace(/^/gm, "    ") : block(child)))
      .join("\n");
  return block(doc).replace(/\n+$/, "");
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
