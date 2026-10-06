import { Component, type ErrorInfo, type ReactNode } from 'react'
import { recordRendererError } from '@/lib/platform'

export interface ErrorBoundaryProps {
  /** Rendered instead of the children after a render error. */
  fallback: (error: Error, reset: () => void) => ReactNode
  /** Reset the boundary when any of these change (e.g. the tab id). */
  resetKeys?: unknown[]
  /** Name recorded with the error in window.__datagrippeErrors. */
  name?: string
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors of a subtree (per view, and once at the root). */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    recordRendererError(error, this.props.name ?? 'render')
    console.error(error, info.componentStack)
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (!this.state.error) return
    const a = prev.resetKeys ?? []
    const b = this.props.resetKeys ?? []
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) this.reset()
  }

  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset)
    return this.props.children
  }
}
