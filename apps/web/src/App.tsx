import { Component, type ReactNode } from 'react'
import MapView from './components/MapView'
import LoginPanel from './components/LoginPanel'
import UpdatePrompt from './components/UpdatePrompt'
import TileUpdatePrompt from './components/TileUpdatePrompt'
import { useAuth } from './hooks/useAuth'
import { useSync } from './hooks/useSync'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', background: '#1a1a2e', color: '#f87171', minHeight: '100vh' }}>
          <h2 style={{ color: '#fca5a5' }}>Runtime error</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{this.state.error.stack ?? this.state.error.message}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

function AppInner() {
  const auth = useAuth()
  useSync(auth)

  // While the session check is in flight show nothing (avoids LoginPanel flash).
  if (auth.loading) return null

  return (
    <>
      {(!auth.user || !auth.user.name) && <LoginPanel auth={auth} />}
      <MapView auth={auth} />
      <UpdatePrompt />
      <TileUpdatePrompt />
    </>
  )
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>
}

