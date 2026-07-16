import { useEffect, useRef } from 'react'
import { DOBIUS_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { DOBIUS_BROWSER_PARTITION } from '../../../../shared/constants'

export const DEFAULT_FLOATING_PHONE_URL = 'http://localhost:3000'

const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'

type FloatingPhoneWebModeProps = {
  currentUrl: string
  webviewRef: React.RefObject<Electron.WebviewTag | null>
  onCanGoBackChange: (canGoBack: boolean) => void
  onErrorChange: (message: string | null) => void
  onUrlChange: (url: string) => void
}

export function FloatingPhoneWebMode({
  currentUrl,
  webviewRef,
  onCanGoBackChange,
  onErrorChange,
  onUrlChange
}: FloatingPhoneWebModeProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.className = 'floating-phone-webview'
    webview.setAttribute('partition', DOBIUS_BROWSER_PARTITION)
    webview.setAttribute('allowpopups', '')
    webview.setAttribute('webpreferences', DOBIUS_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
    webview.setAttribute('useragent', IPHONE_SAFARI_USER_AGENT)
    container.appendChild(webview)
    webviewRef.current = webview

    const updateUrl = (): void => {
      onErrorChange(null)
      const nextUrl = webview.getURL()
      if (nextUrl) {
        onUrlChange(nextUrl)
      }
      try {
        onCanGoBackChange(webview.canGoBack())
      } catch {
        onCanGoBackChange(false)
      }
    }
    const handleLoadError = (event: Event): void => {
      const detail = event as Event & { errorDescription?: string; validatedURL?: string }
      onErrorChange(detail.errorDescription || `Could not load ${detail.validatedURL || 'page'}.`)
    }

    webview.addEventListener('did-navigate', updateUrl)
    webview.addEventListener('did-navigate-in-page', updateUrl)
    webview.addEventListener('did-finish-load', updateUrl)
    webview.addEventListener('did-fail-load', handleLoadError)

    return () => {
      webview.removeEventListener('did-navigate', updateUrl)
      webview.removeEventListener('did-navigate-in-page', updateUrl)
      webview.removeEventListener('did-finish-load', updateUrl)
      webview.removeEventListener('did-fail-load', handleLoadError)
      webviewRef.current = null
      webview.remove()
    }
  }, [onCanGoBackChange, onErrorChange, onUrlChange, webviewRef])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview || webview.getAttribute('src') === currentUrl) {
      return
    }
    webview.setAttribute('src', currentUrl)
  }, [currentUrl, webviewRef])

  return <div ref={containerRef} className="floating-phone-no-drag h-full w-full" />
}
