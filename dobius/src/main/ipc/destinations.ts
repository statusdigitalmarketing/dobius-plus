import { ipcMain } from 'electron'
import type {
  Destination,
  DestinationSaveInput,
  DestinationTestResult
} from '../../shared/destinations'
import {
  deleteDestination,
  getDestination,
  listDestinations,
  saveDestination
} from '../destinations/destinations-store'
import { deliverToDestination } from '../destinations/destination-delivery'

export function registerDestinationHandlers(): void {
  ipcMain.handle('destinations:list', (): Destination[] => listDestinations())
  ipcMain.handle(
    'destinations:save',
    (_event, input: DestinationSaveInput): Destination => saveDestination(input)
  )
  ipcMain.handle('destinations:delete', (_event, id: string): boolean => deleteDestination(id))
  ipcMain.handle(
    'destinations:test',
    async (_event, id: string): Promise<DestinationTestResult> => {
      const destination = getDestination(id)
      if (!destination) {
        return { ok: false, error: 'Destination not found' }
      }
      try {
        await deliverToDestination(destination, {
          title: `Dobius+ test — ${destination.name}`,
          body: 'This destination is wired up. Automation results will arrive here.'
        })
        return { ok: true, error: null }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )
}
