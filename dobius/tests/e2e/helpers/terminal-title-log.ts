import type { Page } from '@playwright/test'

export async function installRendererTitleLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __dobiusE2eTitleLog?: string[]
      __dobiusE2eTitleUnsubscribe?: () => void
    }
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    w.__dobiusE2eTitleUnsubscribe?.()
    w.__dobiusE2eTitleLog = []

    const recordTitles = (): void => {
      const state = store.getState()
      const paneTitles = Object.values(state.runtimePaneTitlesByTabId ?? {}).flatMap((byPane) =>
        Object.values(byPane ?? {})
      )
      const tabTitles = Object.values(state.tabsByWorktree ?? {})
        .flat()
        .map((tab) => tab.title)

      for (const title of [...paneTitles, ...tabTitles]) {
        if (typeof title === 'string') {
          w.__dobiusE2eTitleLog!.push(title)
        }
      }
    }

    // Why: shell prompts can immediately overwrite OSC titles. Logging every
    // renderer title state lets tests assert transient title frames landed.
    recordTitles()
    w.__dobiusE2eTitleUnsubscribe = store.subscribe(recordTitles)
  })
}

export async function getRendererTitleLog(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __dobiusE2eTitleLog?: string[] }
    return w.__dobiusE2eTitleLog ?? []
  })
}
