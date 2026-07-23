import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  /** Change this (e.g. the route path) to auto-reset the boundary on navigation. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

/**
 * Catches render/runtime errors in a page so a single screen's failure shows a
 * recoverable panel instead of blanking the whole app. Resets when resetKey changes.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface for debugging; the panel below is what the user sees.
    console.error("Page error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="grid min-h-[60vh] place-items-center px-6">
        <div className="card max-w-md p-8 text-center">
          <div className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-full bg-accent-50 text-accent">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <h2 className="text-[15px] font-semibold text-ink">This screen hit an error</h2>
          <p className="mt-1 text-[13px] text-muted">
            Something on this page failed to render. You can retry, or go back to the dashboard.
          </p>
          <p className="mt-3 truncate rounded-md bg-surface px-3 py-2 text-[12px] text-faint" title={error.message}>
            {error.message}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <button className="btn btn-sm rounded-md" onClick={() => this.setState({ error: null })}>
              Retry
            </button>
            <button className="btn-primary btn-sm rounded-md" onClick={() => (window.location.href = "/overview")}>
              Back to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
