// Living style guide of the UI kit. Open with `location.hash = '#ui-gallery'` (lazy-loaded by App).
import { useState, type ReactNode } from 'react'
import {
  ChevronDown,
  Copy,
  Database,
  Download,
  Filter,
  Inbox,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Table2,
  Trash2,
} from 'lucide-react'
import { CONNECTION_COLORS, type Dialect } from '@shared/types'
import { toggleTheme } from '@/lib/theme'
import { useUi } from '@/stores/ui'
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  CodeBlock,
  ColorTag,
  Combobox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DialectIcon,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  RadioCards,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  SkeletonLines,
  Spinner,
  StatusDot,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  ToolbarSpacer,
  Tooltip,
} from './index'

const SAMPLE_SQL = `-- Revenue per month
SELECT date_trunc('month', o.created_at) AS month,
       count(*)::int AS orders,
       sum(o.total) FILTER (WHERE o.status = 'paid') AS revenue
FROM public.orders o
WHERE o.created_at >= now() - interval '1 year'
GROUP BY 1
ORDER BY 1 DESC
LIMIT 12;`

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-line py-6">
      <h2 className="text-2xs font-semibold uppercase tracking-[0.08em] text-subtle">{title}</h2>
      {children}
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

export function Gallery() {
  const [text, setText] = useState('orders')
  const [port, setPort] = useState<number | null>(5432)
  const [mode, setMode] = useState('require')
  const [db, setDb] = useState<string>('datagrippe_test')
  const [checked, setChecked] = useState(true)
  const [on, setOn] = useState(true)
  const [seg, setSeg] = useState<'grid' | 'text' | 'json'>('grid')
  const [dialect, setDialect] = useState<Dialect>('postgres')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [wrap, setWrap] = useState(true)
  const ui = useUi()

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-[920px] px-8 pb-24">
        <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-line bg-surface/90 backdrop-blur">
          <h1 className="text-sm font-semibold">UI kit</h1>
          <Button size="xs" onClick={toggleTheme}>
            Toggle theme
          </Button>
        </div>

        <Section title="Buttons">
          <Row>
            <Button variant="primary" leadingIcon={Play}>
              Run
            </Button>
            <Button>Secondary</Button>
            <Button variant="outline" leadingIcon={Download}>
              Export
            </Button>
            <Button variant="subtle">Subtle</Button>
            <Button variant="ghost" trailingIcon={ChevronDown}>
              Ghost
            </Button>
            <Button variant="danger" leadingIcon={Trash2}>
              Drop
            </Button>
            <Button variant="primary" loading>
              Saving
            </Button>
            <Button disabled>Disabled</Button>
          </Row>
          <Row>
            <Button size="xs" variant="primary">
              Extra small
            </Button>
            <Button size="sm">Small</Button>
            <Button size="md" variant="primary">
              Medium
            </Button>
            <IconButton icon={RefreshCw} label="Refresh" shortcut="CmdOrCtrl+R" />
            <IconButton icon={Filter} label="Filter" active />
            <IconButton icon={Square} label="Stop" variant="subtle" size="xs" />
            <Button icon={Plus} aria-label="Add" variant="outline" />
          </Row>
          <Row>
            <Kbd shortcut="CmdOrCtrl+Shift+Enter" />
            <Kbd shortcut="CmdOrCtrl+K" size="md" />
            <Kbd shortcut="Alt+F1" variant="text" />
            <Tooltip content="Run statement" shortcut="CmdOrCtrl+Enter">
              <Button size="xs">Hover me</Button>
            </Tooltip>
          </Row>
        </Section>

        <Section title="Form controls">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Search" hint="Matches table and column names">
              <Input leadingIcon={Search} value={text} onChange={(e) => setText(e.target.value)} onClear={() => setText('')} />
            </Field>
            <Field label="Host" required error="Host is required">
              <Input invalid mono placeholder="db.example.com" />
            </Field>
            <Field label="Port">
              <NumberInput value={port} min={1} max={65535} onValueChange={setPort} />
            </Field>
            <Field label="SSL mode">
              <Select
                value={mode}
                onValueChange={setMode}
                options={[
                  { label: 'Unencrypted', options: [{ value: 'disable', label: 'Disable' }] },
                  {
                    label: 'Encrypted',
                    options: [
                      { value: 'prefer', label: 'Prefer', hint: 'default' },
                      { value: 'require', label: 'Require' },
                      { value: 'verify-full', label: 'Verify full' },
                    ],
                  },
                ]}
              />
            </Field>
            <Field label="Database">
              <Combobox
                value={db}
                onValueChange={setDb}
                icon={Database}
                options={[
                  { value: 'datagrippe_test', label: 'datagrippe_test', hint: '12 MB' },
                  { value: 'postgres', label: 'postgres', hint: '8 MB' },
                  { value: 'template1', label: 'template1', group: 'System' },
                ]}
              />
            </Field>
            <Field label="Notes">
              <Textarea rows={2} placeholder="Optional" />
            </Field>
          </div>
          <Row>
            <Checkbox checked={checked} onCheckedChange={setChecked} label="Save password" description="Encrypted with the OS keychain" />
            <Checkbox checked="indeterminate" onCheckedChange={() => undefined} />
            <Switch checked={on} onCheckedChange={setOn} aria-label="Toggle" />
            <Switch size="sm" checked={!on} onCheckedChange={(v) => setOn(!v)} aria-label="Toggle small" />
            <SegmentedControl
              value={seg}
              onValueChange={setSeg}
              options={[
                { value: 'grid', label: 'Grid', icon: Table2 },
                { value: 'text', label: 'Text' },
                { value: 'json', label: 'JSON' },
              ]}
            />
          </Row>
          <RadioCards
            value={dialect}
            onValueChange={setDialect}
            options={[
              { value: 'postgres', title: 'PostgreSQL', description: 'Version 12 and later', icon: <DialectIcon dialect="postgres" size={24} /> },
              { value: 'mssql', title: 'SQL Server', description: '2016 and later, Azure SQL', icon: <DialectIcon dialect="mssql" size={24} /> },
            ]}
          />
        </Section>

        <Section title="Overlays">
          <Row>
            <Button onClick={() => setDialogOpen(true)}>Dialog</Button>
            <Button onClick={() => setSheetOpen(true)}>Sheet</Button>
            <Button
              onClick={() =>
                void ui.confirm({
                  title: 'Run destructive statement on “Billing production”?',
                  message: 'DELETE without WHERE · DROP TABLE',
                  detail: 'DELETE FROM public.orders;\n\nDROP TABLE public.order_items;',
                  confirmLabel: 'Run anyway',
                  danger: true,
                })
              }
            >
              Danger confirm
            </Button>
            <Button onClick={() => void ui.prompt({ title: 'Rename console', label: 'Name', defaultValue: 'Query 1', confirmLabel: 'Rename' })}>
              Prompt
            </Button>
            <Button
              onClick={() =>
                void ui.askPassword({
                  id: 'demo',
                  name: 'Billing production',
                  dialect: 'postgres',
                  host: 'db.billing.internal',
                  port: 5432,
                  database: 'billing',
                  user: 'readonly',
                  savePassword: false,
                  hasPassword: false,
                  ssl: { mode: 'require' },
                  ssh: { enabled: false, host: '', port: 22, username: '', authMethod: 'agent' },
                  color: 'red',
                  readOnly: true,
                  productionGuard: true,
                  options: {},
                  createdAt: '',
                  updatedAt: '',
                })
              }
            >
              Password
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button trailingIcon={ChevronDown}>Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Table</DropdownMenuLabel>
                <DropdownMenuItem icon={Table2} shortcut="CmdOrCtrl+Enter">
                  Open data
                </DropdownMenuItem>
                <DropdownMenuItem icon={Pencil}>Rename…</DropdownMenuItem>
                <DropdownMenuItem icon={Copy} shortcut="CmdOrCtrl+Shift+C">
                  Copy qualified name
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger icon={Download}>Export</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem>CSV</DropdownMenuItem>
                    <DropdownMenuItem>JSON</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
                  Word wrap
                </DropdownMenuCheckboxItem>
                <DropdownMenuItem disabled inset>
                  Disabled
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem icon={Trash2} danger>
                  Drop table
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger asChild>
                <Button leadingIcon={Filter}>Popover</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64">
                <Field label="WHERE">
                  <Input mono placeholder="status = 'paid'" />
                </Field>
              </PopoverContent>
            </Popover>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="flex h-7 items-center rounded-md border border-dashed border-line-strong px-3 text-xs text-subtle">Right-click me</div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem icon={Copy}>Copy</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem icon={Trash2} danger>
                  Delete
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </Row>
          <Row>
            <Button size="xs" onClick={() => toast.success('Connection saved', { description: 'Billing production' })}>
              Toast success
            </Button>
            <Button size="xs" onClick={() => toast.error('Could not connect', new Error('password authentication failed for user "readonly"'))}>
              Toast error
            </Button>
            <Button size="xs" onClick={() => toast.info('3 rows copied')}>
              Toast info
            </Button>
          </Row>
        </Section>

        <Section title="Navigation">
          <Toolbar className="rounded-md border border-line">
            <ToolbarGroup>
              <Button size="xs" variant="primary" leadingIcon={Play}>
                Run
              </Button>
              <IconButton size="xs" icon={Square} label="Cancel" />
            </ToolbarGroup>
            <ToolbarSeparator />
            <Combobox size="sm" variant="ghost" icon={Database} value={db} onValueChange={setDb} options={[{ value: 'datagrippe_test', label: 'datagrippe_test' }]} />
            <ToolbarSpacer />
            <IconButton size="xs" icon={MoreHorizontal} label="More" />
          </Toolbar>
          <Tabs defaultValue="cols">
            <TabsList>
              <TabsTrigger value="cols" count={12}>
                Columns
              </TabsTrigger>
              <TabsTrigger value="idx" count={3}>
                Indexes
              </TabsTrigger>
              <TabsTrigger value="ddl">DDL</TabsTrigger>
            </TabsList>
            <TabsContent value="cols" className="py-3 text-xs text-subtle">
              Columns content
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="results">
            <TabsList variant="pill" className="w-fit">
              <TabsTrigger value="results">Results</TabsTrigger>
              <TabsTrigger value="messages" count={2}>
                Messages
              </TabsTrigger>
              <TabsTrigger value="plan">Plan</TabsTrigger>
            </TabsList>
          </Tabs>
        </Section>

        <Section title="Display">
          <Row>
            <Badge>neutral</Badge>
            <Badge tone="accent">accent</Badge>
            <Badge tone="success">success</Badge>
            <Badge tone="warning">Read-only</Badge>
            <Badge tone="danger">danger</Badge>
            <Badge tone="info">info</Badge>
            <Badge tone="outline" mono>
              varchar(255)
            </Badge>
          </Row>
          <Row>
            <StatusDot status="connected" halo />
            <StatusDot status="connecting" />
            <StatusDot status="error" />
            <StatusDot status="disconnected" />
            {CONNECTION_COLORS.map((c) => (
              <ColorTag key={c} color={c} showNone variant="square" />
            ))}
            <DialectIcon dialect="postgres" />
            <DialectIcon dialect="mssql" />
            <DialectIcon dialect="postgres" size={24} />
            <DialectIcon dialect="mssql" size={24} />
            <DialectIcon dialect="postgres" variant="glyph" size={20} />
            <DialectIcon dialect="mssql" variant="glyph" size={20} />
            <Spinner />
          </Row>
          <ProgressBar />
          <ProgressBar value={0.62} />
          <div className="grid grid-cols-3 gap-4">
            <SkeletonLines />
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 rounded-md" />
              <Skeleton width="60%" />
            </div>
            <div />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Callout tone="info" title="Connected over SSH tunnel">
              Traffic is forwarded through bastion.internal:22.
            </Callout>
            <Callout tone="warning" title="Transaction open">
              Commit or roll back before closing this console.
            </Callout>
            <Callout
              tone="danger"
              title='relation "public.order" does not exist'
              actions={
                <Button size="xs" leadingIcon={RefreshCw}>
                  Retry
                </Button>
              }
            >
              SQLSTATE 42P01 · line 3
            </Callout>
            <Callout tone="success" title="3 changes applied">
              Committed in 24 ms.
            </Callout>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="h-56 rounded-lg border border-line">
              <EmptyState
                icon={Inbox}
                title="No rows"
                description="The query returned an empty result set."
                action={
                  <Button size="xs" variant="primary">
                    Run again
                  </Button>
                }
              />
            </div>
            <div className="h-56 rounded-lg border border-line">
              <EmptyState size="compact" tone="danger" icon={Database} title="Could not load schemas" description="Connection refused" action={<Button size="xs">Retry</Button>} />
            </div>
          </div>
          <CodeBlock code={SAMPLE_SQL} />
        </Section>
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="New connection"
        description="PostgreSQL · stored locally, passwords encrypted"
        icon={<DialectIcon dialect="postgres" size={18} />}
        size="lg"
        footer={
          <>
            <Button variant="ghost" className="mr-auto">
              Test connection
            </Button>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button variant="primary">Save</Button>
          </>
        }
      >
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Host" required>
            <Input mono placeholder="localhost" />
          </Field>
          <Field label="Port">
            <NumberInput value={port} onValueChange={setPort} />
          </Field>
        </div>
      </Dialog>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Query history" description="Billing production">
        <SkeletonLines count={8} className="p-4" />
      </Sheet>
    </div>
  )
}
