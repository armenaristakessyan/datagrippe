import { describe, expect, it } from 'vitest'
import { decodeEntities, findDescendants, firstChild, parseXml, XmlParseError } from './xml'

describe('parseXml', () => {
  it('parses elements, attributes, text and namespaces', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><a:Root xmlns:a="urn:x" A="1" b=\'two\'><Child>hi <b>there</b></Child><Empty /></a:Root>',
    )
    expect(root.name).toBe('a:Root')
    expect(root.local).toBe('Root')
    expect(root.attributes).toEqual({ 'xmlns:a': 'urn:x', A: '1', b: 'two' })
    expect(root.children.map((c) => c.local)).toEqual(['Child', 'Empty'])
    expect(firstChild(root, 'Child')?.text).toBe('hi ')
    expect(firstChild(root, 'Empty')?.children).toEqual([])
  })

  it('decodes entities in text and attributes, keeps CDATA verbatim', () => {
    const root = parseXml('<r v="a &lt;= b &amp;&amp; c &#x41;&#66;">x &gt; y<![CDATA[<raw>&amp;]]></r>')
    expect(root.attributes.v).toBe('a <= b && c AB')
    expect(root.text).toBe('x > y<raw>&amp;')
  })

  it('finds descendants without entering stopped elements', () => {
    const root = parseXml('<R><Op id="1"><X/><Op id="2"><X/><Op id="3"/></Op></Op></R>')
    const top = firstChild(root, 'Op')
    if (!top) throw new Error('missing')
    expect(findDescendants(top, 'Op', (e) => e.local === 'Op').map((e) => e.attributes.id)).toEqual(['2'])
    expect(findDescendants(top, 'X', (e) => e.local === 'Op')).toHaveLength(1)
    expect(findDescendants(root, 'Op').map((e) => e.attributes.id)).toEqual(['1', '2', '3'])
  })

  it('rejects malformed documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError)
    expect(() => parseXml('<a>')).toThrow(/Unclosed/)
    expect(() => parseXml('<a/><b/>')).toThrow(/Multiple root/)
    expect(() => parseXml('text only')).toThrow(/No root/)
  })

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&nbsp; &amp;')).toBe('&nbsp; &')
  })
})
