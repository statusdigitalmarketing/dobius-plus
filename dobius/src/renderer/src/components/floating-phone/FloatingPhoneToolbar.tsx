import { ArrowLeft, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { FloatingPhoneMode } from '../../../../shared/floating-phone'

type FloatingPhoneToolbarProps = {
  canGoBack: boolean
  mode: FloatingPhoneMode
  urlInput: string
  onBack: () => void
  onClose: () => void
  onMaximize: () => void
  onMinimize: () => void
  onModeChange: (mode: FloatingPhoneMode) => void
  onReload: () => void
  onSubmitUrl: () => void
  onUrlInputChange: (value: string) => void
}

export function FloatingPhoneToolbar({
  canGoBack,
  mode,
  urlInput,
  onBack,
  onClose,
  onMaximize,
  onMinimize,
  onModeChange,
  onReload,
  onSubmitUrl,
  onUrlInputChange
}: FloatingPhoneToolbarProps): React.JSX.Element {
  return (
    <div className="floating-phone-no-drag flex h-10 shrink-0 items-center gap-1.5 px-3 py-1.5">
      <div className="floating-phone-traffic flex items-center gap-2 pr-1">
        <button
          type="button"
          className="floating-phone-traffic-dot floating-phone-traffic-close"
          onClick={onClose}
          aria-label="Close phone"
        />
        <button
          type="button"
          className="floating-phone-traffic-dot floating-phone-traffic-minimize"
          onClick={onMinimize}
          aria-label="Minimize phone"
        />
        <button
          type="button"
          className="floating-phone-traffic-dot floating-phone-traffic-zoom"
          onClick={onMaximize}
          aria-label="Zoom phone"
        />
      </div>
      <div className="flex overflow-hidden rounded-md border border-border bg-muted p-0.5">
        {(['web', 'app'] as const).map((item) => (
          <Button
            key={item}
            type="button"
            variant={mode === item ? 'secondary' : 'ghost'}
            size="xs"
            className="h-6 px-2 text-[11px] capitalize"
            onClick={() => onModeChange(item)}
          >
            {item}
          </Button>
        ))}
      </div>
      {mode === 'web' ? (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onBack}
            disabled={!canGoBack}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onReload}>
            <RefreshCw className="size-3.5" />
          </Button>
          <Input
            className="h-7 min-w-0 flex-1 bg-input px-2 text-xs"
            value={urlInput}
            onChange={(event) => onUrlInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onSubmitUrl()
              }
            }}
            aria-label="URL"
          />
        </>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      <Button type="button" variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
        <X className="size-3.5" />
      </Button>
    </div>
  )
}
