// Lexical GON highlighter (pure; lifted from the VanJS app.mjs so it can be unit-tested).
// Produces HTML with <span> classes matching the design palette: Capitalized identifiers read
// as class/status refs (cls), keywords (kw), strings (s), numbers (n), comments (c),
// punctuation (p), other identifiers (k). Always returns the full escaped text so nothing is
// ever hidden if a token class can't be decided.

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const GON_KW = new Set(["variant_of", "true", "false", "null"]);

export function highlightGon(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") { out += "\n"; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { out += c; i++; continue; }
    // line comment
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      out += `<span class="c">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // string
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === '"') { j++; break; }
        if (text[j] === "\n") break;
        j++;
      }
      out += `<span class="s">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // number
    if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(text[i + 1] || ""))) {
      let j = i + 1;
      while (j < n && /[0-9eExXa-fA-F.+_-]/.test(text[j]!)) j++;
      out += `<span class="n">${esc(text.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // punctuation
    if (c === "{" || c === "}" || c === "=" || c === ";" || c === "," || c === "[" || c === "]") {
      out += `<span class="p">${esc(c)}</span>`;
      i++;
      continue;
    }
    // identifier
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      let k = "k";
      if (GON_KW.has(word)) k = "kw";
      else if (/^[A-Z]/.test(word)) k = "cls";
      out += `<span class="${k}">${esc(word)}</span>`;
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}
