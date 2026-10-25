/**
 * The Chinese-language SERP strategies: Baidu, Google, and 360 Search.
 *
 * Each fixture mirrors the real markup the engine serves (verified against a
 * rendered page), including its own click-tracking wrapper and its own ad marker,
 * because "the link is the engine's redirect" and "the ad block parsed as a
 * result" are the two failure modes these parsers exist to prevent.
 *
 * @module dsh-local-browser-web/tests/engines-cn
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ParserRegistry } from '../src/engines/parsers.ts'
import { makeEngine } from './helpers.ts'

const BAIDU = `
<html><body><div id="content_left">
  <div class="result c-container xpath-log new-pmd" id="1" mu="https://www.deepseek.com/">
    <h3 class="t"><a href="http://www.baidu.com/link?url=abc">DeepSeek | 深度求索</a></h3>
    <div class="c-abstract">深度求索，探索未至之境。</div>
    <span class="c-color-gray2">2026-01-01</span>
  </div>
  <div class="result c-container ec_tuiguang" id="2" data-tuiguang="1">
    <h3 class="t"><a href="https://ad.test/">广告</a></h3>
    <div class="c-abstract">这是推广位</div>
  </div>
  <div class="result c-container" id="3">
    <h3 class="t"><a href="http://www.baidu.com/link?url=def">只有跳转链接的结果</a></h3>
    <span class="content-right_1Hhwm">没有 mu 属性时保留跳转链接。</span>
  </div>
</div></body></html>`

const GOOGLE = `
<html><body><div id="rso">
  <div class="MjjYud"><div class="g"><div class="yuRUbf">
    <a href="/url?q=https://g.test/1&amp;sa=U&amp;ved=abc"><h3 class="LC20lb">G Title</h3></a>
  </div><div class="VwiC3b">G snippet</div></div></div>
  <div class="MjjYud"><div class="g">
    <a href="https://www.google.com/preferences"><h3>Google 内部页面</h3></a>
  </div></div>
  <div class="MjjYud"><div class="g" data-text-ad="1">
    <a href="https://ad.test/"><h3>广告</h3></a>
  </div></div>
</div></body></html>`

const SO360 = `
<html><body><ul class="result">
  <li class="res-list" data-result-type="richsum" data-result-pos="1">
    <h3 class="res-title mark-nowrap"><a href="https://www.so.com/link?m=xxx" data-mdurl="https://www.deepseek.com/">DeepSeek | 深度求索</a></h3>
    <span class="res-list-summary" data-result-summary>深度求索，专注于通用人工智能。</span>
  </li>
  <li class="res-list" data-result-type="normal" data-result-pos="2">
    <h3 class="res-title"><a href="https://www.so.com/link?m=yyy" data-mdurl="https://bot.n.cn/download/">来纳米AI 体验</a></h3>
    <p class="res-desc"><span class="gray g-c-gray">14小时前&nbsp;-&nbsp;</span><span data-result-summary>限时免费畅享。</span></p>
  </li>
  <li class="res-list ec_ad" data-result-type="ad" data-result-pos="3">
    <h3 class="res-title"><a href="https://ad.test/">推广</a></h3>
  </li>
</ul></body></html>`

/** Parse one fixture with the strategy the engine declares. */
const parse = (id: string, fixture: string, engineId: string): ReturnType<ParserRegistry['parse']> =>
  new ParserRegistry().parse(id, {
    engine: makeEngine({ id: engineId }),
    query: 'q',
    body: fixture,
    contentType: 'text/html',
  })

describe('html-baidu parser', () => {
  it('prefers the mu target, reads the snippet, and drops paid placements', () => {
    const sources = parse('html-baidu', BAIDU, 'baidu')
    assert.equal(sources.length, 2)
    assert.equal(sources[0]?.url, 'https://www.deepseek.com/')
    assert.equal(sources[0]?.title, 'DeepSeek | 深度求索')
    assert.equal(sources[0]?.snippet, '深度求索，探索未至之境。')
    assert.equal(sources[0]?.publishedAt, '2026-01-01')
  })

  it('keeps the redirect link when no real target is exposed', () => {
    const sources = parse('html-baidu', BAIDU, 'baidu')
    assert.equal(sources[1]?.url, 'http://www.baidu.com/link?url=def')
    assert.equal(sources[1]?.snippet, '没有 mu 属性时保留跳转链接。')
  })

  it('drops placement slots that point back into Baidu', () => {
    // Real mobile SERPs mix these in among the answers; they carry no article and
    // resolve to Baidu's own products, so they must not be reported as sources.
    const fixture = `<html><body><div id="content_left">
      <div class="result c-container" mu="https://real.test/a"><h3><a>Real result</a></h3></div>
      <div class="result c-container" mu="http://34689.recommend_list.baidu.com/"><h3><a>推荐位</a></h3></div>
      <div class="result c-container" mu="http://nourl.ubs.baidu.com/279"><h3><a>占位</a></h3></div>
    </div></body></html>`
    const sources = parse('html-baidu', fixture, 'baidu')
    assert.equal(sources.length, 1)
    assert.equal(sources[0]?.url, 'https://real.test/a')
  })
})

