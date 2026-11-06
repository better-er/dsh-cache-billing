/**
 * 峰谷时段规则：host 记账与客户端圆环着色共用这一份，避免两处各写一套判定。
 *
 * 政策：周末与中国法定节假日全天谷价，只有工作日有峰价，峰段为北京时间
 * 09:00–12:00、14:00–18:00。判定纯 UTC+8 数学换算，与系统时区无关。
 */

/**
 * 中国法定节假日放假日名单，北京时间 YYYY-MM-DD。2026 年国务院放假安排共 33 天，取自 github.com/NateScarlet/holiday-cn。
 * 只收放假日，不收调休补班的周末——周末本就全天谷价，补班与否不影响判定。
 * 只内置 2026 年；新年度安排公布后在此补日期。表外年份退化为只认周末，与未加节假日前的行为一致。
 */
export const HOLIDAYS_2026: ReadonlySet<string> = new Set([
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
export function isPeakBeijing(timeMs: number): boolean {
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
