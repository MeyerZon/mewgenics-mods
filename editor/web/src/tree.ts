// Build a directory tree from the flat `relPath` list the core returns for a mod (pure).

export interface TreeFile {
  relPath: string;
  leaf: string;
  mode?: string;
  fileType?: string;
  [k: string]: unknown;
}

export interface TreeNode {
  name: string;
  path: string;
  dirs: Map<string, TreeNode>;
  files: TreeFile[];
}

export function buildTree(files: ReadonlyArray<{ relPath: string; [k: string]: unknown }>): TreeNode {
  const root: TreeNode = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = String(f.relPath).split("/");
    const leaf = parts.pop() ?? "";
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? acc + "/" + part : part;
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: acc, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ ...f, relPath: String(f.relPath), leaf });
  }
  return root;
}
