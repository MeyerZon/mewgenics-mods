// Shared pieces for the components: the store hook, the inline-style helper, the read-only
// highlighted code block, and the UI primitives every screen builds on (docs/editor-ts-react-plan.md
// "UI primitives and conventions"). The primitives render the app's existing classes (.btn, .pill, .tabs,
// .modal, .drawer, .menu, …) so a screen moved onto them keeps its DOM.

import React from "react";
import { S, type AppState } from "../state.ts";
import { useStore } from "../store.ts";
import { highlightGon } from "../gon-highlight.ts";
import { useDialog } from "../hooks/useDialog.ts";
import { pushOverlay, popOverlay } from "../shortcuts.ts";
import type { Finding } from "../types.ts";

export { EmptyState, PaneBoundary, type EmptyStateProps, type PaneBoundaryProps } from "./boundary.ts";

/** Subscribe to one slice of the app store (primitives or values already held in state). */
export function useS<R>(selector: (s: AppState) => R): R {
  return useStore(S, selector);
}

/**
 * Inline style string → React style object. The VanJS UI carried its one-off styles as
 * `style="a:b;c:d"` strings; the ported markup keeps them verbatim through this helper so the
 * rendered styles stay identical.
 */
export function sx(style: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of style.split(";")) {
    const i = part.indexOf(":");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k || !v) continue;
    out[k.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = v;
  }
  return out as React.CSSProperties;
}

/** A read-only highlighted code block (pre.mergecode.hl). */
export function CodeView({ text, extraClass }: { text: string; extraClass?: string }): React.JSX.Element {
  let html: string | null = null;
  try {
    html = highlightGon(text);
  } catch {
    html = null;
  }
  const cls = "mergecode hl" + (extraClass ? " " + extraClass : "");
  if (html === null) return <pre className={cls}>{text}</pre>;
  return <pre className={cls} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Pretty-printed JSON in a plain pre.mergecode. */
export function JsonView({ value }: { value: unknown }): React.JSX.Element {
  return <pre className="mergecode">{JSON.stringify(value, null, 2)}</pre>;
}

const cx = (...parts: (string | false | null | undefined)[]): string => parts.filter(Boolean).join(" ");

// ---- buttons ------------------------------------------------------------------------------
export type ButtonVariant = "primary" | "ghost" | "danger" | "accent";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm";
  children?: React.ReactNode;
}

