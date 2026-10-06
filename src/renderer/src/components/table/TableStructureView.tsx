// Table structure tab: columns, indexes, keys, constraints, triggers and DDL of one object.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Columns3, FileCode2, GitFork, Link2, ListTree, RefreshCw, RotateCcw, ShieldCheck, Table2, TriangleAlert, Zap } from 'lucide-react'
import type { TableDetails } from '@shared/types'
import {
  Button,
  EmptyState,
  IconButton,
  ProgressBar,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Toolbar,
  ToolbarSpacer,
  type IconLike,
} from '@/components/ui'
import { api, errorInfo } from '@/lib/api'
import { cn } from '@/lib/cn'
import { registerCommands } from '@/lib/commands'
import { objectKey, useExplorer } from '@/stores/explorer'
import { useTabs, type TableTab } from '@/stores/tabs'
import { isViewLike } from './object-kind'
import { openSibling, openSqlInConsole } from './table-actions'
import { ViewSwitch } from './ViewSwitch'
import { ColumnsSection } from './structure/ColumnsSection'
import { ConstraintsSection } from './structure/ConstraintsSection'
import { DdlSection, type DdlState } from './structure/DdlSection'
import { IndexesSection } from './structure/IndexesSection'
import { ForeignKeysSection, ReferencedBySection, type TableTarget } from './structure/KeysSection'
import { StructureHeader } from './structure/StructureHeader'
import { TriggersSection } from './structure/TriggersSection'

type Section = 'columns' | 'indexes' | 'foreign-keys' | 'referenced-by' | 'constraints' | 'triggers' | 'ddl'

const SECTIONS: { id: Section; label: string; icon: IconLike; count?: (d: TableDetails) => number; tableOnly?: boolean }[] = [
  { id: 'columns', label: 'Columns', icon: Columns3, count: (d) => d.columns.length },
  { id: 'indexes', label: 'Indexes', icon: ListTree, count: (d) => d.indexes.length, tableOnly: true },
  { id: 'foreign-keys', label: 'Foreign keys', icon: Link2, count: (d) => d.foreignKeys.length, tableOnly: true },
  { id: 'referenced-by', label: 'Referenced by', icon: GitFork, count: (d) => d.referencedBy.length, tableOnly: true },
  { id: 'constraints', label: 'Constraints', icon: ShieldCheck, count: (d) => d.constraints.length, tableOnly: true },
  { id: 'triggers', label: 'Triggers', icon: Zap, count: (d) => d.triggers.length, tableOnly: true },
  { id: 'ddl', label: 'DDL', icon: FileCode2 },
]

/** Remembered per tab across unmounts (table tabs only mount while active). */
const sectionMemory = new Map<string, Section>()
const ddlMemory = new Map<string, string>()

