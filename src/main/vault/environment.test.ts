import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loginShellScript, parseLoginShellOutput, VaultEnvironmentResolver, type SpawnShell } from './environment'

describe('login shell output', () => {
  it('reads the values between the markers, ignoring what the profile printed', () => {
    const output = [
      'Welcome back!\n',
      'VAULT_ADDR=https://decoy.example.shared\0', // printed by the profile, outside the markers
      '\n__DATAGRIPPE_VAULT_ENV_START__\n',
      'VAULT_ADDR=https://vault.example.shared\0VAULT_NAMESPACE=\0VAULT_CACERT=/Users/me/ca.pem\0',
      '__DATAGRIPPE_VAULT_ENV_END__\n',
      'bye\n',
    ].join('')
    expect(parseLoginShellOutput(output)).toEqual({ VAULT_ADDR: 'https://vault.example.shared', VAULT_CACERT: '/Users/me/ca.pem' })
  })

  it('ignores unknown names, oversized or multi-line values and a missing end marker', () => {
    const start = '\n__DATAGRIPPE_VAULT_ENV_START__\n'
    const end = '__DATAGRIPPE_VAULT_ENV_END__\n'
    expect(parseLoginShellOutput(`${start}VAULT_TOKEN=s.secret\0VAULT_ADDR=${'x'.repeat(5000)}\0${end}`)).toEqual({})
    expect(parseLoginShellOutput(`${start}VAULT_ADDR=https://a\nb\0${end}`)).toEqual({})
    expect(parseLoginShellOutput(`${start}VAULT_ADDR=https://vault.example.shared\0`)).toEqual({})
    expect(parseLoginShellOutput('no markers')).toEqual({})
  })

  it('asks the shell for the three Vault variables only (never VAULT_TOKEN)', () => {
    const script = loginShellScript()
    expect(script).toContain('"$VAULT_ADDR"')
    expect(script).toContain('"$VAULT_NAMESPACE"')
    expect(script).toContain('"$VAULT_CACERT"')
    expect(script).not.toContain('VAULT_TOKEN')
  })
})

describe('VaultEnvironmentResolver', () => {
  let home: string
  let calls: { shell: string; args: string[] }[]
  const shellOutput = (values: string): SpawnShell => async (shell, args) => {
    calls.push({ shell, args })
    return `noise\n__DATAGRIPPE_VAULT_ENV_START__\n${values}__DATAGRIPPE_VAULT_ENV_END__\n`
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dg-vault-env-'))
    calls = []
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('uses the process environment first, without running a shell', async () => {
    const resolver = new VaultEnvironmentResolver({
      env: { VAULT_ADDR: 'https://vault.example.shared', VAULT_CACERT: '/etc/ca.pem' },
      platform: 'darwin',
      homeDir: () => home,
      spawnShell: shellOutput(''),
    })
    expect(await resolver.defaults()).toEqual({ source: 'env', address: 'https://vault.example.shared', caPath: '/etc/ca.pem', cliTokenFile: false })
    expect(calls).toEqual([])
  })

  it('reads VAULT_ADDR from the login shell when started from Finder, once', async () => {
    writeFileSync(join(home, '.vault-token'), 'tok')
    const resolver = new VaultEnvironmentResolver({
      env: {},
      platform: 'darwin',
      homeDir: () => home,
      shell: () => '/bin/zsh',
      spawnShell: shellOutput('VAULT_ADDR=https://vault.example.shared\0VAULT_NAMESPACE=\0VAULT_CACERT=relative/ca.pem\0'),
    })
    resolver.start()
    expect(await resolver.defaults()).toEqual({ source: 'login-shell', address: 'https://vault.example.shared', cliTokenFile: true })
    await resolver.get()
    expect(calls).toHaveLength(1)
    expect(calls[0].shell).toBe('/bin/zsh')
    expect(calls[0].args[0]).toBe('-ilc')
    expect(resolver.peek()?.address).toBe('https://vault.example.shared')
  })

  it('never runs the shell in automated runs or on Windows, and survives a failing shell', async () => {
    for (const deps of [
      { env: {}, platform: 'darwin' as const, automated: true },
      { env: {}, platform: 'win32' as const },
    ]) {
      const resolver = new VaultEnvironmentResolver({ ...deps, homeDir: () => home, shell: () => '/bin/zsh', spawnShell: shellOutput('VAULT_ADDR=x\0') })
      expect(await resolver.defaults()).toEqual({ source: 'none', cliTokenFile: false })
    }
    expect(calls).toEqual([])
    const failing = new VaultEnvironmentResolver({ env: {}, platform: 'linux', homeDir: () => home, shell: () => '/bin/sh', spawnShell: async () => null })
    expect((await failing.get()).source).toBe('none')
    const noShell = new VaultEnvironmentResolver({ env: {}, platform: 'linux', homeDir: () => home, shell: () => undefined })
    expect((await noShell.get()).source).toBe('none')
  })

  it('runs a real login shell end to end', async () => {
    // An interactive POSIX sh reads $ENV: it plays the user's ~/.zshrc here (HOME is a temp dir).
    const profile = join(home, 'profile.sh')
    writeFileSync(profile, "echo 'profile noise'\nexport VAULT_ADDR=https://vault.example.shared\n")
    const resolver = new VaultEnvironmentResolver({
      env: { PATH: process.env.PATH, HOME: home, ENV: profile, VAULT_NAMESPACE: 'team-a' },
      platform: 'linux',
      homeDir: () => home,
      shell: () => '/bin/sh',
    })
    // The shell gives VAULT_ADDR; the process environment still wins for the variables it sets.
    expect(await resolver.get()).toEqual({ address: 'https://vault.example.shared', namespace: 'team-a', source: 'login-shell' })

    writeFileSync(profile, 'echo nothing to see\n')
    const empty = new VaultEnvironmentResolver({ env: { PATH: process.env.PATH, HOME: home, ENV: profile }, platform: 'linux', homeDir: () => home, shell: () => '/bin/sh' })
    expect(await empty.get()).toEqual({ source: 'none' })
  })
})
