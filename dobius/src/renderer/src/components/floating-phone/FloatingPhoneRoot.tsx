import { useCallback, useEffect, useRef, useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { LinkRoutingPreferenceDialogProvider } from '@/components/link-routing-preference-dialog'
import { normalizeFloatingPhoneUrlInput, type FloatingPhoneEntry } from '@/floating-phone-entry'
import type { FloatingPhoneMode } from '../../../../shared/floating-phone'
import { FloatingPhoneAppMode, type FloatingPhoneAppControls } from './FloatingPhoneAppMode'
import { FloatingPhoneHardwareControls } from './FloatingPhoneHardwareControls'
import { FloatingPhoneToolbar } from './FloatingPhoneToolbar'
import { DEFAULT_FLOATING_PHONE_URL, FloatingPhoneWebMode } from './FloatingPhoneWebMode'
import './floating-phone.css'

const FLOATING_PHONE_BOUNDS_KEY = 'floating-phone-bounds'

type StoredFloatingPhoneBounds = {
  x: number
  y: number
  width: number
  height: number
}

function readStoredBounds(): StoredFloatingPhoneBounds | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(FLOATING_PHONE_BOUNDS_KEY) ?? 'null') as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      ['x', 'y', 'width', 'height'].every((key) =>
        Number.isFinite((parsed as Record<string, unknown>)[key])
      )
    ) {
      return parsed as StoredFloatingPhoneBounds
    }
  } catch {}
  return null
}

function writeStoredBounds(): void {
  const bounds = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  }
  localStorage.setItem(FLOATING_PHONE_BOUNDS_KEY, JSON.stringify(bounds))
}

export function FloatingPhoneRoot({
  mode: initialMode,
  worktreeId: initialWorktreeId,
  url: initialUrl
}: FloatingPhoneEntry): React.JSX.Element {
  const [mode, setMode] = useState<FloatingPhoneMode>(initialMode)
  const [worktreeId, setWorktreeId] = useState<string | null>(initialWorktreeId)
  const [currentUrl, setCurrentUrl] = useState(initialUrl || DEFAULT_FLOATING_PHONE_URL)
  const [urlInput, setUrlInput] = useState(initialUrl || DEFAULT_FLOATING_PHONE_URL)
  const [canGoBack, setCanGoBack] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [appControls, setAppControls] = useState<FloatingPhoneAppControls | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('floating-phone-document')
    document.title = 'Phone'
    return () => document.documentElement.classList.remove('floating-phone-document')
  }, [])

  useEffect(() => {
    const bounds = readStoredBounds()
    if (bounds) {
      void window.api.window.setPhoneVisualBounds(bounds)
    }
    let timer: number | null = null
    const persistBounds = (): void => {
      if (timer) {
        window.clearTimeout(timer)
      }
      timer = window.setTimeout(writeStoredBounds, 150)
    }
    window.addEventListener('resize', persistBounds)
    window.addEventListener('beforeunload', writeStoredBounds)
    return () => {
      if (timer) {
        window.clearTimeout(timer)
      }
      window.removeEventListener('resize', persistBounds)
      window.removeEventListener('beforeunload', writeStoredBounds)
    }
  }, [])

  useEffect(
    () =>
      window.api.window.onPhoneVisualUpdate((update) => {
        setMode(update.mode)
        setWorktreeId(update.worktreeId)
        if (update.url) {
          setCurrentUrl(update.url)
          setUrlInput(update.url)
        }
      }),
    []
  )

  const navigateFromInput = useCallback(() => {
    const normalized = normalizeFloatingPhoneUrlInput(urlInput)
    if (!normalized) {
      setLoadError('Enter an http or https URL.')
      return
    }
    setLoadError(null)
    setCurrentUrl(normalized)
    setUrlInput(normalized)
  }, [urlInput])

  const closePhone = useCallback(() => {
    void window.api.window.closePhoneVisual()
  }, [])

  const minimizePhone = useCallback(() => {
    void window.api.window.minimizePhoneVisual()
  }, [])

  const toggleMaximizePhone = useCallback(() => {
    void window.api.window.toggleMaximizePhoneVisual()
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <ConfirmationDialogProvider>
        <LinkRoutingPreferenceDialogProvider>
          <div className="floating-phone-root fixed inset-0 overflow-hidden p-2 text-foreground">
            <div className="floating-phone-bezel relative flex h-full min-h-0 flex-col p-3">
              <FloatingPhoneToolbar
                mode={mode}
                urlInput={urlInput}
                canGoBack={canGoBack}
                onModeChange={setMode}
                onUrlInputChange={setUrlInput}
                onSubmitUrl={navigateFromInput}
                onBack={() => webviewRef.current?.goBack()}
                onReload={() => webviewRef.current?.reload()}
                onClose={closePhone}
                onMinimize={minimizePhone}
                onMaximize={toggleMaximizePhone}
              />
              <div className="floating-phone-screen floating-phone-no-drag relative min-h-0 flex-1">
                {mode === 'web' ? (
                  <FloatingPhoneWebMode
                    currentUrl={currentUrl}
                    webviewRef={webviewRef}
                    onCanGoBackChange={setCanGoBack}
                    onErrorChange={setLoadError}
                    onUrlChange={(nextUrl) => {
                      setCurrentUrl(nextUrl)
                      setUrlInput(nextUrl)
                    }}
                  />
                ) : (
                  <FloatingPhoneAppMode worktreeId={worktreeId} onControlsChange={setAppControls} />
                )}
                {loadError ? (
                  <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-xs">
                    {loadError}
                  </div>
                ) : null}
              </div>
              <FloatingPhoneHardwareControls
                appControlsEnabled={mode === 'app' && !!appControls?.isLive}
                onHome={() => appControls?.sendHome()}
                onPower={closePhone}
              />
            </div>
          </div>
        </LinkRoutingPreferenceDialogProvider>
      </ConfirmationDialogProvider>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </TooltipProvider>
  )
}
