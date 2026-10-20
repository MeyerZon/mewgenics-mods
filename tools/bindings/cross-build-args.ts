// Argument parsing for tools/bindings/cross-build.ts, kept apart so a T0 test can pin it without two real exes
// (editor/test/bindings-tests.ts "cross-build.ts args").
export const USAGE = "usage: node tools/bindings/cross-build.ts --old <old exe> --new <new exe> [--build <steamBuildId>] [--gameVersion <x.y.z>]";

export interface CrossBuildArgs {
  oldPath?: string;
  newPath?: string;
  build: string;
  gameVersion?: string;
  error: string | null;
}

export function parseCrossBuildArgs(argv: string[]): CrossBuildArgs {
  /** a flag's value: undefined when absent, null when dangling or followed by another flag */
  const opt = (flag: string): string | null | undefined => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? null : v;
  };
  const oldPath = opt("--old");
  const newPath = opt("--new");
  const build = opt("--build");
  const gameVersion = opt("--gameVersion");
  const bad = !oldPath || !newPath || build === null || gameVersion === null;
  return {
    oldPath: oldPath || undefined,
    newPath: newPath || undefined,
    build: build || "999999999",
    gameVersion: gameVersion || undefined,
    error: bad ? USAGE : null,
  };
}
