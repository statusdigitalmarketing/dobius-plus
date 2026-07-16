import { describe, expect, it } from 'vitest'
import { normalizeMobileMarkdownPreviewHtml } from './mobile-markdown-preview-html'
import { parseMobileMarkdown } from './mobile-markdown-parser'

describe('parseMobileMarkdown', () => {
  it('parses GFM tables into table blocks', () => {
    expect(parseMobileMarkdown('| Name | State |\n| --- | --- |\n| Dobius | Open |')).toEqual([
      {
        type: 'table',
        headers: ['Name', 'State'],
        rows: [['Dobius', 'Open']]
      }
    ])
  })

  it('parses standalone HTTPS images without folding them into paragraphs', () => {
    expect(parseMobileMarkdown('![Screenshot](https://example.com/screen.png)')).toEqual([
      {
        type: 'image',
        alt: 'Screenshot',
        url: 'https://example.com/screen.png'
      }
    ])
  })

  it('normalizes common README HTML into readable Markdown preview text', () => {
    const normalized = normalizeMobileMarkdownPreviewHtml(`
<h1 align="center">
  <a href="https://onDobius.dev"><img src="resources/build/icon.png" alt="Dobius" width="64" /></a>
  Dobius
</h1>

<p align="center">
  <a href="https://github.com/statusdigitalmarketing/dobius-plus/stargazers"><img src="https://badgen.net/github/stars/statusdigitalmarketing/dobius-plus" alt="GitHub stars" /></a>
  <strong>The AI Orchestrator</strong><br/>
  Run Codex side-by-side.
</p>
`)

    expect(normalized).toContain('# [Dobius](https://onDobius.dev)')
    expect(normalized).toContain('[GitHub stars](https://github.com/statusdigitalmarketing/dobius-plus/stargazers)')
    expect(normalized).toContain('**The AI Orchestrator**')
    expect(normalized).not.toContain('<h1')
    expect(normalized).not.toContain('<img')
  })

  it('preserves documented HTML entities while normalizing preview HTML', () => {
    expect(
      normalizeMobileMarkdownPreviewHtml('<p>Use <code>&amp;lt;button&amp;gt;</code></p>')
    ).toBe('Use `&lt;button&gt;`')
  })

  it('preserves angle brackets and generics inside fenced and inline code', () => {
    expect(normalizeMobileMarkdownPreviewHtml('```html\n<div>x</div>\n```')).toBe(
      '```html\n<div>x</div>\n```'
    )
    expect(normalizeMobileMarkdownPreviewHtml('```ts\nconst x: Array<string> = []\n```')).toBe(
      '```ts\nconst x: Array<string> = []\n```'
    )
    expect(normalizeMobileMarkdownPreviewHtml('```ts\nconst x: Array<string> = []')).toBe(
      '```ts\nconst x: Array<string> = []'
    )
    expect(normalizeMobileMarkdownPreviewHtml('Use `Array<string>` here')).toBe(
      'Use `Array<string>` here'
    )
  })

  it('preserves non-tag angle bracket prose while stripping known HTML tags', () => {
    expect(normalizeMobileMarkdownPreviewHtml('1 < 2 and 3 > 1')).toBe('1 < 2 and 3 > 1')
    expect(normalizeMobileMarkdownPreviewHtml('Array<string> in prose')).toBe(
      'Array<string> in prose'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<https://example.com>')).toBe(
      '<https://example.com>'
    )
    expect(normalizeMobileMarkdownPreviewHtml('<div>Readable text</div>')).toBe('Readable text')
  })

  it('preserves angle brackets inside Markdown code produced from HTML code tags', () => {
    expect(normalizeMobileMarkdownPreviewHtml('<p>Use <code>Array&lt;string&gt;</code></p>')).toBe(
      'Use `Array<string>`'
    )
    expect(
      normalizeMobileMarkdownPreviewHtml('<p>Use <code>&lt;div&gt;x&lt;/div&gt;</code></p>')
    ).toBe('Use `<div>x</div>`')
  })

  it('does not replace literal code placeholder text in markdown prose', () => {
    const literalPlaceholder = '\uE000DOBIUS_MD_CODE_0\uE000'
    expect(normalizeMobileMarkdownPreviewHtml(`${literalPlaceholder} and \`Array<string>\``)).toBe(
      `${literalPlaceholder} and \`Array<string>\``
    )
  })
})
