// Work a console would lose when it closes or its connection goes away: an open transaction (rolled
// back), a running statement (cancelled) or unsaved edits of a .sql file. Disconnecting asks first;
// closing a console asks about a running statement / unsaved file (the consoles store asks about an
// open transaction itself), and closing a console that held a script offers an Undo.
import { toast } from '@/components/ui'
import { pluralize } from '@/lib/format'
import { useConnections } from '@/stores/connections'
import { useConsoles, type ConsoleRuntime } from '@/stores/consoles'
import { onTabClosed, registerCloseGuard, useTabs, type ConsoleTab, type Tab } from '@/stores/tabs'
import { useUi } from '@/stores/ui'

export interface ConsoleWork {
  tab: ConsoleTab
  transaction: boolean
  running: boolean
}

/** Consoles (optionally of one connection) with an open transaction or a running statement. */
export function consoleWork(
  tabs: readonly Tab[],
  runtimes: Readonly<Record<string, ConsoleRuntime>>,
  connectionId?: string,
): ConsoleWork[] {
  const out: ConsoleWork[] = []
  for (const tab of tabs) {
    if (tab.kind !== 'console') continue
    if (connectionId !== undefined && tab.connectionId !== connectionId) continue
    const runtime = runtimes[tab.id]
    if (!runtime?.sessionId) continue
    const transaction = runtime.transaction.inTransaction
    const running = runtime.status === 'running'
    if (transaction || running) out.push({ tab, transaction, running })
  }
  return out
}

/** "Query 1 and Query 2", "Query 1, Query 2 and 3 more". */
export function listTitles(titles: readonly string[], max = 3): string {
  const quoted = titles.map((t) => `“${t}”`)
  if (quoted.length <= 1) return quoted[0] ?? ''
  if (quoted.length <= max) return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
  return `${quoted.slice(0, max - 1).join(', ')} and ${quoted.length - (max - 1)} more`
}

/** One sentence per kind of loss, e.g. "Uncommitted changes in “Query 1” are rolled back." */
export function describeWork(work: readonly ConsoleWork[]): string {
  const tx = work.filter((w) => w.transaction).map((w) => w.tab.title)
  const running = work.filter((w) => w.running).map((w) => w.tab.title)
  const parts: string[] = []
  if (tx.length > 0) parts.push(`Uncommitted changes in ${listTitles(tx)} are rolled back.`)
  if (running.length > 0) parts.push(`The statement running in ${listTitles(running)} is cancelled.`)
  return parts.join(' ')
}

/** Unsaved edits of a console opened from / saved to a file. */
export function hasUnsavedFile(tab: ConsoleTab): boolean {
  return tab.filePath !== undefined && tab.savedContent !== undefined && tab.content !== tab.savedContent
}

/** Ask before disconnecting a connection whose consoles hold a transaction or a running statement. */
export async function confirmDisconnect(connectionId: string): Promise<boolean> {
  const work = consoleWork(useTabs.getState().tabs, useConsoles.getState().runtimes, connectionId)
  if (work.length === 0) return true
  const name = useConnections.getState().connections.find((c) => c.id === connectionId)?.name ?? 'this connection'
  const transactions = work.filter((w) => w.transaction).length
  return useUi.getState().confirm({
    title:
      transactions > 0
        ? `Disconnect “${name}” and roll back ${pluralize(transactions, 'open transaction')}?`
        : `Disconnect “${name}” and cancel the running ${work.length === 1 ? 'statement' : 'statements'}?`,
    message: describeWork(work),
    confirmLabel: transactions > 0 ? 'Roll back and disconnect' : 'Disconnect',
    cancelLabel: 'Keep connected',
    danger: true,
  })
}

/**
 * Close guard for what the console's own close dialog (open transaction → commit / roll back, in the
 * consoles store) does not cover: a running statement and unsaved edits of a .sql file.
 */
export async function confirmCloseConsole(tab: ConsoleTab): Promise<boolean> {
  const runtime = useConsoles.getState().runtimes[tab.id]
  if (runtime?.transaction.inTransaction && runtime.sessionId) return true
  const [work] = consoleWork([tab], useConsoles.getState().runtimes)
  const running = work?.running ?? false
  const unsaved = hasUnsavedFile(tab)
  if (!running && !unsaved) return true
  useTabs.getState().setActive(tab.id)
  const reasons = [running ? describeWork([{ tab, running, transaction: false }]) : '', unsaved ? 'Unsaved changes to the file are lost.' : '']
  return useUi.getState().confirm({
    title: running ? `Close “${tab.title}” and cancel its running statement?` : `Close “${tab.title}” and discard unsaved changes?`,
    message: reasons.filter(Boolean).join(' '),
    confirmLabel: running ? 'Cancel and close' : 'Discard and close',
    cancelLabel: 'Keep open',
    danger: true,
  })
}

/** Register the console close guard and the "Undo close" toast. Call once at startup. */
export function bindConsoleGuards(): () => void {
  const offGuard = registerCloseGuard((tab) => (tab.kind === 'console' ? confirmCloseConsole(tab) : true))

  // Closed consoles that held a script can be brought back (batched: "Close all" shows one toast).
  let batch: { tab: ConsoleTab; index: number }[] = []
  let flush: ReturnType<typeof setTimeout> | undefined
  let previousTabs = useTabs.getState().tabs
  // The tab list just before the latest change: where a closed tab sat.
  const offStore = useTabs.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs) previousTabs = prev.tabs
  })
  const offClosed = onTabClosed((tab) => {
    if (tab.kind !== 'console' || !tab.content.trim() || (tab.filePath && !hasUnsavedFile(tab))) return
    const index = previousTabs.findIndex((t) => t.id === tab.id)
    batch.push({ tab, index: index < 0 ? useTabs.getState().tabs.length : index })
    if (flush) clearTimeout(flush)
    flush = setTimeout(() => {
      const closed = batch
      batch = []
      flush = undefined
      toast.message(closed.length === 1 ? `Closed “${closed[0]!.tab.title}”` : `Closed ${pluralize(closed.length, 'console')}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            for (const { tab: t, index } of [...closed].sort((a, b) => a.index - b.index)) useTabs.getState().reopen(t, index)
          },
        },
      })
    }, 0)
  })
  return () => {
    offGuard()
    offStore()
    offClosed()
    if (flush) clearTimeout(flush)
  }
}
