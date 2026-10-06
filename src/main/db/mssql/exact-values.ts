// Exact decoders for TDS values that tedious converts lossily (decimal/numeric/money → JS number,
// datetimeoffset → Date without its offset, sql_variant date/time types → Date). Inputs are the raw
// value bytes, without length prefix.

const TICKS_PER_DAY = 864_000_000_000 // 100 ns units
const TICKS_PER_MINUTE = 600_000_000
const MS_PER_DAY = 86_400_000
/** Days from 0001-01-01 to 1900-01-01 (the datetime / smalldatetime epoch). */
const DAYS_TO_1900 = 693_595

/** Magnitude stored little-endian over 4, 8, 12 or 16 bytes. */
function readUnsignedLE(bytes: Uint8Array): bigint {
  let value = 0n
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i] ?? 0)
  return value
}

/** Render an integer scaled by 10^-scale as a plain decimal string ("-12.50"). */
export function formatScaled(value: bigint, scale: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString()
  if (scale <= 0) return (negative ? '-' : '') + digits
  const padded = digits.padStart(scale + 1, '0')
  const text = `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
  return negative ? `-${text}` : text
}

/** DECIMALN / NUMERICN payload: 1 sign byte (1 = positive) + unsigned magnitude. */
export function decodeDecimal(bytes: Uint8Array, scale: number): string {
  const positive = bytes[0] === 1
  const magnitude = readUnsignedLE(bytes.subarray(1))
  return formatScaled(positive || magnitude === 0n ? magnitude : -magnitude, scale)
}

/** money (8 bytes: signed high dword, then low dword) or smallmoney (4 bytes, signed), 4 decimals. */
export function decodeMoney(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength === 4) return formatScaled(BigInt(view.getInt32(0, true)), 4)
  const high = BigInt(view.getInt32(0, true))
  const low = BigInt(view.getUint32(4, true))
  return formatScaled((high << 32n) + low, 4)
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0')

/** "HH:mm:ss[.fffffff]" from 100 ns ticks since midnight, keeping `scale` fractional digits. */
export function formatTimeOfDay(ticks: number, scale: number): string {
  const totalSeconds = Math.floor(ticks / 10_000_000)
  const fraction = ticks - totalSeconds * 10_000_000
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const base = `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`
  return scale > 0 ? `${base}.${pad(fraction, 7).slice(0, scale)}` : base
}

/** "YYYY-MM-DD" from days since 0001-01-01 (proleptic Gregorian, as SQL Server stores them). */
export function formatDayNumber(days: number): string {
  const base = new Date(0)
  base.setUTCFullYear(1, 0, 1)
  const date = new Date(base.getTime() + days * MS_PER_DAY)
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`
}

/** "+hh:mm" / "-hh:mm" from an offset in minutes. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`
}

/**
 * DATETIMEOFFSETN payload: time (3–5 bytes, units of 10^-scale s, UTC) + days (3 bytes) + offset
 * minutes (int16). Rendered in the stored offset: "YYYY-MM-DD HH:mm:ss[.fffffff] +hh:mm".
 */
export function decodeDateTimeOffset(bytes: Uint8Array, scale: number): string {
  const timeLength = bytes.byteLength - 5
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let units = 0
  for (let i = timeLength - 1; i >= 0; i--) units = units * 256 + view.getUint8(i)
  const utcTicks = units * 10 ** (7 - scale)
  const days = view.getUint8(timeLength) | (view.getUint8(timeLength + 1) << 8) | (view.getUint8(timeLength + 2) << 16)
  const offsetMinutes = view.getInt16(timeLength + 3, true)

  let localTicks = utcTicks + offsetMinutes * TICKS_PER_MINUTE
  let localDays = days
  while (localTicks < 0) {
    localTicks += TICKS_PER_DAY
    localDays -= 1
  }
  while (localTicks >= TICKS_PER_DAY) {
    localTicks -= TICKS_PER_DAY
    localDays += 1
  }
  return `${formatDayNumber(localDays)} ${formatTimeOfDay(localTicks, scale)} ${formatOffset(offsetMinutes)}`
}