export function TableStructureView({ tab }: { tab: TableTab }) {
  const { connectionId, database } = tab
  const { schema, name } = tab.table
  const details = useExplorer((s) => s.details[objectKey(connectionId, database, schema, name)])
  const data = details?.data
  const kind = data?.kind ?? tab.table.kind
  const viewLike = isViewLike(kind)
  const sections = SECTIONS.filter((s) => !(viewLike && s.tableOnly))

  const [stored, setStored] = useState<Section>(() => sectionMemory.get(tab.id) ?? 'columns')
  const section: Section = sections.some((s) => s.id === stored) ? stored : 'columns'
  const setSection = (next: Section) => {
    sectionMemory.set(tab.id, next)
    setStored(next)
  }

  const [ddl, setDdl] = useState<DdlState>(() => {
    const cached = ddlMemory.get(tab.id)
    return cached !== undefined ? { status: 'ready', ddl: cached } : { status: 'idle' }
  })
  const ddlSeq = useRef(0)

  const loadDetails = useCallback(
    (force?: boolean) => useExplorer.getState().loadDetails(connectionId, database, schema, name, force),
    [connectionId, database, schema, name],
  )

  const loadDdl = useCallback(async () => {
    const seq = ++ddlSeq.current
    setDdl({ status: 'loading' })
    try {
      const text = await api.meta.ddl({ connectionId, database, schema, name, kind })
      if (seq !== ddlSeq.current) return
      ddlMemory.set(tab.id, text)
      setDdl({ status: 'ready', ddl: text })
    } catch (error) {
      if (seq === ddlSeq.current) setDdl({ status: 'error', error: errorInfo(error) })
    }
  }, [connectionId, database, schema, name, kind, tab.id])

  useEffect(() => {
    void loadDetails()
  }, [loadDetails])

  useEffect(() => {
    if (section === 'ddl' && ddl.status === 'idle') void loadDdl()
  }, [section, ddl.status, loadDdl])

  const refresh = useCallback(() => {
    void loadDetails(true)
    ddlMemory.delete(tab.id)
    if (section === 'ddl') void loadDdl()
    else setDdl({ status: 'idle' })
  }, [loadDetails, loadDdl, section, tab.id])

  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(
    () =>
      registerCommands([
        { id: 'refresh-table', title: 'Refresh structure', group: 'Table structure', icon: RefreshCw, keywords: ['reload'], run: () => latest.current() },
        { id: 'open-table-data', title: `Open data of ${name}`, group: 'Table structure', icon: Table2, keywords: ['rows', 'edit'], run: () => openSibling(tab, 'table') },
      ]),
    // Commands target this tab; re-register only when another object is shown.
    [tab.id, name],
  )

  const openTable = (target: TableTarget, view: 'table' | 'structure') =>
    useTabs.getState().openTable({ connectionId, database, schema: target.schema, name: target.name, kind: 'table' }, view)

  const loadingFirst = !data && (!details || details.status === 'loading')

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <Toolbar className="gap-1.5">
        <ViewSwitch tab={tab} />
        <IconButton icon={RefreshCw} label="Refresh" loading={details?.status === 'loading' && !!data} onClick={refresh} />
        <ToolbarSpacer />
      </Toolbar>

      {details?.status === 'error' && !data ? (
        <EmptyState
          tone="danger"
          icon={TriangleAlert}
          title={`Could not load ${schema}.${name}`}
          description={details.error ?? 'The server did not return the table metadata.'}
          action={
            <Button size="sm" variant="primary" leadingIcon={RotateCcw} onClick={() => void loadDetails(true)}>
              Retry
            </Button>
          }
        />
      ) : (
        <>
          <div className="relative">
            <StructureHeader schema={schema} name={name} details={data} kind={kind} />
            {details?.status === 'loading' && data && <ProgressBar className="absolute inset-x-0 bottom-0" />}
          </div>
          <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="flex min-h-0 flex-1 flex-col">
            <ScrollingTabsList active={section}>
              {sections.map((s) => (
                <TabsTrigger key={s.id} value={s.id} data-section={s.id} icon={s.icon} count={data && s.count ? s.count(data) : undefined} className="after:bottom-0">
                  {s.label}
                </TabsTrigger>
              ))}
            </ScrollingTabsList>
            {loadingFirst ? (
              <SectionSkeleton />
            ) : (
              data && (
                <>
                  <TabsContent value="columns" className="flex-1 overflow-auto">
                    <ColumnsSection columns={data.columns} foreignKeys={data.foreignKeys} />
                  </TabsContent>
                  <TabsContent value="indexes" className="flex-1 overflow-auto">
                    <IndexesSection indexes={data.indexes} />
                  </TabsContent>
                  <TabsContent value="foreign-keys" className="flex-1 overflow-auto">
                    <ForeignKeysSection
                      keys={data.foreignKeys}
                      currentSchema={schema}
                      onOpenStructure={(t) => openTable(t, 'structure')}
                      onOpenData={(t) => openTable(t, 'table')}
                    />
                  </TabsContent>
                  <TabsContent value="referenced-by" className="flex-1 overflow-auto">
                    <ReferencedBySection
                      keys={data.referencedBy}
                      currentSchema={schema}
                      onOpenStructure={(t) => openTable(t, 'structure')}
                      onOpenData={(t) => openTable(t, 'table')}
                    />
                  </TabsContent>
                  <TabsContent value="constraints" className="flex-1 overflow-auto">
                    <ConstraintsSection constraints={data.constraints} />
                  </TabsContent>
                  <TabsContent value="triggers" className="flex-1 overflow-auto">
                    <TriggersSection triggers={data.triggers} />
                  </TabsContent>
                </>
              )
            )}
            <TabsContent value="ddl" className="flex-1 overflow-auto">
              <DdlSection state={ddl} onRetry={() => void loadDdl()} onOpenInConsole={(text) => openSqlInConsole(tab, text)} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  )
}

/**
 * The section strip scrolls horizontally when the window is too narrow for every section (fades
 * mark the hidden side), and keeps the active section in view.
 */
function ScrollingTabsList({ active, children }: { active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [measure])
  useEffect(() => {
    const trigger = ref.current?.querySelector<HTMLElement>(`[data-section="${active}"]`)
    trigger?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return (
    <div className="relative shrink-0 border-b border-line">
      <TabsList ref={ref} onScroll={measure} className="scrollbar-none overflow-x-auto overflow-y-hidden border-b-0 px-4">
        {children}
      </TabsList>
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface to-transparent transition-opacity duration-150',
          overflow.left ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent transition-opacity duration-150',
          overflow.right ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}

function SectionSkeleton() {
  return (
    <div aria-busy aria-label="Loading structure" className="flex-1 overflow-hidden">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-8 border-b border-line px-4" style={{ opacity: 1 - i / 12 }}>
          <Skeleton width={16} height={8} />
          <Skeleton width={90 + ((i * 37) % 70)} />
          <Skeleton width={70 + ((i * 23) % 40)} />
          <Skeleton width={24} height={8} />
          <Skeleton width={60 + ((i * 41) % 80)} />
        </div>
      ))}
    </div>
  )
}
