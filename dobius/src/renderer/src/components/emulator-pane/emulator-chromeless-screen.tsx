import { cn } from '@/lib/utils'

/** Why: the floating phone window draws its own bezel/hardware, so the frame
 *  renders only the interactive screen — aspect-fit, no phone-in-phone chrome. */
export function EmulatorChromelessScreen({
  isLive,
  aspectRatioStyle,
  interactionProps,
  children
}: {
  isLive: boolean
  aspectRatioStyle: string
  interactionProps: React.ComponentProps<'div'>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden">
      <div
        className={cn(
          'relative w-full overflow-hidden bg-black',
          isLive && 'touch-none select-none'
        )}
        style={{ aspectRatio: aspectRatioStyle, maxHeight: '100%' }}
        {...interactionProps}
      >
        {children}
      </div>
    </div>
  )
}