/** Plain (non-exponential) rendering of a JS number, used when exact decoding is unavailable. */
export function plainNumber(value: number, scale?: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (Math.abs(value) < 1e21) {
    if (scale !== undefined && scale >= 0 && scale <= 100) return value.toFixed(scale)
    const text = String(value)
    if (!/e/i.test(text)) return text
    return value.toFixed(20).replace(/\.?0+$/, '')
  }
  const integer = BigInt(Math.round(value)).toString()
  return scale ? `${integer}.${'0'.repeat(Math.min(scale, 100))}` : integer
}

/** Shortest decimal that reads back as the same float32 (`real`): 0.1 instead of 0.10000000149011612. */
export function float32Number(value: number): number {
  if (!Number.isFinite(value) || value === 0) return value
  if (Math.fround(value) !== value) return value
  for (let digits = 1; digits <= 9; digits++) {
    const candidate = Number(value.toPrecision(digits))
    if (Math.fround(candidate) === value) return candidate
  }
  return value
}

function readUnsignedNumber(bytes: Uint8Array): number {
  let value = 0
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256 + (bytes[i] ?? 0)
  return value
}

/** TDS base type ids of sql_variant values decoded exactly here. */
const VARIANT = {
  date: 40,
  time: 41,
  datetime2: 42,
  datetimeoffset: 43,
  smalldatetime: 58,
  real: 59,
  money: 60,
  datetime: 61,
  decimalN: 106,
  numericN: 108,
  smallmoney: 122,
} as const

/**
 * sql_variant payload (after its 4-byte length): base type, property byte count, properties, value.
 * Returns the value rendered as SQL Server shows it, or undefined for base types tedious already
 * decodes exactly (integers, strings, binary, uniqueidentifier, float).
 */
export function decodeVariant(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 2) return undefined
  const baseType = bytes[0]
  const propBytes = bytes[1] ?? 0
  const props = bytes.subarray(2, 2 + propBytes)
  const value = bytes.subarray(2 + propBytes)
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  switch (baseType) {
    case VARIANT.decimalN:
    case VARIANT.numericN:
      return decodeDecimal(value, props[1] ?? 0)
    case VARIANT.money:
    case VARIANT.smallmoney:
      return decodeMoney(value)
    case VARIANT.date:
      return formatDayNumber(readUnsignedNumber(value.subarray(0, 3)))
    case VARIANT.time: {
      const scale = props[0] ?? 7
      return formatTimeOfDay(readUnsignedNumber(value) * 10 ** (7 - scale), scale)
    }
    case VARIANT.datetime2: {
      const scale = props[0] ?? 7
      const timeLength = value.byteLength - 3
      const ticks = readUnsignedNumber(value.subarray(0, timeLength)) * 10 ** (7 - scale)
      const days = readUnsignedNumber(value.subarray(timeLength))
      return `${formatDayNumber(days)} ${formatTimeOfDay(ticks, scale)}`
    }
    case VARIANT.datetimeoffset:
      return decodeDateTimeOffset(value, props[0] ?? 7)
    case VARIANT.datetime: {
      if (value.byteLength < 8) return undefined
      const days = view.getInt32(0, true)
      const ms = Math.round((view.getInt32(4, true) * 10) / 3)
      return `${formatDayNumber(DAYS_TO_1900 + days)} ${formatTimeOfDay(ms * 10_000, 3)}`
    }
    case VARIANT.smalldatetime: {
      if (value.byteLength < 4) return undefined
      const minutes = view.getUint16(2, true)
      return `${formatDayNumber(DAYS_TO_1900 + view.getUint16(0, true))} ${formatTimeOfDay(minutes * TICKS_PER_MINUTE, 0)}`
    }
    case VARIANT.real:
      return value.byteLength === 4 ? String(float32Number(view.getFloat32(0, true))) : undefined
    default:
      return undefined
  }
}
