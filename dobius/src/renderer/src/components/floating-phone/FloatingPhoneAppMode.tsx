import { useEffect } from 'react'
import { EmulatorDeviceFrame } from '@/components/emulator-pane/emulator-device-frame'
import { useEmulatorPaneSession } from '@/components/emulator-pane/use-emulator-pane-session'

const FLOATING_PHONE_EMULATOR_TAB_ID = 'floating-phone-emulator'

export type FloatingPhoneAppControls = {
  isLive: boolean
  sendHome: () => void
}

type FloatingPhoneAppModeProps = {
  worktreeId: string | null
  onControlsChange: (controls: FloatingPhoneAppControls | null) => void
}

function FloatingPhoneAppFrame({
  worktreeId,
  onControlsChange
}: {
  worktreeId: string
  onControlsChange: (controls: FloatingPhoneAppControls | null) => void
}): React.JSX.Element {
  const {
    loading,
    error,
    sendTap,
    sendButton,
    sendGesture,
    displayName,
    previewUrl,
    wsUrl,
    streamKey,
    isLive
  } = useEmulatorPaneSession({
    worktreeId,
    tabId: FLOATING_PHONE_EMULATOR_TAB_ID,
    autoAttachOnMount: true
  })

  useEffect(() => {
    onControlsChange({
      isLive,
      sendHome: () => {
        void sendButton('home')
      }
    })
    return () => onControlsChange(null)
  }, [isLive, onControlsChange, sendButton])

  return (
    // Why: the floating window IS the phone — dark screen glass, and the frame
    // renders chromeless so there is no phone-in-phone bezel.
    <div className="floating-phone-no-drag relative h-full min-h-0 bg-black">
      {error ? (
        <div className="absolute inset-x-3 top-3 z-10 rounded-md border border-white/15 bg-black/80 px-3 py-2 text-xs text-white/80 shadow-xs">
          {error}
        </div>
      ) : null}
      {!isLive && !loading && !error ? (
        <div className="absolute inset-x-4 top-1/2 z-10 -translate-y-1/2 text-center text-xs text-white/50">
          No emulator connected
        </div>
      ) : null}
      <EmulatorDeviceFrame
        previewUrl={previewUrl}
        wsUrl={wsUrl}
        streamKey={streamKey}
        deviceName={displayName}
        loading={loading}
        isLive={isLive}
        isActive
        chromeless
        onTap={(x, y) => void sendTap(x, y)}
        onGesture={(points) => void sendGesture(points)}
      />
    </div>
  )
}

export function FloatingPhoneAppMode({
  worktreeId,
  onControlsChange
}: FloatingPhoneAppModeProps): React.JSX.Element {
  useEffect(() => {
    if (!worktreeId) {
      onControlsChange(null)
    }
  }, [onControlsChange, worktreeId])

  if (!worktreeId) {
    return (
      <div className="floating-phone-no-drag flex h-full items-center justify-center bg-black px-8 text-center text-xs text-white/50">
        Open from a project to attach the emulator
      </div>
    )
  }

  return <FloatingPhoneAppFrame worktreeId={worktreeId} onControlsChange={onControlsChange} />
}
