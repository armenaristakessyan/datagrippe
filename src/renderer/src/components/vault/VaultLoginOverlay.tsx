// Vault runtime of the shell (mounted once by AppShell):
//  - mirrors main's Vault events into useVault() (lease status, interactive sign-in);
//  - shows the pending OIDC browser sign-in as a floating card (bottom-right, above the toasts) with
//    "Open again" / "Cancel" — hidden while the connection dialog is open (it shows its own state);
//  - toasts the end of a sign-in, and registers the Vault commands of the palette.
import { useEffect } from 'react'
import { Copy, ExternalLink, KeyRound, LogOut, KeySquare } from 'lucide-react'
import { Button, Spinner, toast } from '@/components/ui'
import { api } from '@/lib/api'
import { registerCommands } from '@/lib/commands'
import { useConnections } from '@/stores/connections'
import { useUi } from '@/stores/ui'
import { bindVaultEvents, useVault } from '@/stores/vault'
import { activeConnectionId, activeVaultConnection, copyVaultUser, refreshVaultCredentials, signOutOfVault, toastError, vaultUserOf } from './actions'

export function VaultLoginOverlay() {
  useVaultRuntime()
  const login = useVault((s) => s.login)
  const dialogOpen = useUi((s) => s.connectionDialog.open)
  if (!login || dialogOpen) return null
  const server = login.namespace ? `${login.address} · ${login.namespace}` : login.address
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Vault sign-in"
      data-testid="vault-login-card"
      // Above the toaster (same anchor: 68px above the bottom edge, 14px from the right).
      className="pointer-events-auto fixed bottom-[68px] right-[14px] z-[1000000000] flex w-[356px] animate-pop-in items-start gap-2.5 rounded-lg border border-line bg-elevated px-3 py-2.5 text-fg shadow-popover motion-reduce:animate-none"
    >
      <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
        <KeySquare size={15} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-[12.5px] font-medium leading-[18px]">
          Sign in to Vault in your browser
          <Spinner size={11} className="text-subtle" label="Waiting for the browser" />
        </p>
        <p className="truncate font-mono text-2xs leading-4 text-subtle" title={server}>
          {server}
        </p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="xs"
            variant="secondary"
            leadingIcon={ExternalLink}
            disabled={!login.url}
            onClick={() => {
              if (login.url) void api.app.openExternal(login.url).catch((error) => toastError('Could not open the browser', error))
            }}
          >
            Open again
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void cancelVaultLogin()}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

export async function cancelVaultLogin(): Promise<void> {
  try {
    await api.vault.cancelLogin()
  } catch (error) {
    toastError('Could not cancel the Vault sign-in', error)
  }
  // Main confirms with a 'cancelled' event; do not leave the card up if it does not.
  useVault.getState().setLogin(null)
}

function useVaultRuntime(): void {
  // VAULT_ADDR of the shell profile and ~/.vault-token: ready before a connection dialog opens.
  useEffect(() => {
    void useVault.getState().loadDefaults()
  }, [])
  useEffect(
    () =>
      bindVaultEvents({
        onLoginFinished: (event) => {
          if (event.state === 'completed') {
            toast.success('Signed in to Vault', { description: event.namespace ? `${event.address} · ${event.namespace}` : event.address })
          } else if (event.state === 'failed') {
            toast.error('Vault sign-in failed', undefined, { description: event.message ?? event.address })
          }
        },
      }),
    [],
  )
  useEffect(
    () =>
      registerCommands([
        {
          id: 'vault-refresh',
          title: 'Refresh Vault credentials',
          group: 'Connection',
          icon: KeyRound,
          keywords: ['vault', 'lease', 'renew', 'credentials', 'hashicorp'],
          when: () => {
            const connection = activeVaultConnection()
            return connection !== undefined && useConnections.getState().runtime[connection.id]?.status === 'connected'
          },
          run: () => {
            const id = activeConnectionId()
            if (id) void refreshVaultCredentials(id)
          },
        },
        {
          // The lease details are otherwise in hover-only tooltips (explorer badge, status bar chip).
          id: 'vault-copy-user',
          title: 'Copy Vault database user',
          group: 'Connection',
          icon: Copy,
          keywords: ['vault', 'lease', 'user', 'username', 'credentials', 'hashicorp'],
          when: () => vaultUserOf(activeVaultConnection()?.id) !== null,
          run: () => {
            const id = activeConnectionId()
            if (id) void copyVaultUser(id)
          },
        },
        {
          id: 'vault-sign-out',
          title: 'Sign out of Vault',
          group: 'Connection',
          icon: LogOut,
          keywords: ['vault', 'logout', 'log out', 'token', 'hashicorp'],
          when: () => activeVaultConnection() !== undefined,
          run: () => {
            const id = activeConnectionId()
            if (id) void signOutOfVault(id)
          },
        },
      ]),
    [],
  )
}
