import { Component, useEffect, type ReactNode } from 'react'
import MapView from './components/MapView'
import LoginPanel from './components/LoginPanel'
import AssistantConsent from './components/AssistantConsent'
import AssistantContinue from './components/AssistantContinue'
import PasskeyPrompt from './components/PasskeyPrompt'
import UpdatePrompt from './components/UpdatePrompt'
import TileUpdatePrompt from './components/TileUpdatePrompt'
import SystemMessages from './components/SystemMessages'
import { setAdminSession } from './utils/adminAccess'
import { useAuth } from './hooks/useAuth'
import { useSync } from './hooks/useSync'
import { repairAppFiles } from './utils/repairApp'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      // Recovery options first, stack second: a pilot at the aircraft needs
      // a way out, not a stack trace. "Repair" clears cached app files (a
      // common cause after an interrupted update) but keeps local data.
      const btn = { padding: '8px 14px', marginRight: 8, fontSize: 14, cursor: 'pointer' }
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', background: '#1a1a2e', color: '#e5e7eb', minHeight: '100vh' }}>
          <h2 style={{ color: '#fca5a5', marginTop: 0 }}>OpenVFR hit an error</h2>
          <p>Try reloading. If it keeps happening, repair the app files — this re-downloads the app and map data but keeps your routes, aircraft and settings.</p>
          <div style={{ margin: '16px 0' }}>
            <button style={btn} onClick={() => window.location.reload()}>Reload</button>
            <button style={btn} onClick={() => { void repairAppFiles() }}>Repair app files &amp; reload</button>
          </div>
          <details>
            <summary style={{ cursor: 'pointer', color: '#9ca3af' }}>Technical details</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace', color: '#f87171' }}>{this.state.error.stack ?? this.state.error.message}</pre>
          </details>
        </div>
      )
    }
    return this.props.children
  }
}

function AppInner() {
  const auth = useAuth()
  useSync(auth)
  useEffect(() => { setAdminSession(auth.user?.role === 'admin') }, [auth.user?.role])

  // While the session check is in flight show nothing (avoids LoginPanel flash).
  if (auth.loading) return null

  // Assistant connection pages (the api's OAuth provider sends the browser
  // here): sign in if needed, then approve or deny, then back to the assistant.
  const path = window.location.pathname
  if (path === '/oauth/consent' || path === '/oauth/login') {
    if (!auth.user || !auth.user.name) return <LoginPanel auth={auth} />
    return path === '/oauth/consent'
      ? <AssistantConsent userEmail={auth.user.email} />
      : <AssistantContinue />
  }

  return (
    <>
      {(!auth.user || !auth.user.name) && <LoginPanel auth={auth} />}
      <MapView auth={auth} />
      {!!auth.user?.name && <PasskeyPrompt auth={auth} />}
      <UpdatePrompt />
      <TileUpdatePrompt />
    </>
  )
}

export default function App() {
  // Notices render outside AppInner so they also show while the session
  // check is pending (e.g. when the api is down) and on the sign-in panel.
  return <ErrorBoundary><AppInner /><SystemMessages /></ErrorBoundary>
}

