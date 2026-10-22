// T3 looks gallery — the pure half of `npm run t3` (scripts/t3-gallery.ts does the file system).
//
// T3 is the tier of docs/tdd-procedure.md for what no test can see (look, feel, balance). Every art / harness PR left
// T3 items in its body and the shots live in git-ignored run dirs; editor/t3-looks.json is the curated list of those
// items (one yes/no question each), and this module turns it into one self-contained HTML page: one card per item
// with its shots (copied next to the page, so it survives run-dir cleanup), a Yes / No / Not sure control kept in
// localStorage, a summary bar and an "Export answers" button that downloads the answers as JSON.
//
// A shot is a path relative to the editor data dir (MEWGENICS_EDITOR_DATA, default editor/data/). A `*` in a
// segment matches run dirs; the newest (lexicographically last — run dirs start with a yyyymmdd-hhmmss stamp) that
// holds the rest of the path wins. An item whose shots are all missing is a "needs re-run: <regenerate>" card; an
// item with no shots at all is a hands-on check whose `regenerate` says where to look.

export type T3Status = "open" | "done";
export interface T3Item { id: string; pr: number; question: string; shots: string[]; regenerate: string; status: T3Status }
export interface ResolvedItem extends T3Item { found: { pattern: string; file: string }[]; missing: string[] }
export type T3Answer = "yes" | "no" | "unsure";
/** the data dir as seen by resolveShot: paths are relative, `/`-separated */
export interface ShotFs { exists: (rel: string) => boolean; list: (relDir: string) => string[] }

const STATUSES: readonly string[] = ["open", "done"];

/** parse + check editor/t3-looks.json; never throws (a broken list is a list of errors) */
export function parseLooks(text: string): { items: T3Item[]; errors: string[] } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { items: [], errors: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] }; }
  if (!Array.isArray(raw)) return { items: [], errors: ["t3-looks.json must be an array of items"] };
  const items: T3Item[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  raw.forEach((r: unknown, i: number) => {
    if (!r || typeof r !== "object") { errors.push(`item ${i}: not an object`); return; }
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id : null;
    const name = id ? `"${id}"` : `item ${i}`;
    const before = errors.length;
    if (!id) errors.push(`${name}: id must be a non-empty string`);
    else if (seen.has(id)) errors.push(`duplicate id "${id}"`);
    else seen.add(id);
    if (!Number.isInteger(o.pr) || (o.pr as number) <= 0) errors.push(`${name}: pr must be a positive PR number`);
    if (typeof o.question !== "string" || !o.question.trim()) errors.push(`${name}: question must be a non-empty yes/no question`);
    if (typeof o.regenerate !== "string" || !o.regenerate.trim()) errors.push(`${name}: regenerate must say how to (re)make the shots or where to check`);
    if (typeof o.status !== "string" || !STATUSES.includes(o.status)) errors.push(`${name}: status must be "open" or "done"`);
    if (!Array.isArray(o.shots) || o.shots.some((s) => typeof s !== "string")) errors.push(`${name}: shots must be an array of paths`);
    else for (const s of o.shots as string[]) {
      if (!s || s.includes("\\") || s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
        errors.push(`${name}: shot ${JSON.stringify(s)} must be a relative /-path under the editor data dir (no .., no drive, no backslash)`);
      }
    }
    if (errors.length === before) items.push({ id: id!, pr: o.pr as number, question: o.question as string, shots: o.shots as string[], regenerate: o.regenerate as string, status: o.status as T3Status });
  });
  return { items, errors };
}

