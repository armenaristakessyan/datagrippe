// Protocol-level CancelRequest (processID + secret key from BackendKeyData). Unlike pg_cancel_backend it
// needs no login: it works when the server is out of connection slots or the role is at its CONNECTION LIMIT,
// and costs one TCP round trip instead of a full TLS + authentication handshake.
import { connect } from 'node:net'

const CANCEL_REQUEST_CODE = 80877102
export const CANCEL_TIMEOUT_MS = 5_000

export interface BackendKey {
  processId: number
  secretKey: number
}

/** The BackendKeyData pg.Client stored at startup (not part of its typings). */
export function backendKeyOf(client: object): BackendKey | null {
  const { processID, secretKey } = client as { processID?: unknown; secretKey?: unknown }
  return typeof processID === 'number' && typeof secretKey === 'number' ? { processId: processID, secretKey } : null
}

export function cancelRequestPacket(key: BackendKey): Buffer {
  const packet = Buffer.alloc(16)
  packet.writeInt32BE(16, 0)
  packet.writeInt32BE(CANCEL_REQUEST_CODE, 4)
  packet.writeInt32BE(key.processId, 8)
  packet.writeInt32BE(key.secretKey | 0, 12)
  return packet
}

/**
 * Send a CancelRequest on a fresh plain TCP connection to `host:port` (the tunnel's local end when SSH is
 * used). The server accepts cancel requests without TLS and before pg_hba checks, then closes the socket.
 * Resolves once the server closed the connection; rejects when it cannot be reached.
 */
export function sendCancelRequest(host: string, port: number, key: BackendKey, timeoutMs = CANCEL_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent = false
    let settled = false
    // A host starting with "/" is a Unix-socket directory (as for pg.Client).
    const socket = host.startsWith('/') ? connect({ path: `${host}/.s.PGSQL.${port}` }) : connect({ host, port })
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => finish(sent ? undefined : new Error('Timed out sending the cancel request')), timeoutMs)
    socket.setNoDelay(true)
    socket.once('connect', () => {
      socket.write(cancelRequestPacket(key), (error) => {
        if (error) finish(error)
        else sent = true
      })
    })
    socket.on('data', () => undefined)
    socket.once('error', (error) => finish(sent ? undefined : error))
    socket.once('close', () => finish(sent ? undefined : new Error('The server closed the connection before the cancel request was sent')))
  })
}
