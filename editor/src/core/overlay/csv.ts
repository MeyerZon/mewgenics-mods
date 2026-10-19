// CSV parsing + overlay semantics for data/text/combined.csv and friends.
//
// `.append` adds new rows (the preferred way to add localization keys).
// `.merge` is POSITIONAL: overlay row i overwrites, column by column, base row i,
// but only where the overlay cell is non-empty (a row `,5,,` touches column 2
// only). This is fragile when the base game inserts rows and the validator warns
// about it.

/**
 * Parse CSV text into rows of string cells. Handles double-quoted fields with
 * embedded commas, newlines, and `""` escapes. A leading BOM is stripped.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let inQuotes = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // swallow; \n handles the row break (handles \r\n and lone \r before \n)
      if (text[i + 1] !== "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
    } else {
      field += c;
    }
  }
  // Flush a trailing field/row that had no final newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Serialize rows back to CSV text (quoting cells that need it). Uses `\n` line
 * endings and no BOM (callers add one if preserving the base file's style).
 * @param {string[][]} rows
 * @returns {string}
 */
export function serializeCsv(rows) {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell,
        )
        .join(","),
    )
    .join("\n");
}

/**
 * Build a map from the first-column key to its full row (first occurrence wins).
 * @param {string[][]} rows
 * @returns {Map<string, string[]>}
 */
export function keyedRows(rows) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const row of rows) {
    const key = row[0];
    if (key !== undefined && key !== "" && !map.has(key)) map.set(key, row);
  }
  return map;
}

/**
 * Append overlay rows after base rows.
 * @param {string[][]} base
 * @param {string[][]} overlay
 * @returns {string[][]}
 */
export function csvAppend(base, overlay) {
  return base.concat(overlay.map((r) => r.slice()));
}

/**
 * Positional column merge: overlay row i overwrites non-empty cells of base row i.
 * @param {string[][]} base
 * @param {string[][]} overlay
 * @returns {string[][]}
 */
export function csvPositionalMerge(base, overlay) {
  const out = base.map((r) => r.slice());
  for (let i = 0; i < overlay.length; i++) {
    if (i >= out.length) {
      out.push(overlay[i].slice());
      continue;
    }
    const orow = overlay[i];
    for (let j = 0; j < orow.length; j++) {
      if (orow[j] !== "") out[i][j] = orow[j];
    }
  }
  return out;
}
