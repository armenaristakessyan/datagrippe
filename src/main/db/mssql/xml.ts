// Minimal XML parser for showplan documents: elements, attributes, text, CDATA and entities.
// Comments, processing instructions and DOCTYPE declarations are skipped. Namespaces are kept in
// names but `local` strips any prefix.

export interface XmlElement {
  name: string
  /** Name without namespace prefix. */
  local: string
  attributes: Record<string, string>
  children: XmlElement[]
  text: string
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return NAMED_ENTITIES[entity] ?? match
  })
}

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

const NAME_RE = /[^\s/>=]+/y
const ATTR_RE = /\s*([^\s/>=]+)\s*=\s*("([^"]*)"|'([^']*)')/y

export class XmlParseError extends Error {
  constructor(message: string, readonly position: number) {
    super(`${message} at offset ${position}`)
    this.name = 'XmlParseError'
  }
}

/** Parse a document and return its root element. Throws XmlParseError on malformed input. */
export function parseXml(source: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  let pos = 0

  const appendText = (text: string): void => {
    const current = stack[stack.length - 1]
    if (current) current.text += text
  }

  while (pos < source.length) {
    const lt = source.indexOf('<', pos)
    if (lt === -1) {
      appendText(decodeEntities(source.slice(pos)))
      break
    }
    if (lt > pos) appendText(decodeEntities(source.slice(pos, lt)))

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      if (end === -1) throw new XmlParseError('Unterminated comment', lt)
      pos = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      if (end === -1) throw new XmlParseError('Unterminated CDATA section', lt)
      appendText(source.slice(lt + 9, end))
      pos = end + 3
      continue
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2)
      if (end === -1) throw new XmlParseError('Unterminated processing instruction', lt)
      pos = end + 2
      continue
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2)
      if (end === -1) throw new XmlParseError('Unterminated declaration', lt)
      pos = end + 1
      continue
    }
    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2)
      if (end === -1) throw new XmlParseError('Unterminated closing tag', lt)
      const name = source.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open || open.name !== name) throw new XmlParseError(`Unexpected closing tag </${name}>`, lt)
      pos = end + 1
      continue
    }

    NAME_RE.lastIndex = lt + 1
    const nameMatch = NAME_RE.exec(source)
    if (!nameMatch) throw new XmlParseError('Invalid tag name', lt)
    const name = nameMatch[0]
    const element: XmlElement = { name, local: localName(name), attributes: {}, children: [], text: '' }
    pos = NAME_RE.lastIndex

    for (;;) {
      ATTR_RE.lastIndex = pos
      const attr = ATTR_RE.exec(source)
      if (!attr) break
      element.attributes[attr[1] ?? ''] = decodeEntities(attr[3] ?? attr[4] ?? '')
      pos = ATTR_RE.lastIndex
    }
    while (pos < source.length && /\s/.test(source.charAt(pos))) pos++

    let selfClosing = false
    if (source.startsWith('/>', pos)) {
      selfClosing = true
      pos += 2
    } else if (source.charAt(pos) === '>') {
      pos += 1
    } else {
      throw new XmlParseError(`Malformed tag <${name}>`, pos)
    }

    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else if (!root) root = element
    else throw new XmlParseError('Multiple root elements', lt)
    if (!selfClosing) stack.push(element)
  }

  if (stack.length > 0) throw new XmlParseError(`Unclosed element <${stack[stack.length - 1]?.name ?? ''}>`, source.length)
  if (!root) throw new XmlParseError('No root element', 0)
  return root
}

export function childElements(element: XmlElement, local: string): XmlElement[] {
  return element.children.filter((child) => child.local === local)
}

export function firstChild(element: XmlElement, local: string): XmlElement | undefined {
  return element.children.find((child) => child.local === local)
}

/** Depth-first descendants matching `local`, not descending into elements for which `stop` is true. */
export function findDescendants(
  element: XmlElement,
  local: string,
  stop: (element: XmlElement) => boolean = () => false,
): XmlElement[] {
  const found: XmlElement[] = []
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.local === local) found.push(child)
      if (!stop(child)) visit(child)
    }
  }
  visit(element)
  return found
}
