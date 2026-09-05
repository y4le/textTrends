import { Component, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
  readonly resetKey?: string;
  readonly onReturn?: () => void;
}

/** Suspense handles pending modules; this boundary handles failed modules/renders. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  override componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section role="alert" aria-label="View unavailable" className="view-load-error">
        <h2>This view could not be opened</h2>
        <p>Your saved texts and workspace remain in this browser.</p>
        <p>Reload to fetch the app again.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload app</button>
        {this.props.onReturn && (
          <button type="button" onClick={this.props.onReturn}>Return to Inputs</button>
        )}
      </section>
    );
  }
}
