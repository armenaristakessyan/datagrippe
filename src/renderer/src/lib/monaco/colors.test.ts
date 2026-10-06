import { describe, expect, it } from 'vitest'
import { cssColorToHex, tokenColor, withAlpha } from './colors'

describe('cssColorToHex', () => {
  it('normalises hex colours', () => {
    expect(cssColorToHex('#17191E')).toBe('#17191e')
    expect(cssColorToHex('#abc')).toBe('#aabbcc')
    expect(cssColorToHex('#abcd')).toBe('#aabbccdd')
    expect(cssColorToHex('#11223344')).toBe('#11223344')
  })

  it('converts modern and legacy rgb() syntaxes', () => {
    expect(cssColorToHex('rgb(255 255 255 / 0.045)')).toBe('#ffffff0b')
    expect(cssColorToHex('rgb(124 140 255 / 0.22)')).toBe('#7c8cff38')
    expect(cssColorToHex('rgba(15, 18, 24, 0.5)')).toBe('#0f121880')
    expect(cssColorToHex('rgb(15, 18, 24)')).toBe('#0f1218')
    expect(cssColorToHex('rgb(10 20 30 / 50%)')).toBe('#0a141e80')
    expect(cssColorToHex(' rgb(1 2 3 / 1) ')).toBe('#010203')
    expect(cssColorToHex('transparent')).toBe('#00000000')
  })

  it('rejects anything else', () => {
    expect(cssColorToHex('')).toBeNull()
    expect(cssColorToHex('var(--c-fg)')).toBeNull()
    expect(cssColorToHex('rgb(1 2)')).toBeNull()
    expect(cssColorToHex('#12345')).toBeNull()
  })
})

describe('helpers', () => {
  it('scales alpha and strips it for token colours', () => {
    expect(withAlpha('#7c8cff', 0.5)).toBe('#7c8cff80')
    expect(withAlpha('#7c8cff80', 0.5)).toBe('#7c8cff40')
    expect(tokenColor('#7c8cff80')).toBe('7c8cff')
  })
})
