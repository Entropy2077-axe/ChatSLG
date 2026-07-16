import { describe, expect, it } from 'vitest'
import { dailyWeatherKind, formatWeatherForModel, weatherForWorld } from './worldWeather'

describe('deterministic fictional weather', () => {
  it('is stable for the same world seed and day', () => {
    expect(dailyWeatherKind('same-world', 42)).toBe(dailyWeatherKind('same-world', 42))
    expect(weatherForWorld('same-world', 42, 'evening')).toEqual(weatherForWorld('same-world', 42, 'evening'))
  })

  it('uses seasonal weather tables', () => {
    const winterKinds = new Set(Array.from({ length: 30 }, (_, index) => dailyWeatherKind('winter-world', 91 + index)))
    expect([...winterKinds].every((kind) => !['lightRain', 'showers', 'thunderstorm'].includes(kind))).toBe(true)
    const summerKinds = new Set(Array.from({ length: 30 }, (_, index) => dailyWeatherKind('summer-world', 31 + index)))
    expect([...summerKinds].every((kind) => !['lightSnow', 'heavySnow'].includes(kind))).toBe(true)
  })

  it('exposes only fictional season and slot weather to a model', () => {
    const text = formatWeatherForModel(weatherForWorld('world', 31, 'day'))
    expect(text).toContain('夏季')
    expect(text).toContain('天气是代码确定的世界硬状态')
    expect(text).not.toMatch(/\d{1,2}:\d{2}/)
  })
})
