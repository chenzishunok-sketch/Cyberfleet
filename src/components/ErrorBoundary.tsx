import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | undefined;
}

/** 页面级错误边界：任何视图渲染抛错时显示可恢复的错误页，而不是整个应用白屏 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-content error-boundary" role="alert">
        <h1>页面出错了</h1>
        <p>{this.state.error.message || "渲染过程中发生未知错误。"}</p>
        <button type="button" onClick={() => this.setState({ error: undefined })}>重试</button>
        <button type="button" onClick={() => window.location.reload()}>刷新整个应用</button>
      </div>
    );
  }
}
