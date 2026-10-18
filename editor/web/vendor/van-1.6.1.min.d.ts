// Type surface for the vendored VanJS 1.6.1 (van-1.6.1.min.js).
// Hand-written so tsc type-checks against this instead of parsing the minified file.
// Covers only the small API this project uses.

export interface State<T> {
  val: T;
  readonly oldVal: T;
  rawVal: T;
}

export type ChildPrimitive = Node | string | number | boolean | null | undefined | State<any> | (() => any);
// VanJS flattens array children (add uses .flat(Infinity)), so arrays are valid.
export type ChildDom = ChildPrimitive | readonly ChildDom[];

export interface TagFunc {
  (first?: Record<string, any> | ChildDom, ...rest: ChildDom[]): HTMLElement;
}

export interface Van {
  tags: Record<string, TagFunc> & ((namespace: string) => Record<string, TagFunc>);
  state<T>(v: T): State<T>;
  derive<T>(f: () => T): State<T>;
  add(dom: Element, ...children: ChildDom[]): Element;
  hydrate(dom: Element, f: (dom: Element) => any): any;
}

declare const van: Van;
export default van;
