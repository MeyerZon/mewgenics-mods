// A small tagged result/finding model shared by the validator, the MCP server,
// and the web UI. Nothing here throws; callers inspect `ok` and `findings`.

export type Severity = "error" | "warning" | "info";

export interface SourceLocation {
  /** repo-relative file the finding is about */
  file?: string;
  /** 1-based line */
  line?: number;
  /** 1-based column */
  col?: number;
  /** dotted GON path, e.g. "JokersGambit.damage_instance.effects" */
  path?: string;
}

export interface Finding {
  severity: Severity;
  /** stable machine code, e.g. "unknown-status" */
  code: string;
  /** human-readable explanation */
  message: string;
  location?: SourceLocation;
}

export function finding(severity: Severity, code: string, message: string, location?: SourceLocation): Finding {
  return location ? { severity, code, message, location } : { severity, code, message };
}

export interface Report {
  /** true when there are no error-severity findings */
  ok: boolean;
  findings: Finding[];
  counts: { errors: number; warnings: number; infos: number };
}

export class ReportBuilder {
  findings: Finding[] = [];
  add(f: Finding): this {
    this.findings.push(f);
    return this;
  }
  error(code: string, message: string, location?: SourceLocation): this {
    return this.add(finding("error", code, message, location));
  }
  warn(code: string, message: string, location?: SourceLocation): this {
    return this.add(finding("warning", code, message, location));
  }
  info(code: string, message: string, location?: SourceLocation): this {
    return this.add(finding("info", code, message, location));
  }
  build(): Report {
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
