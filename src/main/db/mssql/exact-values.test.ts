import { describe, expect, it } from 'vitest'
import {
  decodeDateTimeOffset,
  decodeDecimal,
  decodeMoney,
  formatDayNumber,
  formatOffset,
  formatScaled,
  formatTimeOfDay,
  plainNumber,
} from './exact-values'

function decimalBytes(value: bigint, length: 4 | 8 | 12 | 16): Uint8Array {
  const bytes = new Uint8Array(1 + length)
  bytes[0] = value < 0n ? 0 : 1
  let magnitude = value < 0n ? -value : value
  for (let i = 1; i <= length; i++) {
    bytes[i] = Number(magnitude & 0xffn)
    magnitude >>= 8n
  }
  return bytes
}

function moneyBytes(units: bigint): Uint8Array {
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  const unsigned = BigInt.asUintN(64, units)
  view.setInt32(0, Number(BigInt.asIntN(32, unsigned >> 32n)), true)
  view.setUint32(4, Number(unsigned & 0xffffffffn), true)
  return new Uint8Array(buffer)
}

describe('formatScaled', () => {
  it('inserts the decimal point and pads', () => {
    expect(formatScaled(12345n, 2)).toBe('123.45')
    expect(formatScaled(5n, 3)).toBe('0.005')
    expect(formatScaled(-5n, 3)).toBe('-0.005')
    expect(formatScaled(42n, 0)).toBe('42')
    expect(formatScaled(0n, 2)).toBe('0.00')
  })
})

describe('decodeDecimal', () => {
  it('keeps every digit of decimal(38,10)', () => {
    const value = 12345678901234567890123456781234567891n
    expect(decodeDecimal(decimalBytes(value, 16), 10)).toBe('1234567890123456789012345678.1234567891')
    expect(decodeDecimal(decimalBytes(-1n, 16), 10)).toBe('-0.0000000001')
  })

  it('handles every storage size and never prints negative zero', () => {
    expect(decodeDecimal(decimalBytes(150050n, 4), 2)).toBe('1500.50')
    expect(decodeDecimal(decimalBytes(9007199254740993n, 8), 0)).toBe('9007199254740993')
    expect(decodeDecimal(decimalBytes(-(10n ** 27n), 12), 3)).toBe('-1000000000000000000000000.000')
    const zero = decimalBytes(0n, 4)
    zero[0] = 0
    expect(decodeDecimal(zero, 2)).toBe('0.00')
  })
})

describe('decodeMoney', () => {
  it('decodes money extremes exactly', () => {
    expect(decodeMoney(moneyBytes(9223372036854775807n))).toBe('922337203685477.5807')
    expect(decodeMoney(moneyBytes(-9223372036854775808n))).toBe('-922337203685477.5808')
    expect(decodeMoney(moneyBytes(-420001n))).toBe('-42.0001')
  })

  it('decodes smallmoney', () => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setInt32(0, -2147483648, true)
    expect(decodeMoney(bytes)).toBe('-214748.3648')
  })
})

describe('date/time helpers', () => {
  it('formats time of day with the requested scale', () => {
    expect(formatTimeOfDay(0, 0)).toBe('00:00:00')
    expect(formatTimeOfDay(863_999_999_999, 7)).toBe('23:59:59.9999999')
    expect(formatTimeOfDay(10_000_000 * 61 + 1_234_567, 3)).toBe('00:01:01.123')
  })

  it('formats day numbers since 0001-01-01', () => {
    expect(formatDayNumber(0)).toBe('0001-01-01')
    expect(formatDayNumber(730119)).toBe('2000-01-01')
    expect(formatDayNumber(3652058)).toBe('9999-12-31')
  })

  it('formats offsets', () => {
    expect(formatOffset(120)).toBe('+02:00')
    expect(formatOffset(-330)).toBe('-05:30')
    expect(formatOffset(0)).toBe('+00:00')
  })
})

