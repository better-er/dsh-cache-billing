/**
 * dsh-cache-billing — 缓存账单 host 端。
 *
 * 唯一职责：注册一个 session projection 单元 cacheBilling，盯住最新一次大模型 API 请求的缓存命中 token 数，按 DeepSeek 峰谷价折算成金额，随推送帧直推浏览器，零轮询零路由。
 *
 * 一轮的定义：每次请求大模型 API 算一轮。人类说话之后 AI 可能多次调用工具，工具结果又返回给大模型请求 API，每次请求算一轮。会话事件流中即 turn 和 step：同一 step 的 chunk 流式样本被 assistant/message 最终样本替换，官方 token-meter 同款替换语义；新 step 出现即覆盖上一轮，只显示当前步。turn 是一个用户消息内的多步合计，切换用户消息时重置。
 *
 * 计价口径：本步 cacheReadTokens × 该模型该时刻的缓存命中单价 ÷ 1e6。缓存命中 token 读 usage.cacheReadTokens，DSH adapter 映射自 DeepSeek API 响应的 prompt_cache_hit_tokens。峰谷判定只用事件时间戳做 UTC+8 数学换算，北京工作日 9–12、14–18 点为峰，周末与中国法定节假日全天半价，与系统时区无关，本机系统时间不可信。模型从 request/header、request/context 跟踪，assistant/message 的 message.source.model 校正，账目只按 DeepSeek-V4.1-Flash 一个模型计价，模型名认官方现名 deepseek-flash、历史旧名 deepseek-v4-flash 与 deepseek-v4-flash-vision-exp、以及现名 deepseek-v4.1-flash 及其带后缀的变体，界面统一显示 DeepSeek-V4.1-Flash。第三方中转同样显示：provider 非空即放行，模型名不认时按 Flash 价估算并标注实际运行模型。
 */

import { z } from 'zod'

/** 插件名，与 cordis.patch.yml 的 name 一致，loader 诊断用。 */
export const name = 'dsh-cache-billing'

/** 必需服务：sessionProjections 由 @deepseek-ai/dsh-session-projection 提供。 */
export const inject = ['sessionProjections']

// ── 价格表：CNY 元 / 百万 token，全程只按 DeepSeek-V4.1-Flash 一个模型计价，低谷价 0.02 / 1 / 4，高峰期翻倍 ──
// 时段政策：2026-08-22 起周六日全天谷价，仅工作日有峰价，用户转发官方邮件告知；官方定价页注明中国法定节假日全天亦为谷价。

interface RateRow {
  /** 缓存命中输入单价 */
  cacheHit: number
  /** 未命中输入单价，含缓存写入 */
  cacheMiss: number
  /** 输出单价 */
  output: number
}

/** 唯一计价模型：DeepSeek-V4.1-Flash。aliases 是模型名识别白名单，命中即按本模型计价并在界面显示 label。 */
interface BillingModel {
  /** 规范名，仅内部用 */
  key: string
  /** 界面显示名 */
  label: string
  /** 模型名白名单，小写比较，支持精确、后缀、包含三级匹配 */
  aliases: readonly string[]
  /** 高峰价，北京工作日 09:00–12:00、14:00–18:00 生效，法定节假日全天不算峰，是低谷价的两倍 */
  peak: RateRow
  /** 低谷价，其余时段、周六日与中国法定节假日全天生效，是价目表的基准列 */
  offPeak: RateRow
}

/**
 * 账目只认 DeepSeek-V4.1-Flash。官方现行模型名为 deepseek-flash，旧名 deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 仍可调用但同样由 V4.1-Flash 提供服务，
 * 历史现名 deepseek-v4.1-flash 及带 expires-on 等后缀的变体一并认下，全部按 Flash 价计价并统一显示 label。
 */
const MODEL: BillingModel = {
  key: 'deepseek-v4.1-flash',
  label: 'DeepSeek-V4.1-Flash',
  aliases: [
    'deepseek-v4.1-flash',
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
  ],
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
}

type Tier = 'peak' | 'offPeak'

/**
 * 中国法定节假日放假日名单，北京时间 YYYY-MM-DD。2026 年国务院放假安排共 33 天，取自 github.com/NateScarlet/holiday-cn。
 * 只收放假日，不收调休补班的周末——周末本就全天谷价，补班与否不影响判定。
 * 只内置 2026 年；新年度安排公布后在此补日期。表外年份退化为只认周末，与未加节假日前的行为一致。
 */