/** `<button class="btn [variant] [sm]">`; type defaults to "button". */
export function Button({ variant, size, className, type, children, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button type={type || "button"} className={cx("btn", variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** required: an icon has no text for a screen reader */
  "aria-label": string;
  children?: React.ReactNode;
}

/** A borderless glyph button (`.iconbtn`), e.g. a dialog's ✕. */
export function IconButton({ className, type, children, ...rest }: IconButtonProps): React.JSX.Element {
  return (
    <button type={type || "button"} className={cx("iconbtn", className)} {...rest}>
      {children}
    </button>
  );
}

// ---- pills ----------------------------------------------------------------------------------
export type PillKind = "ok" | "warn" | "err" | "append" | "merge" | "patch" | "replace" | "muted";

export interface PillProps {
  kind: PillKind;
  /** the small `.chip` size */
  chip?: boolean;
  className?: string;
  title?: string;
  children?: React.ReactNode;
}

export function Pill({ kind, chip, className, title, children }: PillProps): React.JSX.Element {
  return (
    <span className={cx("pill", kind, chip && "chip", className)} title={title}>
      {children}
    </span>
  );
}

// ---- tabs / segmented ------------------------------------------------------------------------
export interface TabItem<T extends string> {
  id: T;
  label: React.ReactNode;
  title?: string;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label"?: string;
  /** "subtabs" renders the Art center's `.subtabs` row of `btn sm ghost` buttons with `.on` */
  variant?: "tabs" | "subtabs";
  className?: string;
}

/** A tablist: `.tabs > button.tab[role=tab][aria-selected]` (`.active` on the current one); ←/→ move the selection. */
export function Tabs<T extends string>({ items, value, onChange, variant = "tabs", className, ...aria }: TabsProps<T>): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const sub = variant === "subtabs";
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const at = items.findIndex((t) => t.id === value);
    const next = items[(at + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    const i = items.indexOf(next);
    const btn = ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[i];
    btn?.focus();
  };
  return (
    <div ref={ref} className={cx(sub ? "subtabs" : "tabs", className)} role="tablist" aria-label={aria["aria-label"]} onKeyDown={onKeyDown}>
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            title={t.title}
            className={sub ? cx("btn sm ghost", on && "on") : cx("tab", on && "active")}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The Art center's sub-tab row (`.subtabs .btn.sm.ghost` / `.on`), keyboard-navigable like Tabs. */
export function SubTabs<T extends string>(props: Omit<TabsProps<T>, "variant">): React.JSX.Element {
  return <Tabs {...props} variant="subtabs" />;
}

export interface SegmentedProps<T extends string> {
  options: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label"?: string;
  size?: "sm";
  className?: string;
}

/** A segmented toggle (`.modeswitch[role=group] > button.btn[aria-pressed]`, `.on` on the current one). */
export function Segmented<T extends string>({ options, value, onChange, size, className, ...aria }: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className={cx("modeswitch", className)} role="group" aria-label={aria["aria-label"]}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button key={o.id} type="button" className={cx("btn", size, on && "on")} aria-pressed={on} title={o.title} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- search / headers / empty states ----------------------------------------------------------
export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  /** required: the ⌕ glyph is not a label */
  "aria-label": string;
  placeholder?: string;
  /** show a ✕ that empties the box (calls onChange("")) */
  clearable?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

/** `.search` with the ⌕ glyph and a controlled input; optional ✕ clear. */
export function SearchBox({ value, onChange, placeholder, clearable, style, className, ...aria }: SearchBoxProps): React.JSX.Element {
  return (
    <div className={cx("search", className)} style={style}>
      <span aria-hidden="true">⌕</span>
      <input value={value} placeholder={placeholder} aria-label={aria["aria-label"]} onChange={(e) => onChange(e.currentTarget.value)} />
      {clearable && value ? (
        <IconButton aria-label="Clear search" onClick={() => onChange("")}>
          ✕
        </IconButton>
      ) : null}
    </div>
  );
}

export interface SectionHeaderProps {
  label: React.ReactNode;
  /** right-aligned control (a small button, a count) */
  action?: React.ReactNode;
  className?: string;
}

/** An explorer section header: `.exhead` with the `.sec` label and an optional right action. */
export function SectionHeader({ label, action, className }: SectionHeaderProps): React.JSX.Element {
  return (
    <div className={cx("exhead", className)}>
      <span className="sec">{label}</span>
      {action ?? null}
    </div>
  );
}

// ---- validation summary + findings -------------------------------------------------------------
export type SummaryLevel = "ok" | "warn" | "err";

export interface SummaryProps {
  level: SummaryLevel;
  title: React.ReactNode;
  detail?: React.ReactNode;
  /** the round badge glyph (default ✓ for ok, ! otherwise) */
  badge?: React.ReactNode;
}

/** The `.summary ok|warn|err` card: badge, title (`.t`), detail (`.d`). */
export function Summary({ level, title, detail, badge }: SummaryProps): React.JSX.Element {
  return (
    <div className={`summary ${level}`}>
      <div className="badge">{badge ?? (level === "ok" ? "✓" : "!")}</div>
      <div>
        <div className="t">{title}</div>
        {detail !== undefined ? <div className="d">{detail}</div> : null}
      </div>
    </div>
  );
}

export interface FindingsListProps {
  findings: Finding[];
  /** shown when there are none */
  empty?: React.ReactNode;
}

const MARK: Record<string, string> = { error: "✕", warning: "!", info: "i" };

/** One `.finding` row; memoized, so a re-validation that keeps a finding does not repaint it. */
const FindingRow = React.memo(function FindingRow({ f }: { f: Finding }): React.JSX.Element {
  return (
    <div className={`finding ${f.severity}`}>
      <span className="mark">{MARK[f.severity] || "i"}</span>
      <div>
        <div>
          <span className="code">{f.code}</span>
          {f.location && f.location.path ? <span className="muted">{`  @ ${f.location.path}`}</span> : null}
          {f.location && f.location.line ? <span className="muted">{`  line ${f.location.line}`}</span> : null}
        </div>
        <div>{f.message}</div>
      </div>
    </div>
  );
});

/** Stable row keys: code + path + line (a repeat of the same triple gets #2, #3, … in report order). */
export function findingKeys(findings: readonly Finding[]): string[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const k = `${f.code}|${f.location?.path ?? ""}|${f.location?.line ?? ""}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

/** `.finding <severity>` rows: the mark, the code, where (path / line), and the message. */
export function FindingsList({ findings, empty }: FindingsListProps): React.JSX.Element {
  const keys = React.useMemo(() => findingKeys(findings), [findings]);
  if (!findings.length) return <>{empty ?? null}</>;
  return (
    <div className="findings">
      {findings.map((f, n) => (
        <FindingRow key={keys[n]} f={f} />
      ))}
    </div>
  );
}

// ---- form controls ------------------------------------------------------------------------------
export interface FieldProps {
  label: React.ReactNode;
  /** the one control; it gets the generated id unless it already has one */
  children: React.ReactElement<{ id?: string }>;
  className?: string;
}

/** `<label class="fld" for=id>` followed by its control (label first: specs find the input as its next sibling). */
export function Field({ label, children, className }: FieldProps): React.JSX.Element {
  const auto = React.useId();
  const id = children.props.id || auto;
  return (
    <>
      <label className={cx("fld", className)} htmlFor={id}>
        {label}
      </label>
      {children.props.id ? children : React.cloneElement(children, { id })}
    </>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
}

/** `<label class="chk"><input type=checkbox> text</label>` (controlled). */
export function Checkbox({ checked, onChange, children, disabled, className, title, ...aria }: CheckboxProps): React.JSX.Element {
  return (
    <label className={cx("chk", className)} title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={aria["aria-label"]} onChange={(e) => onChange(e.currentTarget.checked)} />
      {children}
    </label>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  "aria-label"?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** A controlled `<select class="artinput">`. */
export function Select<T extends string>({ value, onChange, options, className, ...rest }: SelectProps<T>): React.JSX.Element {
  return (
    <select className={cx("artinput", className)} value={value} onChange={(e) => onChange(e.currentTarget.value as T)} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---- overlays -------------------------------------------------------------------------------------
export interface ModalProps {
  title: React.ReactNode;
  /** the glyph left of the title (decorative) */
  icon?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  /** the `.mfoot` row (buttons); omitted → no footer */
  footer?: React.ReactNode;
  /** what gets focus on open (a ref or a selector inside the modal); default: the first field, else the first focusable */
  initialFocus?: React.RefObject<HTMLElement | null> | string;
  className?: string;
}

/** `.scrim.center > .modal > .mhead / .mbody / .mfoot`; a real aria-modal dialog (useDialog). */
export function Modal({ title, icon, onClose, children, footer, initialFocus, className }: ModalProps): React.JSX.Element {
  const ref = useDialog<HTMLDivElement>(true, { onClose, initialFocus: initialFocus ?? ".mbody input, .mbody select, .mbody textarea", kind: "modal" });
  return (
    <div className="scrim center" onClick={onClose}>
      <div ref={ref} className={cx("modal", className)} onClick={(e) => e.stopPropagation()}>
        <div className="mhead">
          {icon !== undefined ? <span style={sx("font-size:18px")}>{icon}</span> : null}
          <div className="t">{title}</div>
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="mbody">{children}</div>
        {footer !== undefined ? <div className="mfoot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface DrawerProps {
  title: React.ReactNode;
  icon?: React.ReactNode;
  /** extra header content between the title and ✕ (a pill) */
  headExtra?: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  /** CSS width, e.g. "min(640px,96vw)"; default the .drawer width */
  width?: string;
  initialFocus?: React.RefObject<HTMLElement | null> | string;
  className?: string;
}

/** `.scrim.right > .drawer > .dhead / .dbody / .dfoot`; a real aria-modal dialog (useDialog). */
export function Drawer({ title, icon, headExtra, onClose, children, footer, width, initialFocus, className }: DrawerProps): React.JSX.Element {
  const ref = useDialog<HTMLDivElement>(true, { onClose, initialFocus, kind: "drawer" });
  return (
    <div className="scrim right" onClick={onClose}>
      <div ref={ref} className={cx("drawer", className)} style={width ? { width } : undefined} onClick={(e) => e.stopPropagation()}>
        <div className="dhead">
          {icon !== undefined ? <span style={sx("font-size:18px")}>{icon}</span> : null}
          <div className="t">{title}</div>
          {headExtra ?? null}
          <IconButton aria-label="Close" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        <div className="dbody">{children}</div>
        {footer !== undefined ? <div className="dfoot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface MenuProps {
  /** the trigger button's content */
  label: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** align the menu to the trigger's right edge */
  right?: boolean;
  /** trigger button class (default "btn ghost") */
  triggerClassName?: string;
  triggerStyle?: React.CSSProperties;
  "aria-label"?: string;
  /** the `.item`s (buttons), `.label`s and `.sep`s */
  children?: React.ReactNode;
}

/**
 * `.dropdown > button[aria-haspopup=menu][aria-expanded] + .menu`. Clicks inside do not reach the window's
 * click-outside closer; Esc closes (the overlay stack); ↑/↓ move focus between the enabled `.item` buttons; on
 * close, focus that was inside the menu (or lost with it) goes back to the trigger.
 */
export function Menu({ label, open, onToggle, onClose, right, triggerClassName, triggerStyle, children, ...aria }: MenuProps): React.JSX.Element {
  const trigger = React.useRef<HTMLButtonElement | null>(null);
  const menu = React.useRef<HTMLDivElement | null>(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  React.useEffect(() => {
    if (!open) return;
    const token = pushOverlay(() => closeRef.current(), "menu");
    return () => popOverlay(token);
  }, [open]);
  const wasOpen = React.useRef(false);
  React.useLayoutEffect(() => {
    if (wasOpen.current && !open) {
      const a = document.activeElement;
      if (!a || a === document.body) trigger.current?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);
  const items = (): HTMLElement[] => [...(menu.current?.querySelectorAll<HTMLElement>("button.item:not([disabled])") || [])];
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!open) {
      onToggle();
      return;
    }
    const list = items();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at < 0 ? 0 : (at + 1) % list.length) : at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
    list[next]!.focus();
  };
  return (
    <div className="dropdown" onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className={triggerClassName ?? "btn ghost"}
        style={triggerStyle}
        aria-label={aria["aria-label"]}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {label}
      </button>
      {open ? (
        <div ref={menu} className={cx("menu", right && "right")} onClick={(e) => e.stopPropagation()}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
