import type { TimeSlot } from '../types'
import { worldCalendarDate, type WorldCalendarDate } from './worldCalendar'

export type WeatherKind =
  | 'sunny'
  | 'cloudy'
  | 'lightRain'
  | 'showers'
  | 'thunderstorm'
  | 'fog'
  | 'strongWind'
  | 'lightSnow'
  | 'heavySnow'

export type TemperatureBand = '寒冷' | '凉爽' | '温和' | '暖热' | '炎热'

export interface SeasonRule {
  climate: string
  outdoorRule: string
  clothingRule: string
  seasonalDetail: string
}

export interface WorldWeatherSnapshot {
  worldDay: number
  slot: TimeSlot
  calendar: WorldCalendarDate
  kind: WeatherKind
  label: string
  icon: string
  temperature: TemperatureBand
  description: string
  outdoorRule: string
  clothingRule: string
  seasonalDetail: string
}

type WeightedWeather = readonly [WeatherKind, number]

export const SEASON_RULES: Record<WorldCalendarDate['season'], SeasonRule> = {
  春季: {
    climate: '气温回升，晴阴交替，小雨和阵雨较常见。',
    outdoorRule: '户外活动通常可行；下雨时应自然转向有遮挡处或准备雨具。',
    clothingRule: '早晚偏凉，可使用薄外套；雨天可增加雨具，不必夸张换装。',
    seasonalDetail: '植物返青、花期与潮湿空气可以作为少量背景细节。',
  },
  夏季: {
    climate: '整体暖热，晴天、阵雨和雷雨较多。',
    outdoorRule: '炎热白天减少长时间暴晒；雷雨时避免无必要的露天停留。',
    clothingRule: '以轻薄衣着为主；降雨只在确有需要时增加雨具。',
    seasonalDetail: '强光、树荫、蝉鸣与雨后湿气可以作为少量背景细节。',
  },
  秋季: {
    climate: '天气转凉，晴朗和多云较多，偶有秋雨、雾与大风。',
    outdoorRule: '多数户外活动正常；风雨时注意避风和路面湿滑。',
    clothingRule: '随季节深入逐渐增加外套，不要因为单个时段反复换装。',
    seasonalDetail: '干爽空气、落叶和较早的暮色可以作为少量背景细节。',
  },
  冬季: {
    climate: '整体寒冷，晴冷、阴天与降雪交替。',
    outdoorRule: '户外活动应考虑寒冷和积雪；大雪时优先选择安全、有遮挡的活动。',
    clothingRule: '外出通常需要保暖外套和合适鞋袜；室内不必持续强调厚重衣物。',
    seasonalDetail: '冷空气、结霜、呼气白雾与积雪可以作为少量背景细节。',
  },
}

const WEATHER_WEIGHTS: Record<WorldCalendarDate['season'], WeightedWeather[]> = {
  春季: [['sunny', 27], ['cloudy', 24], ['lightRain', 25], ['showers', 15], ['thunderstorm', 4], ['fog', 5]],
  夏季: [['sunny', 39], ['cloudy', 15], ['lightRain', 5], ['showers', 20], ['thunderstorm', 17], ['strongWind', 4]],
  秋季: [['sunny', 38], ['cloudy', 25], ['lightRain', 14], ['showers', 5], ['fog', 11], ['strongWind', 7]],
  冬季: [['sunny', 35], ['cloudy', 27], ['lightSnow', 21], ['heavySnow', 7], ['fog', 6], ['strongWind', 4]],
}

const WEATHER_ICONS: Record<WeatherKind, string> = {
  sunny: '☀️', cloudy: '☁️', lightRain: '🌧️', showers: '🌦️', thunderstorm: '⛈️',
  fog: '🌫️', strongWind: '💨', lightSnow: '🌨️', heavySnow: '❄️',
}

function hash01(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  hash ^= hash >>> 16
  return (hash >>> 0) / 4294967296
}

function weightedPick(rows: WeightedWeather[], value: number): WeatherKind {
  const total = rows.reduce((sum, [, weight]) => sum + weight, 0)
  let cursor = value * total
  for (const [kind, weight] of rows) {
    cursor -= weight
    if (cursor < 0) return kind
  }
  return rows.at(-1)?.[0] ?? 'sunny'
}

/** A three-day weather front gives adjacent days continuity without mutable
 * random state. A daily roll still allows a front to briefly break. */
export function dailyWeatherKind(seed: string, worldDay: number): WeatherKind {
  const day = Math.max(1, Math.floor(worldDay))
  const calendar = worldCalendarDate(day)
  const rows = WEATHER_WEIGHTS[calendar.season]
  const front = Math.floor((day - 1) / 3)
  const dominant = weightedPick(rows, hash01(`${seed}:weather-front:${calendar.year}:${calendar.season}:${front}`))
  const breakRoll = hash01(`${seed}:weather-break:${day}`)
  return breakRoll < 0.72 ? dominant : weightedPick(rows, hash01(`${seed}:weather-day:${day}`))
}

