// HTML sanitiser for Jira-rendered content (issue descriptions, comment bodies).
//
// Jira returns these as HTML via `expand=renderedFields` / `renderedBody`, which
// saves hand-rendering Atlassian Document Format — but it is content authored by
// whoever can comment on the issue, so it is untrusted. The extension's CSP
// blocks inline scripts, which limits the blast radius; it does not make
// arbitrary HTML safe (an `<a href="javascript:…">`, a form posting elsewhere, or
// an `<iframe>` all survive CSP).
//
// Policy is an allowlist: anything not named here is dropped. The element walk
// takes an injected parser so the dangerous path can be unit-tested without a
// browser DOM.

export const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "span", "div",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "sub", "sup",
  "code", "pre", "tt", "kbd", "samp", "var",
  "blockquote", "q", "cite",
  "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
]);

// Elements whose *contents* must go too — a dropped <script> that left its text
// behind would dump code into the page as visible text at best.
export const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "applet", "form",
  "input", "button", "select", "textarea", "option", "link", "meta",
  "base", "svg", "math", "template", "noscript", "frame", "frameset",
]);

const GLOBAL_ATTRS = new Set(["title", "dir", "lang"]);

const TAG_ATTRS = {
  a: new Set(["href", "title", "rel", "target"]),
  img: new Set(["src", "alt", "width", "height", "title"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "type"]),
  code: new Set(["class"]),   // Jira marks code language with a class
  pre: new Set(["class"]),
  span: new Set(["class"]),
  div: new Set(["class"]),
};

const SAFE_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isAllowedTag(tagName) {
  return ALLOWED_TAGS.has(String(tagName || "").toLowerCase());
}

export function shouldDropWithContent(tagName) {
  return DROP_WITH_CONTENT.has(String(tagName || "").toLowerCase());
}

export function isAllowedAttr(tagName, attrName) {
  const tag = String(tagName || "").toLowerCase();
  const attr = String(attrName || "").toLowerCase();
  // Event handlers and anything that can hold a URL-ish payload we don't vet.
  if (attr.startsWith("on")) return false;
  if (attr === "style" || attr === "srcset" || attr === "formaction") return false;
  if (attr.startsWith("data-")) return false;
  if (GLOBAL_ATTRS.has(attr)) return true;
  return Boolean(TAG_ATTRS[tag]?.has(attr));
}

// Absolute http(s)/mailto only. Relative URLs are resolved against `base` when
// one is given (Jira emits site-relative links), otherwise dropped — a bare
// "/secure/…" href would resolve against the extension origin and go nowhere.
export function safeUrl(value, base = "") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  // Strip whitespace and control characters first: "java\tscript:alert(1)" and
  // "java\nscript:..." are real bypasses — the URL parser would otherwise
  // normalise them back into a working javascript: URL.
  const cleaned = raw.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (!cleaned) return null;
  try {
    const url = base ? new URL(cleaned, base) : new URL(cleaned);
    if (!SAFE_URL_SCHEMES.has(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}


// Walks a parsed tree and strips anything outside the policy, in place.
// `root` needs childNodes, and elements need tagName / attributes /
// removeAttribute / setAttribute — satisfied by the real DOM and by the test
// stub alike.
export function scrubTree(root, { base = "" } = {}) {
  const removed = { tags: [], attrs: [] };

  function walk(node) {
    const children = [...(node.childNodes || [])];
    for (const child of children) {
      // Text (3), CDATA (4) and anything without a tag name: keep as-is.
      if (child.nodeType === 3 || child.nodeType === 4) continue;
      if (child.nodeType === 8) {           // comment
        detach(node, child);
        continue;
      }
      const tag = String(child.tagName || "").toLowerCase();
      if (!tag) continue;

      if (shouldDropWithContent(tag)) {
        removed.tags.push(tag);
        detach(node, child);
        continue;
      }

      if (!isAllowedTag(tag)) {
        // Unknown but harmless wrapper: keep the text, drop the element.
        removed.tags.push(tag);
        unwrap(node, child);
        walk(node);
        return;
      }

      scrubAttrs(child, tag, removed, base);
      walk(child);
    }
  }

  walk(root);
  return removed;
}

function scrubAttrs(el, tag, removed, base) {
  const names = attrNames(el);
  for (const name of names) {
    if (!isAllowedAttr(tag, name)) {
      removed.attrs.push(`${tag}[${name}]`);
      el.removeAttribute(name);
      continue;
    }
    if (name === "href" || name === "src") {
      const safe = safeUrl(getAttr(el, name), base);
      if (!safe) {
        removed.attrs.push(`${tag}[${name}]`);
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, safe);
      }
    }
  }
  // Links always open externally and never hand over the referrer/opener.
  if (tag === "a" && getAttr(el, "href")) {
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  }
}

function attrNames(el) {
  const attrs = el.attributes;
  if (!attrs) return [];
  if (typeof attrs.length === "number") {
    return Array.from({ length: attrs.length }, (_, i) => attrs[i].name);
  }
  return Object.keys(attrs);
}

function getAttr(el, name) {
  if (typeof el.getAttribute === "function") return el.getAttribute(name);
  return el.attributes?.[name];
}

function detach(parent, child) {
  if (typeof child.remove === "function") child.remove();
  else parent.removeChild(child);
}

function unwrap(parent, child) {
  const kids = [...(child.childNodes || [])];
  for (const kid of kids) {
    if (typeof parent.insertBefore === "function") parent.insertBefore(kid, child);
  }
  detach(parent, child);
}

// Browser entry point: parse Jira HTML and return a scrubbed fragment ready to
// append. DOMParser does not run scripts and does not fetch subresources, so
// nothing dangerous happens before the scrub.
export function sanitizeToFragment(html, { base = "" } = {}) {
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
  scrubTree(doc.body, { base });
  const fragment = document.createDocumentFragment();
  while (doc.body.firstChild) fragment.appendChild(doc.body.firstChild);
  return fragment;
}
