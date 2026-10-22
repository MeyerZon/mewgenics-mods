// EmptyState and PaneBoundary, written without JSX so Node can load this module directly in the unit tests
// (test/web-tests.ts). components/ui.tsx re-exports both; components import them from there.

import React from "react";

export interface EmptyStateProps {
  /** a short glyph shown above the title (decorative) */
  icon?: React.ReactNode;
  title: React.ReactNode;
  body?: React.ReactNode;
  /** buttons under the body */
  actions?: React.ReactNode;
  className?: string;
}

/** A centred "nothing here yet / something went wrong" block; sits well inside .emptycenter. */
export function EmptyState({ icon, title, body, actions, className }: EmptyStateProps): React.JSX.Element {
  const h = React.createElement;
  return h(
    "div",
    { className: "emptystate" + (className ? " " + className : "") },
    icon !== undefined ? h("div", { className: "es-icon", "aria-hidden": "true" }, icon) : null,
    h("div", { className: "es-title" }, title),
    body !== undefined ? h("div", { className: "es-body" }, body) : null,
    actions !== undefined ? h("div", { className: "es-actions" }, actions) : null,
  );
}

export interface PaneBoundaryProps {
  /** names the pane in the fallback ("Explorer", "Template dialog", …) */
  name: string;
  /** an overlay's boundary: the fallback floats over the app instead of sitting in the page flow */
  overlay?: boolean;
  children?: React.ReactNode;
}
interface PaneBoundaryState {
  error: Error | null;
}

/**
 * An error boundary around one pane or overlay: a render error shows an EmptyState with the message and a
 * "Reload pane" button (which clears the error and renders the children again) instead of blanking the app.
 */
export class PaneBoundary extends React.Component<PaneBoundaryProps, PaneBoundaryState> {
  state: PaneBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PaneBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`[${this.props.name}] render error`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children ?? null;
    const h = React.createElement;
    return h(
      "div",
      { className: "paneerror emptycenter" + (this.props.overlay ? " overlay" : ""), role: "alert" },
      h(EmptyState, {
        icon: "!",
        title: `${this.props.name} hit an error`,
        body: h("span", { className: "mono" }, error.message || String(error)),
        actions: h("button", { type: "button", className: "btn", onClick: this.reset }, "Reload pane"),
      }),
    );
  }
}
