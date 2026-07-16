import { Home, Power } from 'lucide-react'
import { Button } from '@/components/ui/button'

type FloatingPhoneHardwareControlsProps = {
  appControlsEnabled: boolean
  onHome: () => void
  onPower: () => void
}

export function FloatingPhoneHardwareControls({
  appControlsEnabled,
  onHome,
  onPower
}: FloatingPhoneHardwareControlsProps): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="floating-phone-side-button left-0 top-[18%] h-7 rounded-l-sm"
        aria-label="Action button"
        tabIndex={-1}
      />
      <button
        type="button"
        className="floating-phone-side-button left-0 top-[27%] h-12 rounded-l-sm"
        aria-label="Volume up"
        tabIndex={-1}
      />
      <button
        type="button"
        className="floating-phone-side-button left-0 top-[37%] h-12 rounded-l-sm"
        aria-label="Volume down"
        tabIndex={-1}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="floating-phone-no-drag floating-phone-side-button -right-px top-[27%] h-16 rounded-r-sm p-0"
        onClick={onPower}
        aria-label="Power"
      >
        <Power className="size-3" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="floating-phone-no-drag absolute bottom-4 left-1/2 size-8 -translate-x-1/2 rounded-full border border-border bg-muted/70"
        onClick={onHome}
        disabled={!appControlsEnabled}
        aria-label="Home"
      >
        <Home className="size-4" />
      </Button>
    </>
  )
}
