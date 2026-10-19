/**
 * Stage three of the cleaning pipeline: HTML to Markdown.
 *
 * Kept deliberately in step with `dsh-tool-web`'s own conversion (`turndown`), so
 * a page fetched through this plugin and the same page fetched through the
 * built-in HTTP provider render identically in the transcript.
 *
 * @module dsh-local-browser-web/markdown
 */
import TurndownService from 'turndown'

/** The one converter instance, built lazily: constructing it is not free. */
let service: TurndownService | undefined

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
