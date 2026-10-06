import { describe, expect, it } from 'vitest'
import { defaultMultirangeName, identityOptions, rangeOptions } from './ddl'

describe('identityOptions', () => {
  const int4 = 23
  const defaults = { start: '1', increment: '1', min: '1', max: '2147483647', cache: '1', cycle: false }

  it('omits options that match the defaults', () => {
    expect(identityOptions(defaults, int4)).toBe('')
    expect(identityOptions(null, int4)).toBe('')
    expect(identityOptions({ ...defaults, max: '9223372036854775807' }, 20)).toBe('')
  })

  it('lists the options that differ', () => {
    expect(identityOptions({ ...defaults, start: '100', increment: '5' }, int4)).toBe(' (START WITH 100 INCREMENT BY 5)')
    expect(identityOptions({ ...defaults, min: '10', start: '10', cache: '20', cycle: true }, int4)).toBe(' (MINVALUE 10 CACHE 20 CYCLE)')
    // Descending: defaults are MINVALUE = type minimum, MAXVALUE -1, START = MAXVALUE.
    expect(identityOptions({ start: '-1', increment: '-1', min: '-32768', max: '-1', cache: '1', cycle: false }, 21)).toBe(
      ' (INCREMENT BY -1)',
    )
  })
})

describe('range type options', () => {
  it('derives the default multirange name like PostgreSQL', () => {
    expect(defaultMultirangeName('fr')).toBe('fr_multirange')
    expect(defaultMultirangeName('floatrange')).toBe('floatmultirange')
    expect(defaultMultirangeName('rangex')).toBe('multirangex')
  })

  it('emits only non-default options', () => {
    expect(rangeOptions({ subtype: 'double precision', multirange: 's.fr_multirange', multirange_name: 'fr_multirange', multirange_same_schema: true }, 'fr')).toEqual([
      'SUBTYPE = double precision',
    ])
    expect(
      rangeOptions(
        {
          subtype: 'text',
          opclass: 's.text_ops2',
          collation: 'pg_catalog."C"',
          canonical: 's.canon',
          subtype_diff: 's.diff',
          multirange: 's.many',
          multirange_name: 'many',
          multirange_same_schema: true,
        },
        'tr',
      ),
    ).toEqual([
      'SUBTYPE = text',
      'SUBTYPE_OPCLASS = s.text_ops2',
      'COLLATION = pg_catalog."C"',
      'CANONICAL = s.canon',
      'SUBTYPE_DIFF = s.diff',
      'MULTIRANGE_TYPE_NAME = s.many',
    ])
  })
})
