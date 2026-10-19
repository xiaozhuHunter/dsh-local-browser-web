/**
 * The `local_search_test` tool.
 *
 * The settings panel's "test connection" button needs a real search, and so does
 * anyone debugging a fallback chain from a session. Rather than keeping that logic
 * in the UI, the plugin exposes it as a tool, so the agent can batch-test every
 * enabled engine and report *why* each one failed — with the failing stage
 * (DNS / HTTP / parse / credential) named, instead of "0 results".
 *
 * It also bridges the diagnostics ring: `recent: true` returns the last operations
 * (optionally only the failures) without issuing any network request, which is how
 * "what broke a minute ago" gets answered without leaving the session.
 *
 * @module dsh-local-browser-web/tools/local-search-test
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { queryEngine } from '../engines/dispatch.ts'
import type { RunnerContext } from '../engines/runners/context.ts'
import type { EngineRegistry } from '../engines/registry.ts'
import { LocalBrowserWebError } from '../errors.ts'
import type { Diagnostics, OperationRecord } from '../log.ts'
import type { EngineSpec } from '../types.ts'

/** What the tool needs from the plugin instance. */
export interface SearchTestToolDeps {
  registry: EngineRegistry
  runner: RunnerContext
  diagnostics: Diagnostics
}

/** One engine's probe outcome. */
interface EngineProbe {
  engine: string
  reachable: boolean
  elapsedMs: number
  resultCount: number
  firstTitle?: string
  failureStage?: string
  failureCode?: string
  message?: string
}

/** One diagnostics record, flattened so a model can read it without nesting. */
interface DiagnosticsView {
  at: number
  kind: string
  target: string
  elapsedMs: number
  engine?: string
  backend?: string
  chars?: number
  score?: number
  flags?: string[]
  code?: string
  message?: string
}

/** Project a diagnostics record into its flat view. */
function toView(record: OperationRecord): DiagnosticsView {
  return {
    at: record.at,
    kind: record.kind,
    target: record.target,
    elapsedMs: record.elapsedMs,
    ...record.engine === undefined ? {} : { engine: record.engine },
    ...record.backend === undefined ? {} : { backend: record.backend },
    ...record.chars === undefined ? {} : { chars: record.chars },
    ...record.quality === undefined ? {} : { score: record.quality.score, flags: record.quality.flags },
    ...record.code === undefined ? {} : { code: record.code },
    ...record.message === undefined ? {} : { message: record.message },
  }
}

/** Which stage a failure stopped at, so the panel can say more than "failed". */
export function classifyStage(error: unknown): string {
  if (!(error instanceof LocalBrowserWebError)) {
    return error instanceof Error && /getaddrinfo|ENOTFOUND|EAI_AGAIN/u.test(error.message) ? 'dns' : 'http'
  }
  switch (error.code) {
    case 'ENGINE_CONFIG_INVALID': return 'parse'
    case 'ENGINE_TEST_FAILED': return /凭据/u.test(error.message) ? 'credential' : 'parse'
    case 'BROWSER_UNAVAILABLE': return 'dns'
    default: return 'http'
  }
}

