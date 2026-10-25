/**
 * Stage three of the cleaning pipeline: HTML to Markdown.
 *
 * Kept deliberately in step with `dsh-tool-web`'s own conversion, so a page
 * fetched through this plugin and the same page fetched through the built-in
 * HTTP provider render identically in the transcript. That parity is not
 * cosmetic: the tool layer converts whatever a provider returns, so a plugin
 * converter that diverges silently changes what the model reads. Concretely
 * this mirrors three things the built-in renderer does and a default turndown
 * setup does not:
 *
 * - GitHub-flavored tables. Turndown ships GFM support as an optional plugin;
 *   without it an entire comparison table collapses into one line per cell.
 * - `~~strikethrough~~`, likewise part of GFM.
 * - Non-visible content (script/style/hidden/`display:none`), which turndown
 *   otherwise keeps as text.
 *
 * @module dsh-local-browser-web/markdown
 */
import TurndownService from 'turndown'

/** The one converter instance, built lazily: constructing it is not free. */
let service: TurndownService | undefined

/** Render one GFM table cell. */
function renderCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\n\r/gu, '<br>').replace(/\n/gu, '<br>').replace(/\|+/gu, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

/** Whether a row is the table's Markdown heading row. */
function isHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells)
  const section = row.parentElement as HTMLTableSectionElement | null
  const table = section?.parentElement as HTMLTableElement | null
  return (section?.nodeName === 'THEAD' || table?.rows[0] === row)
    && cells.length > 0
    && cells.every(cell => cell.nodeName === 'TH')
}

/** Map a cell's alignment to the GFM separator marker. */
function borderOf(cell: HTMLTableCellElement): string {
  const alignment = (cell.getAttribute('align') ?? cell.style.textAlign ?? '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

/** Build the configured converter. */
function converter(): TurndownService {
  if (service !== undefined) return service
  const instance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  })
  // Empty anchors and standalone images are noise in a model-facing transcript.
  instance.addRule('dropEmptyLinks', {
    filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim().length === 0,
    replacement: () => '',
  })
  // Text a reader never sees is text the model should never pay for.
  instance.addRule('removeNonVisibleContent', {
    filter(node) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true
      if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
      if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
      const declarations = node.getAttribute('style')?.split(';') ?? []
      return declarations.some((declaration) => {
        const separator = declaration.indexOf(':')
        if (separator === -1) return false
        const property = declaration.slice(0, separator).trim().toLowerCase()
        const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
        return (property === 'display' && value === 'none')
          || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
      })
    },
    replacement: () => '',
  })
  instance.addRule('gfmStrikethrough', {
    // `strike` is a legacy alias with no `HTMLElementTagNameMap` entry, so the
    // rule matches on node name instead of a tag-name list.
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => `~~${content}~~`,
  })
  // GFM cannot express spanning cells, so `colspan` is ignored: conversion work
  // stays proportional to the source rather than to a numeric attribute.
  instance.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement(content, node) {
      const cell = node as unknown as HTMLTableCellElement
      const row = cell.parentNode as HTMLTableRowElement | null
      return renderCell(content, Array.from(row?.childNodes ?? []).indexOf(cell))
    },
  })
  instance.addRule('tableRow', {
    filter: 'tr',
    replacement(content, node) {
      const row = node as unknown as HTMLTableRowElement
      const border = isHeadingRow(row)
        ? Array.from(row.cells, (cell, index) => renderCell(borderOf(cell), index)).join('')
        : ''
      return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
    },
  })
  service = instance
  return instance
}

/**
 * Convert an HTML fragment to Markdown.
 *
 * @param html - the cleaned HTML from the extraction stage.
 * @returns Markdown text.
 */
export function htmlToMarkdown(html: string): string {
  return converter().turndown(html)
}
