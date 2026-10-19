// A small tagged result/finding model shared by the validator, the MCP server,
// and the web UI. Nothing here throws; callers inspect `ok` and `findings`.

/** @typedef {'error'|'warning'|'info'} Severity */

/**
 * @typedef {Object} SourceLocation
 * @property {string} [file]   repo-relative file the finding is about
 * @property {number} [line]   1-based line
 * @property {number} [col]    1-based column
 * @property {string} [path]   dotted GON path, e.g. "JokersGambit.damage_instance.effects"
 */

/**
 * @typedef {Object} Finding
 * @property {Severity} severity
 * @property {string} code      stable machine code, e.g. "unknown-status"
 * @property {string} message   human-readable explanation
 * @property {SourceLocation} [location]
 */

/**
 * @param {Severity} severity
 * @param {string} code
 * @param {string} message
 * @param {SourceLocation} [location]
 * @returns {Finding}
 */
export function finding(severity, code, message, location) {
  return location ? { severity, code, message, location } : { severity, code, message };
}

/**
 * @typedef {Object} Report
 * @property {boolean} ok          true when there are no error-severity findings
 * @property {Finding[]} findings
 * @property {{ errors: number, warnings: number, infos: number }} counts
 */

export class ReportBuilder {
  constructor() {
    /** @type {Finding[]} */
    this.findings = [];
  }
  /** @param {Finding} f */
  add(f) {
    this.findings.push(f);
    return this;
  }
  /**
   * @param {string} code
   * @param {string} message
   * @param {SourceLocation} [location]
   */
  error(code, message, location) {
    return this.add(finding("error", code, message, location));
  }
  /**
   * @param {string} code
   * @param {string} message
   * @param {SourceLocation} [location]
   */
  warn(code, message, location) {
    return this.add(finding("warning", code, message, location));
  }
  /**
   * @param {string} code
   * @param {string} message
   * @param {SourceLocation} [location]
   */
  info(code, message, location) {
    return this.add(finding("info", code, message, location));
  }
  /** @returns {Report} */
  build() {
    let errors = 0;
    let warnings = 0;
    let infos = 0;
    for (const f of this.findings) {
      if (f.severity === "error") errors++;
      else if (f.severity === "warning") warnings++;
      else infos++;
    }
    return { ok: errors === 0, findings: this.findings, counts: { errors, warnings, infos } };
  }
}