function globSegment(seg: string): RegExp {
  return new RegExp(`^${seg.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** a shot pattern → the data-relative path of the file to show, or null when no run holds it */
export function resolveShot(pattern: string, fs: ShotFs): string | null {
  const walk = (base: string, rest: string[]): string | null => {
    const join = (seg: string) => (base ? `${base}/${seg}` : seg);
    if (rest.length === 0) return fs.exists(base) ? base : null;
    const [seg, ...tail] = rest;
    if (!seg!.includes("*")) return walk(join(seg!), tail);
    const re = globSegment(seg!);
    const candidates = fs.list(base).filter((n) => re.test(n)).sort().reverse();
    for (const c of candidates) { const hit = walk(join(c), tail); if (hit) return hit; }
    return null;
  };
  return walk("", pattern.split("/"));
}

/** the file name a resolved shot gets under t3-gallery/shots/ (ingame-runs/<run>/<f> → <run>__<f>) */
export function copiedName(rel: string): string {
  const segs = rel.split("/");
  if (segs[0] === "ingame-runs" && segs.length > 2) segs.shift();
  return segs.join("__");
}

function cardState(it: ResolvedItem): "shots" | "rerun" | "hands-on" {
  if (it.shots.length === 0) return "hands-on";
  return it.found.length > 0 ? "shots" : "rerun";
}

export function summarize(items: ResolvedItem[]): { total: number; withShots: number; needsRerun: number; handsOn: number } {
  const s = { total: items.length, withShots: 0, needsRerun: 0, handsOn: 0 };
  for (const it of items) {
    const st = cardState(it);
    if (st === "shots") s.withShots++; else if (st === "rerun") s.needsRerun++; else s.handsOn++;
  }
  return s;
}

// NOTE: this function's source is embedded verbatim in the page (renderGallery), so the export a browser downloads
// and the one the tests check are the same code: keep it plain JS once types are stripped (parameter/return types
// only), and keep its closing brace the only `}` at column 0.
export function buildAnswersExport(items: { id: string; pr: number; question: string }[], answers: Record<string, string>, exportedAt: string): { kind: string; version: number; exportedAt: string; counts: { yes: number; no: number; unsure: number; unanswered: number }; answers: { id: string; pr: number; question: string; answer: string | null }[] } {
  var counts = { yes: 0, no: 0, unsure: 0, unanswered: 0 };
  var rows = items.map(function (it) {
    var a = answers[it.id];
    var answer: "yes" | "no" | "unsure" | null = a === "yes" || a === "no" || a === "unsure" ? a : null;
    if (answer) counts[answer] += 1; else counts.unanswered += 1;
    return { id: it.id, pr: it.pr, question: it.question, answer: answer };
  });
  return { kind: "mewgenics-t3-answers", version: 1, exportedAt: exportedAt, counts: counts, answers: rows };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** JSON safe inside a <script> element (no `</script>`, no `<!--`, no U+2028/9 surprises) */
function scriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
const urlPath = (name: string) => name.split("/").map(encodeURIComponent).join("/");

function card(it: ResolvedItem, repoUrl: string): string {
  const st = cardState(it);
  const badge = st === "shots" ? "shots" : st === "rerun" ? "needs re-run" : "hands-on";
  const body = st === "shots"
    ? `<div class="shots">${it.found.map((f) => `<a class="shot" href="shots/${urlPath(f.file)}" target="_blank" rel="noopener"><img loading="lazy" src="shots/${urlPath(f.file)}" alt="${esc(f.file)}"><span>${esc(f.file)}</span></a>`).join("")}</div>`
      + (it.missing.length ? `<p class="note">missing: ${it.missing.map((m) => `<code>${esc(m)}</code>`).join(", ")} — re-run: <code>${esc(it.regenerate)}</code></p>` : "")
      + `<p class="note">regenerate: <code>${esc(it.regenerate)}</code></p>`
    : st === "rerun"
      ? `<p class="rerun">needs re-run: ${esc(it.regenerate)}</p><p class="note">no run on disk holds ${it.missing.map((m) => `<code>${esc(m)}</code>`).join(", ")}</p>`
      : `<p class="handson">check by hand: ${esc(it.regenerate)}</p>`;
  return `<article class="card" id="item-${esc(it.id)}" data-id="${esc(it.id)}" data-state="${st}">
<header><span class="id">${esc(it.id)}</span><a class="pr" href="${esc(repoUrl)}/pull/${it.pr}" target="_blank" rel="noopener">PR #${it.pr}</a><span class="badge b-${st}">${badge}</span>${it.status === "done" ? `<span class="badge b-done">done</span>` : ""}</header>
<h2>${esc(it.question)}</h2>
${body}
<div class="answer" role="group" aria-label="Your answer">
<button type="button" data-answer="yes">Yes</button><button type="button" data-answer="no">No</button><button type="button" data-answer="unsure">Not sure</button>
</div>
</article>`;
}

const CSS = `:root{--bg:#f6f5f2;--card:#fff;--fg:#1d1d1f;--muted:#6b6b70;--line:#dedcd6;--accent:#3b5bdb;--yes:#2f9e44;--no:#e03131;--unsure:#f08c00;--code:#efede8}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151517;--card:#1f1f23;--fg:#ececef;--muted:#9a9aa3;--line:#33333a;--accent:#7b93ff;--yes:#51cf66;--no:#ff6b6b;--unsure:#ffa94d;--code:#2a2a30}}
:root[data-theme="dark"]{--bg:#151517;--card:#1f1f23;--fg:#ececef;--muted:#9a9aa3;--line:#33333a;--accent:#7b93ff;--yes:#51cf66;--no:#ff6b6b;--unsure:#ffa94d;--code:#2a2a30}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:22px;margin:8px 0 4px}p.lede{color:var(--muted);margin:0 0 12px}
#bar{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
#summary{flex:1 1 auto;color:var(--muted)}#summary b{color:var(--fg)}
#bar button{font:inherit;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin:14px 0}
.card header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}.id{font-family:ui-monospace,monospace;color:var(--muted)}
.pr{color:var(--accent)}.badge{border-radius:99px;padding:1px 8px;font-size:12px;border:1px solid var(--line)}.b-rerun{color:var(--no)}.b-hands-on{color:var(--unsure)}.b-shots{color:var(--yes)}.b-done{color:var(--muted)}
.card h2{font-size:17px;margin:8px 0 10px}.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}
.shot{display:block;color:var(--muted);font-size:12px;text-decoration:none;word-break:break-all}.shot img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:6px;background:#000}
.note{color:var(--muted);font-size:13px;margin:8px 0 0}.rerun{color:var(--no);font-weight:600}.handson{color:var(--fg)}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12.5px;word-break:break-word}
.answer{display:flex;gap:8px;margin-top:12px}.answer button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.answer button[data-answer="yes"].on{background:var(--yes);border-color:var(--yes);color:#fff}.answer button[data-answer="no"].on{background:var(--no);border-color:var(--no);color:#fff}.answer button[data-answer="unsure"].on{background:var(--unsure);border-color:var(--unsure);color:#fff}
@media (max-width:600px){.shots{grid-template-columns:1fr}}`;

const PAGE_JS = `var KEY = "mewgenics.t3.answers";
function load() { try { var v = JSON.parse(localStorage.getItem(KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }
var answers = load();
function paint() {
  var c = { yes: 0, no: 0, unsure: 0 }, n = 0;
  document.querySelectorAll(".card").forEach(function (el) {
    var a = answers[el.getAttribute("data-id")];
    el.querySelectorAll("[data-answer]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-answer") === a); b.setAttribute("aria-pressed", String(b.getAttribute("data-answer") === a)); });
    if (a === "yes" || a === "no" || a === "unsure") { c[a]++; n++; }
  });
  document.getElementById("answered").innerHTML = "<b>" + n + "</b> of " + ITEMS.length + " answered · " + c.yes + " yes · " + c.no + " no · " + c.unsure + " not sure";
}
document.addEventListener("click", function (ev) {
  var b = ev.target.closest && ev.target.closest("[data-answer]");
  if (!b) return;
  var id = b.closest(".card").getAttribute("data-id"), v = b.getAttribute("data-answer");
  if (answers[id] === v) delete answers[id]; else answers[id] = v;
  save(answers); paint();
});
document.getElementById("export").addEventListener("click", function () {
  var data = buildAnswersExport(ITEMS, answers, new Date().toISOString());
  var url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\\n"], { type: "application/json" }));
  var a = document.createElement("a"); a.href = url; a.download = "t3-answers-" + data.exportedAt.slice(0, 10) + ".json";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});
document.getElementById("clear").addEventListener("click", function () { if (confirm("Clear every answer on this page?")) { answers = {}; save(answers); paint(); } });
paint();`;

/** the whole page (self-contained: inline CSS + JS, shots referenced as shots/<copiedName>) */
export function renderGallery(items: ResolvedItem[], opts: { generatedAt: string; repoUrl: string }): string {
  const s = summarize(items);
  const meta = items.map((it) => ({ id: it.id, pr: it.pr, question: it.question }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>T3 Looks</title>
<style>
${CSS}
</style>
</head>
<body>
<div id="bar"><span id="summary"><span id="answered"></span> · ${s.total} items: ${s.withShots} with shots · ${s.needsRerun} need a re-run · ${s.handsOn} hands-on</span><button type="button" id="export">Export answers</button><button type="button" id="clear">Clear</button></div>
<main>
<h1>T3 looks — what only a human can judge</h1>
<p class="lede">One card per T3 item from the PR bodies (the list is <code>editor/t3-looks.json</code>; rebuild this page with <code>cd editor &amp;&amp; npm run t3</code>). Answers stay in this browser until you export them. Generated ${esc(opts.generatedAt)}.</p>
${items.map((it) => card(it, opts.repoUrl)).join("\n")}
</main>
<script>
var ITEMS = ${scriptJson(meta)};
${buildAnswersExport.toString()}
${PAGE_JS}
</script>
</body>
</html>
`;
}