describe('decodeDateTimeOffset', () => {
  function dto(utcTicks: number, days: number, offset: number, scale: number): Uint8Array {
    const timeLength = scale <= 2 ? 3 : scale <= 4 ? 4 : 5
    const bytes = new Uint8Array(timeLength + 5)
    let units = Math.round(utcTicks / 10 ** (7 - scale))
    for (let i = 0; i < timeLength; i++) {
      bytes[i] = units % 256
      units = Math.floor(units / 256)
    }
    bytes[timeLength] = days & 0xff
    bytes[timeLength + 1] = (days >> 8) & 0xff
    bytes[timeLength + 2] = (days >> 16) & 0xff
    new DataView(bytes.buffer).setInt16(timeLength + 3, offset, true)
    return bytes
  }

  it('renders the local time in the stored offset', () => {
    // 2024-01-15 08:30:00.1234567 UTC stored with +02:00
    const ticks = (8 * 3600 + 30 * 60) * 10_000_000 + 1_234_567
    expect(decodeDateTimeOffset(dto(ticks, 738899, 120, 7), 7)).toBe('2024-01-15 10:30:00.1234567 +02:00')
  })

  it('crosses day boundaries in both directions', () => {
    // 2022-02-03 05:00 UTC at -05:30 → 2022-02-02 23:30 local
    expect(decodeDateTimeOffset(dto(5 * 3600 * 10_000_000, 738188, -330, 0), 0)).toBe('2022-02-02 23:30:00 -05:30')
    // 2024-02-29 23:00 UTC at +14:00 → 2024-03-01 13:00 local
    expect(decodeDateTimeOffset(dto(23 * 3600 * 10_000_000, 738944, 840, 1), 1)).toBe('2024-03-01 13:00:00.0 +14:00')
  })
})

describe('plainNumber', () => {
  it('never uses exponent notation', () => {
    expect(plainNumber(1e21)).toBe('1000000000000000000000')
    expect(plainNumber(1.5e-7)).toBe('0.00000015')
    expect(plainNumber(12.5, 2)).toBe('12.50')
    expect(plainNumber(-3)).toBe('-3')
  })
})

describe('float32Number', () => {
  it('returns the shortest decimal that is the same float32', async () => {
    const { float32Number } = await import('./exact-values')
    expect(float32Number(Math.fround(0.1))).toBe(0.1)
    expect(float32Number(Math.fround(3.3))).toBe(3.3)
    expect(float32Number(Math.fround(16_777_217))).toBe(16_777_216)
    expect(float32Number(Math.fround(-1.5e-30))).toBe(-1.5e-30)
    expect(float32Number(0)).toBe(0)
    // Not a float32: unchanged
    expect(float32Number(0.1)).toBe(0.1)
  })
})

describe('decodeVariant', () => {
  const variant = (baseType: number, props: number[], value: number[]): Uint8Array =>
    Uint8Array.from([baseType, props.length, ...props, ...value])
  const le = (value: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => Math.floor(value / 256 ** i) % 256)

  it('decodes exact numbers and date / time base types', async () => {
    const { decodeVariant, formatDayNumber } = await import('./exact-values')
    expect(decodeVariant(variant(106, [38, 2], [1, ...le(12345, 16)]))).toBe('123.45')
    expect(decodeVariant(variant(60, [], [0, 0, 0, 0, ...le(1_234_567, 4)]))).toBe('123.4567')
    // date: days since 0001-01-01
    const day = 738_886 // 2024-01-02
    expect(formatDayNumber(day)).toBe('2024-01-02')
    expect(decodeVariant(variant(40, [], le(day, 3)))).toBe('2024-01-02')
    const ticks = ((12 * 60 + 34) * 60 + 56) * 10_000_000 + 1_234_567
    expect(decodeVariant(variant(41, [7], le(ticks, 5)))).toBe('12:34:56.1234567')
    expect(decodeVariant(variant(42, [7], [...le(ticks, 5), ...le(day, 3)]))).toBe('2024-01-02 12:34:56.1234567')
    // datetime: days since 1900-01-01 + 1/300 s; smalldatetime: days + minutes
    expect(decodeVariant(variant(61, [], [...le(45_291, 4), ...le(299, 4)]))).toBe('2024-01-02 00:00:00.997')
    expect(decodeVariant(variant(58, [], [...le(45_291, 2), ...le(61, 2)]))).toBe('2024-01-02 01:01:00')
    const real = new Uint8Array(4)
    new DataView(real.buffer).setFloat32(0, 0.1, true)
    expect(decodeVariant(variant(59, [], [...real]))).toBe('0.1')
    // int / nvarchar…: left to tedious
    expect(decodeVariant(variant(56, [], le(5, 4)))).toBeUndefined()
  })
})
