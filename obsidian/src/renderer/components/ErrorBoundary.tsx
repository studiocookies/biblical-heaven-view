import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { Icon } from './Icon';

/**
 * Contains a render fault to one region of the cockpit. Running sessions live in the main
 * process, so reloading the interface never ends them.
 */
export class ErrorBoundary extends Component<{ region: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    useStore.getState().addLog('error', 'ui', `${this.props.region}: ${error.message} ${info.componentStack?.split('\n')[1]?.trim() ?? ''}`);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fault" role="alert">
        <Icon name="warning" size={18} />
        <div className="fault-title">{this.props.region} hit a display fault</div>
        <div className="fault-msg mono">{this.state.error.message}</div>
        <div className="fault-actions">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload interface
          </button>
        </div>
        <div className="fault-note">Running sessions are unaffected.</div>
      </div>
    );
  }
}
