// First-run state of the explorer: a small composition of the two engines + a call to action.
import { Import, Plug } from 'lucide-react'
import { DIALECT_LABEL, type Dialect } from '@shared/types'
import { openDbeaverImport } from '@/components/import/useDbeaverImportCommand'
import { Button, DialectIcon, Kbd } from '@/components/ui'
import { MENU_ACCELERATORS } from '@/lib/shortcuts'
import { useUi } from '@/stores/ui'

const DIALECTS: Dialect[] = ['postgres', 'mssql']

function Illustration() {
  return (
    <div aria-hidden className="relative h-[72px] w-[136px]">
      <div className="absolute inset-x-4 top-3 h-12 rounded-full bg-glow blur-xl" />
      <svg className="absolute inset-0 text-line-strong" viewBox="0 0 136 72" fill="none">
        <path d="M34 40 C 50 40, 52 30, 68 30 C 84 30, 86 40, 102 40" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2.5 3" strokeLinecap="round" />
      </svg>
      <span className="absolute left-3 top-[22px] -rotate-[8deg] rounded-[9px] shadow-raised">
        <DialectIcon dialect="postgres" size={34} title="" />
      </span>
      <span className="absolute right-3 top-[22px] rotate-[8deg] rounded-[9px] shadow-raised">
        <DialectIcon dialect="mssql" size={34} title="" />
      </span>
      <span className="absolute left-1/2 top-[12px] flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-elevated text-muted shadow-raised">
        <Plug size={16} strokeWidth={1.75} />
      </span>
    </div>
  )
}

export function ExplorerEmpty() {
  const openConnectionDialog = useUi((s) => s.openConnectionDialog)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-5 pb-10 text-center">
      <Illustration />
      <div className="flex max-w-[220px] flex-col gap-1">
        <p className="text-sm font-medium text-fg">No connections yet</p>
        <p className="text-xs leading-[18px] text-subtle">Add a PostgreSQL or SQL Server database to browse its schemas and data.</p>
      </div>
      <div className="flex w-full max-w-[220px] flex-col gap-1.5">
        {DIALECTS.map((dialect) => (
          <Button
            key={dialect}
            variant={dialect === 'postgres' ? 'primary' : 'secondary'}
            className="w-full justify-start"
            leadingIcon={<DialectIcon dialect={dialect} size={15} title="" />}
            onClick={() => openConnectionDialog({ dialect })}
          >
            New {DIALECT_LABEL[dialect]} connection
          </Button>
        ))}
        <Button variant="ghost" className="w-full justify-start text-muted" leadingIcon={Import} onClick={openDbeaverImport}>
          Import from DBeaver…
        </Button>
      </div>
      <p className="flex items-center gap-1.5 text-2xs text-subtle">
        or press <Kbd shortcut={MENU_ACCELERATORS['new-connection']} size="sm" />
      </p>
    </div>
  )
}
