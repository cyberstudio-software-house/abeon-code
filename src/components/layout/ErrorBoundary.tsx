import { Component, type ReactNode } from 'react';
type State = { err?: Error };
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="p-6 text-danger">
          <h2 className="font-semibold">Coś poszło nie tak</h2>
          <pre className="text-xs mt-2 whitespace-pre-wrap">{this.state.err.stack ?? this.state.err.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
