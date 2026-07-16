import type { Store } from '../persistence'
import type { AutomationRun } from '../../shared/automations-types'
import { getDestination } from '../destinations/destinations-store'
import { deliverToDestination } from '../destinations/destination-delivery'
import { isFailureStatus, renderAutomationNotification } from '../destinations/notification-message'

// Why: called from the run's single finalization pass in AutomationService, so
// it fires once per run. Delivery is fire-and-forget — a broken destination
// must never fail run bookkeeping.
export function deliverAutomationRunNotification(store: Store, run: AutomationRun): void {
  const automation = store.listAutomations().find((entry) => entry.id === run.automationId)
  const notification = automation?.notification
  if (!automation || !notification) {
    return
  }
  if (notification.notifyOn === 'failure' && !isFailureStatus(run.status)) {
    return
  }
  const destination = getDestination(notification.destinationId)
  if (!destination) {
    console.warn(`[automations] notification destination missing for "${automation.name}"`)
    return
  }
  const message = renderAutomationNotification(automation.name, run, notification.depth)
  void deliverToDestination(destination, message).catch((error) => {
    console.warn(
      '[automations] notification delivery failed:',
      error instanceof Error ? error.message : String(error)
    )
  })
}
