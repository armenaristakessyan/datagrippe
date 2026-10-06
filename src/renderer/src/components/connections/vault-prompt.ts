// Vault secrets asked while testing from the connection dialog (main answers 'needs-password' with a
// Vault secretField when no token / password is available). Pure helpers, unit-tested.
import type { DbErrorInfo } from '@shared/types'
import { vaultPromptError, type VaultSecretField } from '@/stores/vault'
import type { ConnectionForm } from './connection-form'

/** The Vault secret a failed test asks for (null for anything else, including the database password). */
export function promptedVaultSecret(result: { ok: boolean; error?: DbErrorInfo }): VaultSecretField | null {
  if (result.ok || result.error?.kind !== 'needs-password') return null
  const field = result.error.secretField
  return field === 'vaultToken' || field === 'vaultPassword' ? field : null
}

/**
 * Error the prompt opens with: the rejection of a stored secret (VAULT_TOKEN, ~/.vault-token, saved token /
 * password: main sets `detail`) or of the value typed in the form / a previous prompt (`sentNow`). Same rule
 * as the explorer's connect flow (rejectionShown in stores/connections).
 */
export function vaultPromptOpening(result: { error?: DbErrorInfo }, sentNow: boolean): DbErrorInfo | undefined {
  return vaultPromptError(result.error, sentNow)
}

/**
 * Put a prompted Vault secret into the form, so saving keeps it (subject to "Save password"). An empty
 * answer changes nothing: it must never turn a stored secret into "clear".
 */
export function fillPromptedSecret(form: ConnectionForm, field: VaultSecretField, value: string): ConnectionForm {
  if (value === '') return form
  const secret = { value, action: 'set' as const }
  return { ...form, vault: field === 'vaultToken' ? { ...form.vault, token: secret } : { ...form.vault, password: secret } }
}
