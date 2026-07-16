import './assets/main.css'

import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import App from './App'
import { SplashScreen } from './components/splash/SplashScreen'
import { FloatingPhoneRoot } from './components/floating-phone/FloatingPhoneRoot'
import { TornOffTerminalRoot } from './components/terminal-pane/TornOffTerminalRoot'
import { RecoverableRenderErrorBoundary } from './components/error-boundaries/RecoverableRenderErrorBoundary'
import {
  installRendererCrashDiagnostics,
  recordRendererCrashBreadcrumb
} from './lib/crash-diagnostics'
import { applyDocumentTheme } from './lib/document-theme'
import { shouldEnableReactGrab } from './lib/react-grab-dev-gate'
import { I18nProvider } from './i18n/I18nProvider'
import { translate } from './i18n/i18n'
import { parseTornOffTerminalHash } from './torn-off-terminal-entry'
import { parseFloatingPhoneHash } from './floating-phone-entry'

recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: import.meta.env.DEV })
installRendererCrashDiagnostics()

if (
  import.meta.env.DEV &&
  shouldEnableReactGrab({
    dev: import.meta.env.DEV,
    enableFlag: import.meta.env.VITE_ENABLE_REACT_GRAB
  })
) {
  void import('react-grab').then(({ init }) => init())
  void import('react-grab/styles.css')
}

applyDocumentTheme('system', { disableTransitions: false })

const rootElement = document.getElementById('root')
if (!rootElement) {
  recordRendererCrashBreadcrumb('renderer_root_missing')
  throw new Error('Renderer root element not found.')
}

const tornOffTerminal = parseTornOffTerminalHash(window.location.hash)
const floatingPhone = tornOffTerminal ? null : parseFloatingPhoneHash(window.location.hash)

function RendererRoot(): React.JSX.Element {
  useTranslation()
  if (tornOffTerminal) {
    return (
      <RecoverableRenderErrorBoundary
        boundaryId="terminal.torn-off-root"
        surface="app-root"
        title={translate('app.recoverableError.terminalTitle', 'Dobius+ hit a terminal error.')}
        description={translate(
          'app.recoverableError.terminalDescription',
          'The terminal window could not finish rendering. Close it and reopen the terminal if the error persists.'
        )}
      >
        <TornOffTerminalRoot {...tornOffTerminal} />
      </RecoverableRenderErrorBoundary>
    )
  }
  if (floatingPhone) {
    return (
      <RecoverableRenderErrorBoundary
        boundaryId="phone.floating-root"
        surface="app-root"
        title={translate('app.recoverableError.phoneTitle', 'Dobius+ hit a phone preview error.')}
        description={translate(
          'app.recoverableError.phoneDescription',
          'The floating phone could not finish rendering. Close it and reopen the phone preview if the error persists.'
        )}
      >
        <FloatingPhoneRoot {...floatingPhone} />
      </RecoverableRenderErrorBoundary>
    )
  }
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="app.root"
      surface="app-root"
      title={translate('app.recoverableError.rootTitle', 'Dobius+ hit a renderer error.')}
      description={translate(
        'app.recoverableError.rootDescription',
        'The app shell could not finish rendering. Retry to remount it, or relaunch Dobius+ if the error persists.'
      )}
    >
      <AppWithSplash />
    </RecoverableRenderErrorBoundary>
  )
}

// Why: App mounts immediately and initialises underneath; the splash is only a
// branded cover over the first paint that fades itself out (Hermes-style),
// never gating boot. Torn-off terminal windows skip it (handled above).
function AppWithSplash(): React.JSX.Element {
  const [showSplash, setShowSplash] = useState(true)
  return (
    <>
      <App />
      {showSplash ? <SplashScreen onDone={() => setShowSplash(false)} /> : null}
    </>
  )
}

createRoot(rootElement).render(
  <StrictMode>
    <I18nProvider>
      <RendererRoot />
    </I18nProvider>
  </StrictMode>
)
recordRendererCrashBreadcrumb('renderer_bootstrap_rendered')