/** Probe one engine with one real query. */
async function probe(engine: EngineSpec, query: string, deps: SearchTestToolDeps, signal: AbortSignal): Promise<EngineProbe> {
  const started = Date.now()
  try {
    const sources = await queryEngine(engine, query, deps.runner, signal)
    const first = sources[0]
    return {
      engine: engine.id,
      reachable: true,
      elapsedMs: Date.now() - started,
      resultCount: sources.length,
      ...first?.title === undefined ? {} : { firstTitle: first.title },
    }
  } catch (error) {
    return {
      engine: engine.id,
      reachable: false,
      elapsedMs: Date.now() - started,
      resultCount: 0,
      failureStage: classifyStage(error),
      failureCode: error instanceof LocalBrowserWebError ? error.code : 'ENGINE_TEST_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Render the probes as one model-facing text block. */
function renderProbes(value: { probes: readonly EngineProbe[], diagnostics: readonly DiagnosticsView[] }): string {
  const lines = value.probes.map((item) => {
    if (item.reachable) {
      const title = item.firstTitle === undefined ? '' : `，首条「${item.firstTitle}」`
      return `- ${item.engine}: OK — ${String(item.resultCount)} 条结果，${String(item.elapsedMs)}ms${title}`
    }
    return `- ${item.engine}: FAILED — 阶段=${item.failureStage ?? '?'}，code=${item.failureCode ?? '?'}，${item.message ?? ''}`
  })
  const head = value.probes.length === 0 ? '未执行引擎探测。' : `引擎测试（${String(value.probes.length)} 个）：`
  const diag = value.diagnostics.length === 0
    ? ''
    : `\n\n诊断（${String(value.diagnostics.length)} 条，新→旧）：\n${JSON.stringify(value.diagnostics, null, 2)}`
  return `${head}${lines.length === 0 ? '' : `\n${lines.join('\n')}`}${diag}`
}

/**
 * Register the `local_search_test` tool.
 *
 * @param ctx - context whose `tools` and `systemPrompt` registries receive the tool.
 * @param deps - the engine registry, runner context, and diagnostics ring.
 */
export function applyLocalSearchTestTool(ctx: Context, deps: SearchTestToolDeps): void {
  ctx.systemPrompt.section({
    name: 'tool:local_search_test',
    order: ctx.systemPrompt.getSectionOrder('TOOL_WEB_SEARCH'),
    text: ({ scope }) => ctx.tools.get('local_search_test', scope) === undefined
      ? ''
      : 'local_search_test 会真实查询搜索引擎并报告可达性、耗时、结果条数与失败阶段；排查 web_search 返回空结果时先用它定位是哪个引擎失败。',
  })

  ctx.tools.register(defineTool({
    name: 'local_search_test',
    description: '真实测试本地搜索引擎：逐引擎报告是否可达、耗时、返回条数与首条标题，失败时给出失败阶段（dns/http/parse/credential）。也可只读取最近的操作诊断。',
    parameters: {
      engine: { type: 'string', description: '要测试的引擎 id；省略则测试所有已启用引擎。' },
      recent: { type: 'boolean', description: 'true 时不发真实请求，只返回最近的操作/错误诊断。' },
      query: { type: 'string', description: '探测查询词，默认 "deepseek harness"。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          probes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                engine: { type: 'string', required: true },
                reachable: { type: 'boolean', required: true },
                elapsedMs: { type: 'number', required: true },
                resultCount: { type: 'number', required: true },
                firstTitle: { type: 'string' },
                failureStage: { type: 'string' },
                failureCode: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
          diagnostics: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                at: { type: 'number', required: true },
                kind: { type: 'string', required: true },
                target: { type: 'string', required: true },
                elapsedMs: { type: 'number', required: true },
                engine: { type: 'string' },
                backend: { type: 'string' },
                chars: { type: 'number' },
                score: { type: 'number' },
                flags: { type: 'array', items: { type: 'string' } },
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderProbes(value) }],
    },
    timeoutMs: 120_000,
    // Probing reads providers and writes nothing; siblings may run together.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = args.query ?? 'deepseek harness'
      if (args.recent === true) {
        return { probes: [], diagnostics: deps.diagnostics.recent(20, true).map(toView) }
      }
      const all = deps.registry.enabled()
      const selected = args.engine === undefined || args.engine.length === 0
        ? all
        : all.filter(engine => engine.id === args.engine)
      if (selected.length === 0) {
        return {
          probes: [],
          diagnostics: [{
            at: Date.now(),
            kind: 'search',
            target: query,
            elapsedMs: 0,
            code: 'NO_ENABLED_ENGINE',
            message: args.engine === undefined
              ? '没有已启用的引擎；请先在设置面板启用至少一个引擎。'
              : `未找到已启用的引擎 "${args.engine}"。可用：${all.map(engine => engine.id).join(', ') || '无'}`,
          }],
        }
      }
      const probes: EngineProbe[] = []
      for (const engine of selected) probes.push(await probe(engine, query, deps, exec.signal))
      return { probes, diagnostics: [] }
    },
  }))
}
