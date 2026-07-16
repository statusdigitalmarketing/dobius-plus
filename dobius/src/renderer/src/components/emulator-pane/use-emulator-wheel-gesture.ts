import { useCallback, useEffect, useRef, type WheelEvent } from 'react'
import type { StreamSize } from './emulator-device-frame-layout'
import {
  buildWheelGesturePoints,
  clampEmulatorScreenPoint,
  resolveEmulatorWheelDelta,
  type EmulatorGesturePoint,
  type EmulatorScreenPoint
} from './emulator-screen-gesture'

const WHEEL_GESTURE_IDLE_MS = 80

type PendingWheelGesture = {
  end: EmulatorScreenPoint
  live: boolean
  start: EmulatorScreenPoint
  timerId: number | null
}

/** Why: trackpad scrolls arrive as wheel deltas; batch them into one live drag
 *  (or a synthesized gesture) so iOS scroll physics behave like a real swipe. */
export function useEmulatorWheelGesture({
  canInteract,
  streamSize,
  sendTouch,
  sendGesturePoints
}: {
  canInteract: boolean
  streamSize: StreamSize | null
  sendTouch: (point: EmulatorGesturePoint) => boolean
  sendGesturePoints: (points: EmulatorGesturePoint[]) => void
}): { handleWheel: (event: WheelEvent<HTMLDivElement>) => void } {
  const wheelGestureRef = useRef<PendingWheelGesture | null>(null)

  const flushWheelGesture = useCallback(() => {
    const pending = wheelGestureRef.current
    wheelGestureRef.current = null
    if (!pending) {
      return
    }
    if (pending.timerId !== null) {
      window.clearTimeout(pending.timerId)
    }
    if (pending.live) {
      const end = clampEmulatorScreenPoint(pending.end)
      void sendTouch({ ...end, type: 'end' })
      return
    }
    const points = buildWheelGesturePoints(pending.start, pending.end)
    if (points) {
      sendGesturePoints(points)
    }
  }, [sendGesturePoints, sendTouch])

  useEffect(
    () => () => {
      const pending = wheelGestureRef.current
      wheelGestureRef.current = null
      if (pending?.timerId != null) {
        window.clearTimeout(pending.timerId)
      }
      if (pending?.live) {
        const end = clampEmulatorScreenPoint(pending.end)
        void sendTouch({ ...end, type: 'end' })
      }
    },
    [sendTouch]
  )

  const handleWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!canInteract) {
        return
      }
      const delta = resolveEmulatorWheelDelta(
        {
          clientX: event.clientX,
          clientY: event.clientY,
          deltaMode: event.deltaMode,
          deltaX: event.deltaX,
          deltaY: event.deltaY
        },
        event.currentTarget.getBoundingClientRect(),
        streamSize
      )
      if (!delta) {
        return
      }
      event.preventDefault()
      const previous = wheelGestureRef.current
      if (previous?.timerId != null) {
        window.clearTimeout(previous.timerId)
      }
      const start = previous?.start ?? delta.start
      const end = clampEmulatorScreenPoint(
        previous
          ? { x: previous.end.x + delta.delta.x, y: previous.end.y + delta.delta.y }
          : { x: delta.start.x + delta.delta.x, y: delta.start.y + delta.delta.y }
      )
      const live = previous?.live ?? sendTouch({ ...start, type: 'begin' })
      if (live) {
        void sendTouch({ ...end, type: 'move' })
      }
      wheelGestureRef.current = {
        start,
        end,
        live,
        timerId: window.setTimeout(flushWheelGesture, WHEEL_GESTURE_IDLE_MS)
      }
    },
    [canInteract, flushWheelGesture, sendTouch, streamSize]
  )

  return { handleWheel }
}
