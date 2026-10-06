// connections:test with an existing id fills in the STORED password even when the host/port/user
// in the input differ from the saved connection. Any caller (or a compromised renderer) can make
// main send the saved production password, in cleartext, to an arbitrary server.
import { createServer, type AddressInfo, type Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectionInput, createHarness } from './harness'

const h = createHarness()

/** Minimal PostgreSQL "server" that asks for a cleartext password and records it. */
function fakePg(received: string[]): Server {
  return createServer((socket) => {
    let startup = true
    socket.on('data', (buf) => {
      if (startup) {
        startup = false
        // SSLRequest is 8 bytes with code 80877103: refuse SSL first.
        if (buf.length === 8 && buf.readInt32BE(4) === 80877103) {
          socket.write('N')
          startup = true
          return
        }
        const auth = Buffer.alloc(9)
        auth.write('R', 0)
        auth.writeInt32BE(8, 1)
        auth.writeInt32BE(3, 5) // AuthenticationCleartextPassword
        socket.write(auth)
        return
      }
      if (buf[0] === 0x70 /* 'p' */) {
        received.push(buf.subarray(5, buf.length - 1).toString('utf8'))
        socket.destroy()
      }
    })
    socket.on('error', () => undefined)
  })
}

describe('connections:test with a stored connection id', () => {
  const received: string[] = []
  let server: Server
  let port = 0
  beforeAll(async () => {
    server = fakePg(received)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await h.dispose()
  })

  it('does not send the stored password to a different endpoint', async () => {
    const saved = h.store.save(connectionInput('postgres', { name: 'Prod', secrets: { password: 'prod-super-secret' } }))
    // Same id, attacker-controlled endpoint, no password typed.
    await h.manager.test({ ...connectionInput('postgres', { secrets: undefined }), id: saved.id, host: '127.0.0.1', port })
    expect(received).not.toContain('prod-super-secret')
  })
})
