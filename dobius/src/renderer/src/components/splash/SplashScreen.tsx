import { useEffect, useState } from 'react'
import { MeshGradient } from '@paper-design/shaders-react'
import { translate } from '@/i18n/i18n'
import './splash.css'

// Why: mirror Hermes One's splash timing — hold the branded screen for a
// minimum so it never flashes, then fade out. The app mounts underneath the
// whole time, so this does not delay boot; it only covers the initial paint.
const SPLASH_MIN_MS = 2600
const SPLASH_FADE_MS = 600
const STATUS_STEP_MS = 900

// User-specified brand shader palette (dark → white mesh). Fixed brand colors
// for the boot splash, not themeable UI, so kept as a named constant.
const SPLASH_COLORS = ['#000000', '#1a1a1a', '#333333', '#ffffff']

export function SplashScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [status, setStatus] = useState(() => translate('app.splash.starting', 'Starting Dobius+…'))
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const toWorkspaces = setTimeout(() => {
      setStatus(translate('app.splash.loadingWorkspaces', 'Loading your workspaces…'))
    }, STATUS_STEP_MS)
    const toLeave = setTimeout(() => setLeaving(true), SPLASH_MIN_MS)
    return () => {
      clearTimeout(toWorkspaces)
      clearTimeout(toLeave)
    }
  }, [])

  useEffect(() => {
    if (!leaving) {
      return
    }
    const done = setTimeout(onDone, SPLASH_FADE_MS)
    return () => clearTimeout(done)
  }, [leaving, onDone])

  return (
    <div className={leaving ? 'dobius-splash is-leaving' : 'dobius-splash'}>
      <MeshGradient className="dobius-splash-bg" colors={SPLASH_COLORS} speed={1} />
      <div className="dobius-splash-scrim" aria-hidden="true" />
      <div className="dobius-splash-wordmark" aria-label="Dobius+">
        Dobius<span className="dobius-splash-plus">+</span>
      </div>
      <div className="dobius-splash-status">{status}</div>
    </div>
  )
}
