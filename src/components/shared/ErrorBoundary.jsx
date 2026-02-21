import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className="h-full flex flex-col items-center justify-center p-8"
          style={{ backgroundColor: 'var(--bg)', color: 'var(--fg)' }}
        >
          <h2 className="text-lg font-semibold mb-2" style={{ color: 'var(--accent)' }}>
            Something went wrong
          </h2>
          <p className="text-sm mb-4" style={{ color: 'var(--dim)' }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 text-sm rounded"
            style={{ backgroundColor: 'var(--accent)', color: 'var(--bg)' }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
