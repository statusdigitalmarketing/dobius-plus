import { test, expect } from './helpers/dobius-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

test.describe('usage overview', () => {
  test.beforeEach(async ({ dobiusPage }) => {
    await waitForSessionReady(dobiusPage)
  })

  test('Stats & Usage opens on the combined overview with provider controls', async ({
    dobiusPage
  }) => {
    await dobiusPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsPage()
    })

    await expect
      .poll(async () => getStoreState<string>(dobiusPage, 'activeView'), { timeout: 5_000 })
      .toBe('settings')
    await dobiusPage.getByRole('button', { name: 'Stats & Usage' }).click()
    await expect(dobiusPage.getByRole('heading', { name: 'Usage Analytics' })).toBeVisible()
    const providerDropdown = dobiusPage.getByTestId('usage-provider-select')
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: Overview'
    )
    await expect(dobiusPage.getByTestId('usage-overview-pane')).toBeVisible()
    await expect(dobiusPage.getByRole('heading', { name: 'Usage Overview' })).toBeVisible()
    await expect(dobiusPage.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await expect(dobiusPage.getByRole('button', { name: 'Enable Claude' })).toBeVisible()
    await expect(dobiusPage.getByRole('button', { name: 'Enable Codex' })).toBeVisible()
    await expect(dobiusPage.getByRole('button', { name: 'Enable OpenCode' })).toBeVisible()

    await providerDropdown.click()
    await dobiusPage.getByRole('menuitem', { name: 'Codex', exact: true }).click()
    await expect(dobiusPage.getByRole('heading', { name: 'Codex Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute('aria-label', 'Usage analytics provider: Codex')

    await providerDropdown.click()
    await dobiusPage.getByRole('menuitem', { name: 'OpenCode', exact: true }).click()
    await expect(dobiusPage.getByRole('heading', { name: 'OpenCode Usage Tracking' })).toBeVisible()
    await expect(providerDropdown).toHaveAttribute(
      'aria-label',
      'Usage analytics provider: OpenCode'
    )
  })
})
