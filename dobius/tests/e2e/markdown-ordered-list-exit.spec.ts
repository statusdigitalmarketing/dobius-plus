import { test, expect } from './helpers/dobius-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  assertLoadedThirdEmptyOrderedListItem,
  cleanupMarkdownFixture,
  createMarkdownFixture,
  expectSentinelParagraphOutsideOrderedList,
  expectSerializedDraftOutsideOrderedList,
  getActiveWorktreeContext,
  openMarkdownFixture,
  placeCaretInLoadedThirdEmptyItem,
  type MatrixRow,
  waitForRichMarkdownEditor
} from './helpers/markdown-ordered-list-exit'

const rows: MatrixRow[] = [
  {
    name: 'typed ordered-list marker exits to a paragraph',
    slug: 'typed-marker',
    sentinel: 'afterTypedMarkerExit',
    initialMarkdown: '',
    run: async (page, sentinel) => {
      const editor = await waitForRichMarkdownEditor(page)
      await editor.click()
      await page.keyboard.type('1. first')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.type(sentinel)
    }
  },
  {
    name: 'toolbar-created ordered list exits to a paragraph',
    slug: 'toolbar-list',
    sentinel: 'afterToolbarListExit',
    initialMarkdown: '',
    run: async (page, sentinel) => {
      const editor = await waitForRichMarkdownEditor(page)
      await editor.click()
      await page.getByRole('button', { name: 'Numbered list' }).click()
      await expect(editor.locator('ol')).toHaveCount(1, { timeout: 5_000 })
      await page.keyboard.type('first')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await page.keyboard.type(sentinel)
    }
  },
  {
    name: 'loaded existing-note ordered-list continuation exits to a paragraph',
    slug: 'loaded-continuation',
    sentinel: 'afterLoadedContinuationExit',
    initialMarkdown: '1. Item 1\n2. Item 2\n3. \n\n## Next section\n',
    run: async (page, sentinel) => {
      await waitForRichMarkdownEditor(page)
      await assertLoadedThirdEmptyOrderedListItem(page)
      await placeCaretInLoadedThirdEmptyItem(page)
      await page.keyboard.press('Enter')
      await page.keyboard.type(sentinel)
    }
  }
]

test.describe('Markdown ordered-list exit regression', () => {
  test.beforeEach(async ({ dobiusPage }) => {
    await waitForSessionReady(dobiusPage)
    await waitForActiveWorktree(dobiusPage)
  })

  for (const row of rows) {
    test(row.name, async ({ dobiusPage }, testInfo) => {
      const context = await getActiveWorktreeContext(dobiusPage)
      let filePath: string | null = null

      try {
        filePath = await createMarkdownFixture(
          context,
          row.slug,
          testInfo.workerIndex,
          row.initialMarkdown
        )
        const activeFile = await openMarkdownFixture(dobiusPage, context, filePath)
        const draftKey = activeFile.filePath

        await row.run(dobiusPage, row.sentinel)

        await expectSentinelParagraphOutsideOrderedList(dobiusPage, row.sentinel)
        await expectSerializedDraftOutsideOrderedList(dobiusPage, draftKey, row.sentinel)
      } finally {
        await cleanupMarkdownFixture(filePath)
      }
    })
  }
})
