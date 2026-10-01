import { Component, createContext, type ContextType, type ReactNode } from 'react';
import { FormLayer } from './FormLayer.tsx';

/** The composition root supplies its durability barrier without coupling
 * generic failure screens to app bootstrap or worker creation. */
export const ReloadAppContext = createContext<() => Promise<void>>(async () => {});

interface Props {
  readonly children: ReactNode;
  readonly resetKey?: string;
  readonly onReturn?: () => void;
  readonly returnLabel?: string;
  readonly region?: string;
  readonly onRetry?: () => void;
  readonly modal?: boolean;
}

/** Suspense handles pending modules; this boundary handles failed modules/renders. */
export class ErrorBoundary extends Component<Props, { failed: boolean; reloading: boolean; reloadError: string | null }> {
  static override contextType = ReloadAppContext;
  declare context: ContextType<typeof ReloadAppContext>;
  override state = { failed: false, reloading: false, reloadError: null as string | null };

  private reload = () => {
    if (this.state.reloadError !== null) { window.location.reload(); return; }
    this.setState({ reloading: true, reloadError: null });
    void Promise.resolve().then(this.context)
      .then(() => window.location.reload())
      .catch((error: unknown) => this.setState({ reloading: false, reloadError: `Could not save before reload: ${error instanceof Error ? error.message : String(error)}. Reloading now may discard unsaved edits.` }));
  };

  static getDerivedStateFromError() { return { failed: true }; }

  override componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    const failure = (
      <section role="alert" aria-label={`${this.props.region ?? 'View'} unavailable`} className="view-load-error">
        <h2>{this.props.region ?? 'This view'} could not be opened</h2>
        <p>Your saved texts and workspace remain in this browser.</p>
        <p>{this.props.onRetry ? 'Retry this view, or reload to fetch the app again.' : 'Reload to fetch the app again.'}</p>
        {this.props.onRetry && <button type="button" onClick={this.props.onRetry}>Retry {this.props.region ?? 'view'}</button>}
        <button type="button" disabled={this.state.reloading} onClick={this.reload}>{this.state.reloadError === null ? 'Reload app' : 'Reload without saving'}</button>
        {this.state.reloadError && <p role="alert">{this.state.reloadError}</p>}
        {this.props.onReturn && (
          <button type="button" onClick={this.props.onReturn}>{this.props.returnLabel ?? 'Return to Inputs'}</button>
        )}
      </section>
    );
    return this.props.modal && this.props.onReturn
      ? <FormLayer label={`${this.props.region ?? 'View'} unavailable`} onClose={this.props.onReturn}>{failure}</FormLayer>
      : failure;
  }
}