describe('html-google parser', () => {
  it('unwraps /url?q=, reads the snippet, and skips google-internal and ad blocks', () => {
    const sources = parse('html-google', GOOGLE, 'google')
    assert.equal(sources.length, 1)
    assert.deepEqual(sources[0], { url: 'https://g.test/1', title: 'G Title', snippet: 'G snippet' })
  })
})

describe('html-so360 parser', () => {
  it('reads data-mdurl and both snippet shapes, dropping the ad block', () => {
    const sources = parse('html-so360', SO360, 'so360')
    assert.equal(sources.length, 2)
    assert.equal(sources[0]?.url, 'https://www.deepseek.com/')
    assert.equal(sources[0]?.title, 'DeepSeek | 深度求索')
    assert.equal(sources[0]?.snippet, '深度求索，专注于通用人工智能。')
    assert.equal(sources[1]?.url, 'https://bot.n.cn/download/')
    assert.equal(sources[1]?.snippet, '限时免费畅享。')
    assert.equal(sources[1]?.publishedAt, '14小时前 -')
  })
})

describe('the shipped engine registry', () => {
  it('ships the three Chinese engines alongside the originals', async () => {
    const { DEFAULT_ENGINES, BUILT_IN_PARSERS } = await import('../src/config.ts')
    const ids = DEFAULT_ENGINES.map(engine => engine.id)
    assert.deepEqual(ids, ['bing', 'duckduckgo', 'baidu', 'baidu-pc', 'google', 'so360'])
    for (const engine of DEFAULT_ENGINES) {
      assert.ok(
        (BUILT_IN_PARSERS as readonly string[]).includes(engine.resultParser),
        `${engine.id} references an unregistered parser`,
      )
    }
    // The desktop Baidu surface gates unfamiliar networks, so it ships as an
    // opt-in variant while the mobile surface is what a fresh install relies on.
    assert.equal(DEFAULT_ENGINES.find(engine => engine.id === 'baidu-pc')?.enabled, false)
    for (const id of ['baidu', 'google', 'so360']) {
      assert.equal(DEFAULT_ENGINES.find(engine => engine.id === id)?.enabled, true, `${id} ships disabled`)
    }
    // 360 Search is server-rendered, so it must not drag in a browser dependency.
    assert.equal(DEFAULT_ENGINES.find(engine => engine.id === 'so360')?.kind, 'http-html')
    // DuckDuckGo's React surface renders blank without its script bundle; the
    // `html/` endpoint serves the same results already rendered.
    const ddg = DEFAULT_ENGINES.find(engine => engine.id === 'duckduckgo')
    assert.equal(ddg?.kind, 'http-html')
    assert.ok(ddg?.endpoint.includes('html.duckduckgo.com') === true, 'duckduckgo must use the html endpoint')
    // Google hides the destination behind `/goto?url=`, so it must declare the
    // tracker pattern that turns those links back into real URLs.
    const google = DEFAULT_ENGINES.find(engine => engine.id === 'google')
    assert.ok(google?.unwrapRedirect !== undefined, 'google must declare unwrapRedirect')
    assert.match('https://www.google.com/goto?url=abc', new RegExp(google.unwrapRedirect, 'u'))
    // Baidu rejects plain fetches, so both of its surfaces must render.
    assert.equal(DEFAULT_ENGINES.find(engine => engine.id === 'baidu')?.kind, 'browser')
  })
})

/**
 * A client-rendered SERP answers with a shell, so `loadEventFired` can arrive while
 * the result list is still empty. The strategies that depend on injected markup
 * declare a readiness selector; the runner relays it and the backend waits on it.
 */
describe('parser readiness declarations', () => {
  /** A Google shell: the document loads and `#rso` is still missing. */
  const GOOGLE_SHELL = '<html><body><div id="main">跳到主要内容</div></body></html>'

  it('declares a readiness selector for the engines that render result lists', () => {
    const registry = new ParserRegistry()
    assert.deepEqual(registry.waiters('html-google'), ['#rso'])
    assert.ok(registry.waiters('html-ddg').length > 0)
  })

  it('declares nothing for server-rendered strategies, so they never wait', () => {
    const registry = new ParserRegistry()
    assert.deepEqual(registry.waiters('html-so360'), [])
    assert.deepEqual(registry.waiters('html-bing'), [])
  })

  it('answers an unknown strategy with an empty wait list instead of throwing', () => {
    assert.deepEqual(new ParserRegistry().waiters('not-registered'), [])
  })

  it('parses nothing from the shell that the selector exists to skip', () => {
    // Documents why the wait exists: without it the shell yields zero sources.
    assert.equal(parse('html-google', GOOGLE_SHELL, 'google').length, 0)
  })
})