const HOLIDAYS_2026: ReadonlySet<string> = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

/**
 * 时刻是否为北京高峰。纯 UTC+8 数学换算，与系统时区无关，红线。政策：周末与中国法定节假日全天谷价，仅工作日有峰价；工作日峰段为 09:00–12:00、14:00–18:00 北京时间。
 */
function isPeakBeijing(timeMs: number): boolean {
  const shifted = new Date(timeMs + 8 * 3600 * 1000)
  const day = shifted.getUTCDay() // 0=周日 6=周六，同一 shifted 时刻取星期与小时，跨日一致
  if (day === 0 || day === 6) return false // 周末全天谷价
  // 用 getUTC* 拼北京日历日，不用 toISOString：无效时间戳上后者抛 RangeError 会打断计价，getUTC* 只会拼出不命中的串
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dayOfMonth = String(shifted.getUTCDate()).padStart(2, '0')
  if (HOLIDAYS_2026.has(`${shifted.getUTCFullYear()}-${month}-${dayOfMonth}`)) return false // 法定节假日全天谷价
  const hour = shifted.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/**
 * 模型在某时刻的费率行。价目表只有 DeepSeek-V4.1-Flash 一个模型，所以永远返回它的费率；
 * matched 表示模型名是否命中 aliases 白名单，精确、后缀、包含三级任一命中即为 true，带命名空间前缀或过期后缀的变体例如 deepseek-v4.1-flash-expires-on-0910 由此命中。
 * 三级都不中走估算：仍按 Flash 当前时段价，matched 为 false，客户端据此标注实际运行模型。返回费率、时段、显示名与命中标记。
 */
function rateOf(
  model: string | null,
  timeMs: number,
): { row: RateRow; tier: Tier; matchedModel: string; matched: boolean } {
  const key = (model ?? '').toLowerCase()
  const tier: Tier = isPeakBeijing(timeMs) ? 'peak' : 'offPeak'
  const row = tier === 'peak' ? MODEL.peak : MODEL.offPeak
  const matched = MODEL.aliases.some(
    (alias) => key === alias || key.endsWith(alias) || key.includes(alias),
  )
  return { row, tier, matchedModel: MODEL.label, matched }
}

const round9 = (n: number): number => Math.round(n * 1e9) / 1e9

/** 一个 usage 样本，state.last 只存最新一轮。 */
interface Sample {
  turn: number
  step: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  model: string | null
  provider: string | null
  /** 事件时刻 epoch ms，峰谷判定与明细说明都用它，不用当前时钟 */
  time: number
}

/** 会话累计，跨轮逐笔按各自事件时刻费率计价，而非按最新时刻统算。 */
interface Totals {
  /** 缓存命中金额累计，元 */
  cacheHitCost: number
  /** 未命中输入含缓存写入金额累计，元 */
  missCost: number
  /** 输出金额累计，元 */
  outputCost: number
  /** 输入 token 累计，命中加未命中加写入 */
  inputTokens: number
  /** 缓存命中 token 累计，明细行展示用 */
  cacheReadTokens: number
  /** 输出 token 累计 */
  outputTokens: number
  /** 有 usages 的 step 数，同 step 替换不重复计 */
  rounds: number
  /** 缓存失效 step 数，发生过缓存写入，DeepSeek 官方不报写入字段，多数路由恒为 0，个别中转报值时生效 */
  missSteps: number
  /** 缓存写入 token 量累计，同上，仅部分中转有值 */
  writeTokens: number
  /** 完全失效 step 数，有输入但缓存命中为 0，整条上下文缓存全没吃上，由 cacheReadTokens 推导，任何路由都可靠 */
  fullMissSteps: number
}

/** 当前轮累计，一个用户消息内多次 API 调用的合计，turn 切换时重置。 */
interface TurnTotals {
  /** turn 序号 */
  id: number
  /** 缓存命中金额累计 */
  hitCost: number
  /** 未命中输入金额累计 */
  missCost: number
  /** 输出金额累计 */
  outputCost: number
  /** 输入 token 累计，命中加未命中加写入 */
  inputTokens: number
  /** 缓存命中 token 累计，明细行展示用 */
  cacheReadTokens: number
  /** 输出 token 累计 */
  outputTokens: number
}

/** 按样本模型与事件时刻计算一轮三笔费用，元，round9 防精度漂移。 */
function costOf(sample: Sample): { hit: number; miss: number; output: number } {
  const { row } = rateOf(sample.model, sample.time)
  return {
    hit: round9((sample.cacheReadTokens * row.cacheHit) / 1e6),
    miss: round9(((sample.inputTokens + sample.cacheWriteTokens) * row.cacheMiss) / 1e6),
    output: round9((sample.outputTokens * row.output) / 1e6),
  }
}

/** 缓存失效判定：发生过缓存写入。写入即失效，官方不报写入，多数路由为 false。 */
const isWriteMiss = (s: Sample): boolean => s.cacheWriteTokens > 0

/** 完全失效判定：有输入但缓存命中为 0，整条上下文缓存全没吃上。由 cacheReadTokens 推导，任何路由都可靠，首轮无缓存可命中也算，近似。 */
const isFullMiss = (s: Sample): boolean =>
  s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens > 0 && s.cacheReadTokens === 0

interface ProjectionState {
  /** 当前请求的 provider，request/header 跟踪，message.source 校正 */
  provider: string | null
  /** 当前请求的 model */
  model: string | null
  /** 最新一轮 usage 样本，新 step 直接覆盖 */
  last: Sample | null
  /** 当前轮累计，turn 切换时重置 */
  turn: TurnTotals | null
  /** 会话累计金额与轮数 */
  totals: Totals
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any, _config: any): void {
  ctx.inject(['sessionProjections'], (projectionCtx: any) => {
    // 新版 0.1.1-rc.2 契约：{ key, stateSchema, init, apply, wire: {viewSchema, view}, stateVersion }
    // 没有 wire 即 host-only 单元，状态不进客户端快照，useProjection 永远拿不到值。
    projectionCtx.sessionProjections.register({
      key: 'cacheBilling',
      // v6：价目表换成 deepseek-v4.1-flash 单一模型新价，旧持久化金额按旧价记的，作废重放用新价重算
      // 本次只把峰谷判定纳入 2026 法定节假日，尚无旧账落在节假日时刻，无需重算，故不升 stateVersion
      stateVersion: 6,
      stateSchema: z.object({
        provider: z.string().nullable(),
        model: z.string().nullable(),
        last: z
          .object({
            turn: z.number().int(),
            step: z.number().int(),
            inputTokens: z.number().int().nonnegative(),
            cacheReadTokens: z.number().int().nonnegative(),
            cacheWriteTokens: z.number().int().nonnegative(),
            outputTokens: z.number().int().nonnegative(),
            model: z.string().nullable(),
            provider: z.string().nullable(),
            time: z.number(),
          })
          .nullable(),
        turn: z
          .object({
            id: z.number().int(),
            hitCost: z.number().nonnegative(),
            missCost: z.number().nonnegative(),
            outputCost: z.number().nonnegative(),
            inputTokens: z.number().int().nonnegative(),
            cacheReadTokens: z.number().int().nonnegative(),
            outputTokens: z.number().int().nonnegative(),
          })
          .nullable(),
        totals: z.object({
          cacheHitCost: z.number().nonnegative(),
          missCost: z.number().nonnegative(),
          outputCost: z.number().nonnegative(),
          inputTokens: z.number().int().nonnegative(),
          cacheReadTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          rounds: z.number().int().nonnegative(),
          missSteps: z.number().int().nonnegative(),
          writeTokens: z.number().int().nonnegative(),
          fullMissSteps: z.number().int().nonnegative(),
        }),
      }),
      init: (): ProjectionState => ({
        provider: null,
        model: null,
        last: null,
        turn: null,
        totals: {
          cacheHitCost: 0,
          missCost: 0,
          outputCost: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          rounds: 0,
          missSteps: 0,
          writeTokens: 0,
          fullMissSteps: 0,
        },
      }),

      apply: (state: ProjectionState, event: any): ProjectionState => {
        // 跟踪当前请求的 provider 与 model
        if (event.type === 'request/header') {
          const cfg = event.data?.header?.config
          const provider =
            typeof cfg?.provider === 'string' && cfg.provider !== '' ? cfg.provider : state.provider
          const model =
            typeof cfg?.model === 'string' && cfg.model !== '' ? cfg.model : state.model
          if (provider !== state.provider || model !== state.model) {
            return { ...state, provider, model }
          }
          return state
        }
        if (event.type === 'request/context') {
          const raw = event.data?.model
          const model = typeof raw === 'string' && raw !== '' ? raw : state.model
          return model !== state.model ? { ...state, model } : state
        }

        // usage 样本，一轮就是一个 step
        let turn: unknown
        let step: unknown
        let usage: any
        let sourceModel: string | undefined
        let sourceProvider: string | undefined
        if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
          turn = event.data.turn
          step = event.data.step
          usage = event.data.chunk.usage
        } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
          turn = event.data.turn
          step = event.data.step
          usage = event.data.usage
          const source = event.data.message?.source
          if (typeof source?.provider === 'string') sourceProvider = source.provider
          if (typeof source?.model === 'string') sourceModel = source.model
        } else {
          // 与本单元无关的事件：返回同一引用，驱动以 Object.is 把关变更流
          return state
        }
        if (usage === undefined || typeof turn !== 'number' || typeof step !== 'number') {
          return state
        }

        const sample: Sample = {
          turn,
          step,
          inputTokens: Number(usage.inputTokens) || 0,
          cacheReadTokens: Number(usage.cacheReadTokens) || 0,
          cacheWriteTokens: Number(usage.cacheWriteTokens) || 0,
          outputTokens: Number(usage.outputTokens) || 0,
          model: sourceModel ?? state.model,
          provider: sourceProvider ?? state.provider,
          time: typeof event.time === 'number' ? event.time : Date.now(),
        }

        const prev = state.last
        // 同一 step 的替换样本，chunk 流式到 final message，数据全同则引用不变
        if (
          prev !== null &&
          prev.turn === turn &&
          prev.step === step &&
          prev.inputTokens === sample.inputTokens &&
          prev.cacheReadTokens === sample.cacheReadTokens &&
          prev.cacheWriteTokens === sample.cacheWriteTokens &&
          prev.outputTokens === sample.outputTokens &&
          prev.model === sample.model &&
          prev.provider === sample.provider
        ) {
          return state
        }
        // 新 step 是新一轮，覆盖上一轮；同 step 新样本是替换。
        // 会话累计随之维护：同 step 替换扣旧样本款加新样本款，不增轮数；新 step 整轮累加、轮数加一。失效计数同样遵循替换语义扣旧加新。
        // 当前轮累计：同 turn 累加，turn 切换重置，同 step 替换扣旧加新。
        const current = costOf(sample)
        const writeMiss = isWriteMiss(sample)
        const fullMiss = isFullMiss(sample)
        const sampleInputTokens = sample.inputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
        if (prev !== null && prev.turn === turn && prev.step === step) {
          const old = costOf(prev)
          const prevInputTokens = prev.inputTokens + prev.cacheReadTokens + prev.cacheWriteTokens
          const turnBase =
            state.turn !== null && state.turn.id === prev.turn
              ? state.turn
              : {
                  id: turn,
                  hitCost: 0,
                  missCost: 0,
                  outputCost: 0,
                  inputTokens: 0,
                  cacheReadTokens: 0,
                  outputTokens: 0,
                }
          return {
            ...state,
            last: sample,
            turn: {
              ...turnBase,
              id: turn,
              hitCost: turnBase.hitCost - old.hit + current.hit,
              missCost: turnBase.missCost - old.miss + current.miss,
              outputCost: turnBase.outputCost - old.output + current.output,
              inputTokens: turnBase.inputTokens - prevInputTokens + sampleInputTokens,
              cacheReadTokens:
                turnBase.cacheReadTokens - prev.cacheReadTokens + sample.cacheReadTokens,
              outputTokens: turnBase.outputTokens - prev.outputTokens + sample.outputTokens,
            },
            totals: {
              cacheHitCost: state.totals.cacheHitCost - old.hit + current.hit,
              missCost: state.totals.missCost - old.miss + current.miss,
              outputCost: state.totals.outputCost - old.output + current.output,
              inputTokens: state.totals.inputTokens - prevInputTokens + sampleInputTokens,
              cacheReadTokens:
                state.totals.cacheReadTokens - prev.cacheReadTokens + sample.cacheReadTokens,
              outputTokens: state.totals.outputTokens - prev.outputTokens + sample.outputTokens,
              rounds: state.totals.rounds,
              missSteps: state.totals.missSteps - (isWriteMiss(prev) ? 1 : 0) + (writeMiss ? 1 : 0),
              writeTokens: state.totals.writeTokens - prev.cacheWriteTokens + sample.cacheWriteTokens,
              fullMissSteps:
                state.totals.fullMissSteps - (isFullMiss(prev) ? 1 : 0) + (fullMiss ? 1 : 0),
            },
          }
        }
        const sameTurn = state.turn !== null && state.turn.id === turn
        return {
          ...state,
          last: sample,
          turn: sameTurn
            ? {
                ...state.turn!,
                hitCost: state.turn!.hitCost + current.hit,
                missCost: state.turn!.missCost + current.miss,
                outputCost: state.turn!.outputCost + current.output,
                inputTokens: state.turn!.inputTokens + sampleInputTokens,
                cacheReadTokens: state.turn!.cacheReadTokens + sample.cacheReadTokens,
                outputTokens: state.turn!.outputTokens + sample.outputTokens,
              }
            : {
                id: turn,
                hitCost: current.hit,
                missCost: current.miss,
                outputCost: current.output,
                inputTokens: sampleInputTokens,
                cacheReadTokens: sample.cacheReadTokens,
                outputTokens: sample.outputTokens,
              },
          totals: {
            cacheHitCost: state.totals.cacheHitCost + current.hit,
            missCost: state.totals.missCost + current.miss,
            outputCost: state.totals.outputCost + current.output,
            inputTokens: state.totals.inputTokens + sampleInputTokens,
            cacheReadTokens: state.totals.cacheReadTokens + sample.cacheReadTokens,
            outputTokens: state.totals.outputTokens + sample.outputTokens,
            rounds: state.totals.rounds + 1,
            missSteps: state.totals.missSteps + (writeMiss ? 1 : 0),
            writeTokens: state.totals.writeTokens + sample.cacheWriteTokens,
            fullMissSteps: state.totals.fullMissSteps + (fullMiss ? 1 : 0),
          },
        }
      },

      wire: {
        viewSchema: z.object({
          available: z.boolean(),
          /** 缓存命中部分花费 */
          cost: z.number().nonnegative(),
          /** 未命中输入含缓存写入花费 */
          missCost: z.number().nonnegative(),
          /** 输出花费 */
          outputCost: z.number().nonnegative(),
          currency: z.literal('CNY'),
          cacheReadTokens: z.number().int().nonnegative(),
          totalInputTokens: z.number().int().nonnegative(),
          /** 当前步输出 token */
          outputTokens: z.number().int().nonnegative(),
          hitRate: z.number().nullable(),
          model: z.string().nullable(),
          provider: z.string().nullable(),
          /** 计价模型显示名，恒为 DeepSeek-V4.1-Flash */
          matchedModel: z.string().nullable(),
          /** 实际模型名是否命中 Flash 白名单，false 即按 Flash 价估算 */
          modelMatched: z.boolean(),
          tier: z.enum(['peak', 'offPeak']).nullable(),
          unitPricePerM: z.number().nullable(),
          turn: z.number().int().nullable(),
          step: z.number().int().nullable(),
          /** 当前轮金额总额，命中加未命中加输出 */
          turnCost: z.number().nonnegative(),
          /** 当前轮缓存命中金额 */
          turnHitCost: z.number().nonnegative(),
          /** 当前轮未命中输入金额 */
          turnMissCost: z.number().nonnegative(),
          /** 当前轮输出金额 */
          turnOutputCost: z.number().nonnegative(),
          /** 当前轮 token 总额，输入加输出 */
          turnTokens: z.number().int().nonnegative(),
          /** 当前轮缓存命中 token 累计 */
          turnCacheReadTokens: z.number().int().nonnegative(),
          /** 当前轮输入 token 累计，命中加未命中加写入 */
          turnInputTokens: z.number().int().nonnegative(),
          /** 当前轮 输出 token 累计 */
          turnOutputTokens: z.number().int().nonnegative(),
          /** 会话累计输入 token 总额，命中加未命中加写入 */
          sessionInputTokens: z.number().int().nonnegative(),
          /** 会话累计：缓存命中 token 总额 */
          sessionCacheReadTokens: z.number().int().nonnegative(),
          /** 会话累计：输出 token 总额 */
          sessionOutputTokens: z.number().int().nonnegative(),
          /** 会话累计：缓存命中金额 */
          sessionCacheHitCost: z.number().nonnegative(),
          /** 会话累计：未命中金额 */
          sessionMissCost: z.number().nonnegative(),
          /** 会话累计：输出金额 */
          sessionOutputCost: z.number().nonnegative(),
          /** 会话累计：已有用量的轮数 */
          sessionRounds: z.number().int().nonnegative(),
          /** 会话累计缓存失效 step 数，发生过缓存写入，仅部分中转有值 */
          sessionMissSteps: z.number().int().nonnegative(),
          /** 会话累计缓存写入 token 量，同上 */
          sessionWriteTokens: z.number().int().nonnegative(),
          /** 会话累计完全失效 step 数，有输入但缓存命中为 0，任何路由都可靠 */
          sessionFullMissSteps: z.number().int().nonnegative(),
        }),
        view: (state: ProjectionState) => {
          const s = state.last
          const sessionTotals = state.totals
          if (s === null) {
            return {
              available: false,
              cost: 0,
              missCost: 0,
              outputCost: 0,
              currency: 'CNY' as const,
              cacheReadTokens: 0,
              totalInputTokens: 0,
              outputTokens: 0,
              hitRate: null,
              model: state.model,
              provider: state.provider,
              matchedModel: null,
              modelMatched: false,
              tier: null,
              unitPricePerM: null,
              turn: null,
              step: null,
              turnCost: 0,
              turnHitCost: 0,
              turnMissCost: 0,
              turnOutputCost: 0,
              turnTokens: 0,
              turnCacheReadTokens: 0,
              turnInputTokens: 0,
              turnOutputTokens: 0,
              sessionCacheHitCost: sessionTotals.cacheHitCost,
              sessionMissCost: sessionTotals.missCost,
              sessionOutputCost: sessionTotals.outputCost,
              sessionInputTokens: sessionTotals.inputTokens,
              sessionCacheReadTokens: sessionTotals.cacheReadTokens,
              sessionOutputTokens: sessionTotals.outputTokens,
              sessionRounds: sessionTotals.rounds,
              sessionMissSteps: sessionTotals.missSteps,
              sessionWriteTokens: sessionTotals.writeTokens,
              sessionFullMissSteps: sessionTotals.fullMissSteps,
            }
          }
          const totalInput = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens
          const { row, tier, matchedModel, matched } = rateOf(s.model, s.time)
          const cost = round9((s.cacheReadTokens * row.cacheHit) / 1e6)
          const missCost = round9(((s.inputTokens + s.cacheWriteTokens) * row.cacheMiss) / 1e6)
          const outputCost = round9((s.outputTokens * row.output) / 1e6)
          const turn = state.turn
          return {
            available: totalInput > 0 || s.outputTokens > 0,
            cost,
            missCost,
            outputCost,
            currency: 'CNY' as const,
            cacheReadTokens: s.cacheReadTokens,
            totalInputTokens: totalInput,
            outputTokens: s.outputTokens,
            hitRate:
              totalInput > 0 ? Math.round((s.cacheReadTokens / totalInput) * 1000) / 10 : null,
            model: s.model,
            provider: s.provider,
            matchedModel,
            modelMatched: matched,
            tier,
            unitPricePerM: row.cacheHit,
            turn: s.turn,
            step: s.step,
            turnCost:
              turn === null ? 0 : turn.hitCost + turn.missCost + turn.outputCost,
            turnHitCost: turn === null ? 0 : turn.hitCost,
            turnMissCost: turn === null ? 0 : turn.missCost,
            turnOutputCost: turn === null ? 0 : turn.outputCost,
            turnTokens: turn === null ? 0 : turn.inputTokens + turn.outputTokens,
            turnCacheReadTokens: turn === null ? 0 : turn.cacheReadTokens,
            turnInputTokens: turn === null ? 0 : turn.inputTokens,
            turnOutputTokens: turn === null ? 0 : turn.outputTokens,
            sessionCacheHitCost: sessionTotals.cacheHitCost,
            sessionMissCost: sessionTotals.missCost,
            sessionOutputCost: sessionTotals.outputCost,
            sessionInputTokens: sessionTotals.inputTokens,
            sessionCacheReadTokens: sessionTotals.cacheReadTokens,
            sessionOutputTokens: sessionTotals.outputTokens,
            sessionRounds: sessionTotals.rounds,
            sessionMissSteps: sessionTotals.missSteps,
            sessionWriteTokens: sessionTotals.writeTokens,
            sessionFullMissSteps: sessionTotals.fullMissSteps,
          }
        },
      },
    })
  })
}