function slotWeather(kind: WeatherKind, slot: TimeSlot, seed: string, day: number): { label: string; description: string } {
  if (kind === 'sunny') return slot === 'night'
    ? { label: '晴夜', description: '天空晴朗，夜间视野清晰。' }
    : slot === 'evening'
      ? { label: '晴间少云', description: '云量很少，天色正逐渐转暗。' }
      : { label: '晴朗', description: '天空晴朗，光照稳定。' }
  if (kind === 'cloudy') return { label: slot === 'night' ? '多云夜间' : '多云', description: '云层较多，但没有明显降水。' }
  if (kind === 'lightRain') return { label: '小雨', description: '持续的小雨让户外地面保持湿润。' }
  if (kind === 'lightSnow') return { label: '小雪', description: '有持续但不强的降雪，户外较冷。' }
  if (kind === 'heavySnow') return { label: '大雪', description: '降雪明显，户外能见度和通行条件变差。' }
  if (kind === 'strongWind') return { label: slot === 'night' ? '风势渐弱' : '大风', description: slot === 'night' ? '夜间仍有明显风声，但风势正在减弱。' : '风力较强，开阔地点体感更明显。' }
  if (kind === 'fog') return slot === 'morning'
    ? { label: '有雾', description: '雾气降低了户外能见度。' }
    : { label: '阴转多云', description: '早先的雾气已经散去，云层仍然较多。' }
  const activeIndex = Math.floor(hash01(`${seed}:${kind}:${day}:active-slot`) * 2) + 1
  const slotIndex = ['morning', 'day', 'evening', 'night'].indexOf(slot)
  if (kind === 'showers') return slotIndex === activeIndex
    ? { label: '阵雨', description: '本时段出现一阵较明显的降雨。' }
    : { label: slotIndex < activeIndex ? '多云，可能有雨' : '雨后多云', description: slotIndex < activeIndex ? '云层增厚，稍后可能出现阵雨。' : '阵雨已经过去，地面仍然湿润。' }
  return slotIndex === activeIndex
    ? { label: '雷雨', description: '本时段有明显雷雨，不适合无必要的露天停留。' }
    : { label: slotIndex < activeIndex ? '闷热多云' : '雷雨后多云', description: slotIndex < activeIndex ? '空气闷热，雷雨正在接近。' : '雷雨已经过去，空气仍然潮湿。' }
}

function temperatureFor(calendar: WorldCalendarDate, slot: TimeSlot, kind: WeatherKind): TemperatureBand {
  const weatherDelta = ['lightRain', 'showers', 'thunderstorm', 'fog', 'strongWind', 'lightSnow', 'heavySnow'].includes(kind) ? -1 : 0
  const seasonAndSlot = calendar.season === '冬季'
    ? 0
    : calendar.season === '夏季'
      ? (slot === 'day' ? 4 : 3)
      : calendar.season === '春季'
        ? (slot === 'night' || slot === 'morning' ? 1 : 2)
        : calendar.seasonDay <= 15
          ? (slot === 'day' ? 2 : 1)
          : (slot === 'day' ? 1 : 0)
  const value = Math.max(0, Math.min(4, seasonAndSlot + weatherDelta))
  return (['寒冷', '凉爽', '温和', '暖热', '炎热'] as const)[value]
}

export function weatherForWorld(seed: string, worldDay: number, slot: TimeSlot): WorldWeatherSnapshot {
  const calendar = worldCalendarDate(worldDay)
  const kind = dailyWeatherKind(seed || 'default-world-weather', worldDay)
  const current = slotWeather(kind, slot, seed || 'default-world-weather', calendar.absoluteDay)
  const seasonRule = SEASON_RULES[calendar.season]
  return {
    worldDay: calendar.absoluteDay,
    slot,
    calendar,
    kind,
    label: current.label,
    icon: WEATHER_ICONS[kind],
    temperature: temperatureFor(calendar, slot, kind),
    description: current.description,
    outdoorRule: seasonRule.outdoorRule,
    clothingRule: seasonRule.clothingRule,
    seasonalDetail: seasonRule.seasonalDetail,
  }
}

export function formatWeatherForModel(weather: WorldWeatherSnapshot): string {
  return `${weather.calendar.season} · ${weather.label} · 体感${weather.temperature}。${weather.description}${weather.outdoorRule}${weather.clothingRule}${weather.seasonalDetail}天气是代码确定的世界硬状态，不得擅自改成其他天气，也不要每句话都刻意提及。`
}
