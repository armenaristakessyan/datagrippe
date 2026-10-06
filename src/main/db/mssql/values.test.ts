import { describe, expect, it } from 'vitest'
import { normalizeValue, typeInfoFromTedious, type SqlTypeInfo } from './values'

function withNanos(iso: string, nanosecondsDelta: number): Date {
  const date = new Date(iso)
  Object.defineProperty(date, 'nanosecondsDelta', { value: nanosecondsDelta, enumerable: false })
  return date
}

const type = (name: string, scale?: number): SqlTypeInfo => ({ name, scale })

describe('typeInfoFromTedious', () => {
  it('maps tedious type names to SQL Server type names', () => {
    expect(typeInfoFromTedious({ type: { name: 'IntN' }, dataLength: 8 }).name).toBe('bigint')
    expect(typeInfoFromTedious({ type: { name: 'IntN' }, dataLength: 1 }).name).toBe('tinyint')
    expect(typeInfoFromTedious({ type: { name: 'FloatN' }, dataLength: 4 }).name).toBe('real')
    expect(typeInfoFromTedious({ type: { name: 'MoneyN' }, dataLength: 4 }).name).toBe('smallmoney')
    expect(typeInfoFromTedious({ type: { name: 'DateTimeN' }, dataLength: 4 }).name).toBe('smalldatetime')
    expect(typeInfoFromTedious({ type: { name: 'DateTime2' }, scale: 3 })).toEqual({ name: 'datetime2', scale: 3 })
    expect(typeInfoFromTedious({ type: { name: 'DecimalN' }, scale: 2 })).toEqual({ name: 'decimal', scale: 2 })
    expect(typeInfoFromTedious({ type: { name: 'Binary' }, userType: 80 }).name).toBe('timestamp')
    expect(typeInfoFromTedious({ type: { name: 'Binary' }, userType: 0 }).name).toBe('binary')
    expect(typeInfoFromTedious({ type: { name: 'UDT' }, udtInfo: { typeName: 'HierarchyId' } }).name).toBe('hierarchyid')
    expect(typeInfoFromTedious({ type: { name: 'Variant' } }).name).toBe('sql_variant')
    expect(typeInfoFromTedious({ type: { name: 'NVarChar' } }).name).toBe('nvarchar')
  })
})

describe('normalizeValue', () => {
  it('keeps booleans, small numbers and NULL', () => {
    expect(normalizeValue(true, type('bit'))).toBe(true)
    expect(normalizeValue(42, type('int'))).toBe(42)
    expect(normalizeValue(1.5, type('float'))).toBe(1.5)
    expect(normalizeValue(null, type('int'))).toBeNull()
    expect(normalizeValue(undefined, type('int'))).toBeNull()
  })

  it('renders exact numerics as strings', () => {
    expect(normalizeValue('123.45', type('decimal', 2))).toBe('123.45')
    expect(normalizeValue(12.5, type('decimal', 2))).toBe('12.50')
    expect(normalizeValue(1e21, type('numeric', 0))).toBe('1000000000000000000000')
    expect(normalizeValue(-42.0001, type('money'))).toBe('-42.0001')
    expect(normalizeValue('9223372036854775807', type('bigint'))).toBe('9223372036854775807')
    expect(normalizeValue(10n, type('bigint'))).toBe('10')
  })

  it('formats temporal values with the column scale and 100 ns precision', () => {
    const d = withNanos('2024-01-15T10:30:00.123Z', 0.0004567)
    expect(normalizeValue(d, type('datetime2', 7))).toBe('2024-01-15 10:30:00.1234567')
    expect(normalizeValue(d, type('datetime2', 3))).toBe('2024-01-15 10:30:00.123')
    expect(normalizeValue(d, type('datetime2', 0))).toBe('2024-01-15 10:30:00')
    expect(normalizeValue(new Date('2024-01-15T00:00:00Z'), type('date'))).toBe('2024-01-15')
    expect(normalizeValue(withNanos('1970-01-01T23:59:59.999Z', 0.0009999), type('time', 7))).toBe('23:59:59.9999999')
    expect(normalizeValue(new Date('2024-05-06T07:08:09.997Z'), type('datetime'))).toBe('2024-05-06 07:08:09.997')
    expect(normalizeValue(new Date('2024-05-06T07:08:00Z'), type('smalldatetime'))).toBe('2024-05-06 07:08:00')
    expect(normalizeValue(withNanos('2024-01-15T08:30:00.123Z', 0), type('datetimeoffset', 3))).toBe('2024-01-15 08:30:00.123 +00:00')
    const ancient = new Date(0)
    ancient.setUTCFullYear(1, 0, 1)
    expect(normalizeValue(ancient, type('date'))).toBe('0001-01-01')
  })

  it('upper-cases GUIDs and hex-encodes binary', () => {
    expect(normalizeValue('6f9619ff-8b86-d011-b42d-00c04fc964ff', type('uniqueidentifier'))).toBe('6F9619FF-8B86-D011-B42D-00C04FC964FF')
    expect(normalizeValue(Buffer.from([0x01, 0xab, 0xff]), type('varbinary'))).toBe('0x01ABFF')
    expect(normalizeValue(Buffer.alloc(0), type('varbinary'))).toBe('0x')
    expect(normalizeValue(Buffer.from([0, 0, 0, 0, 0, 0, 0x07, 0xd1]), type('timestamp'))).toBe('0x00000000000007D1')
  })

  it('renders sql_variant values as text', () => {
    expect(normalizeValue(42, type('sql_variant'))).toBe('42')
    expect(normalizeValue('abc', type('sql_variant'))).toBe('abc')
    expect(normalizeValue(true, type('sql_variant'))).toBe('1')
  })
})
