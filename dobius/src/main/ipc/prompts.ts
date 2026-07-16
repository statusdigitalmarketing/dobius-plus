import { ipcMain } from 'electron'
import { deletePrompt, listPrompts, savePrompt } from '../prompts/prompts-store'

// Structural slice of DobiusRuntimeService needed to inject a snippet into the
// active terminal (no auto-submit — the user reviews before sending).
export type PromptsInjectDispatcher = {
  resolveActiveTerminal: () => Promise<string>
  sendTerminal: (handle: string, action: { text?: string; enter?: boolean }) => Promise<unknown>
}

export function registerPromptsHandlers(runtime: PromptsInjectDispatcher): void {
  ipcMain.removeHandler('prompts:list')
  ipcMain.handle('prompts:list', () => listPrompts())

  ipcMain.removeHandler('prompts:save')
  ipcMain.handle('prompts:save', (_event, input: { id?: string; title: string; text: string }) =>
    savePrompt(input)
  )

  ipcMain.removeHandler('prompts:delete')
  ipcMain.handle('prompts:delete', (_event, id: string) => deletePrompt(id))

  ipcMain.removeHandler('prompts:inject')
  ipcMain.handle('prompts:inject', async (_event, text: string) => {
    if (typeof text !== 'string' || !text) {
      return { ok: false }
    }
    const handle = await runtime.resolveActiveTerminal()
    // enter:false — leave the snippet unsent so the user can edit first.
    await runtime.sendTerminal(handle, { text, enter: false })
    return { ok: true }
  })
}
