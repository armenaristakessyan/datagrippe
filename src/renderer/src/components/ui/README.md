# UI kit

Import everything from `@/components/ui`. All components use the semantic tokens of `styles.css`
(dark default, `.light` on `<html>`), lucide icons at 14–16px / strokeWidth 1.75, and `cn()` for
class merging (`className` always wins). Icons props accept an `IconLike`: either a component
(`Plus` from lucide-react — rendered at the kit's size) or an element (`<Plus size={12} />`).

Global pieces are mounted once by the app shell: `<TooltipProvider>` (App.tsx) and `<Toaster/>`.

## Actions

| Component | Props | Usage |
| --- | --- | --- |
| `Button` | `variant` primary · secondary (default) · ghost · subtle · danger · outline; `size` xs (24px) · sm (28px, default) · md (32px); `leadingIcon`, `trailingIcon`, `icon` (icon-only square when no children), `loading`, `active` (pressed look), `asChild`, all `<button>` props | `<Button variant="primary" leadingIcon={Play} loading={running}>Run</Button>` |
| `IconButton` | `icon`, `label` (aria + tooltip), `shortcut`, `variant` (ghost), `size`, `active`, `loading`, `tooltipSide`, `noTooltip` | `<IconButton icon={RefreshCw} label="Refresh" shortcut="CmdOrCtrl+R" onClick={reload} />` |
| `Tooltip` | `content`, `shortcut`, `side` (bottom), `align`, `delayDuration` (400ms via provider); child must accept a ref | `<Tooltip content="Commit" shortcut="CmdOrCtrl+Enter"><Button …/></Tooltip>` |
| `Kbd` | `shortcut` (accelerator like `CmdOrCtrl+Shift+Enter`, or symbolic `⌘↵`), `variant` keys (keycaps) · text (plain, for menus), `size` sm · md | `<Kbd shortcut="CmdOrCtrl+K" />` → ⌘ K on mac, Ctrl K elsewhere |

Shortcut strings: use Electron accelerator syntax everywhere (`Command.shortcut` too). Formatting
lives in `@/lib/shortcuts` (`formatShortcut`, `shortcutTokens`, `MENU_ACCELERATORS`).

## Form controls

| Component | Props | Usage |
| --- | --- | --- |
| `Input` | `size` sm (24) · md (28, default) · lg (32); `leadingIcon`, `trailing` (node inside the box), `onClear` (× when non-empty), `invalid`, `mono`, `wrapperClassName`, `ref`, all `<input>` props | `<Input leadingIcon={Search} value={q} onChange={e => setQ(e.target.value)} onClear={() => setQ('')} />` |
| `Textarea` | `invalid`, `mono`, all `<textarea>` props | `<Textarea mono rows={4} value={sql} onChange={…} />` |
| `NumberInput` | `value: number \| null`, `onValueChange`, `min`, `max`, `step`, `integer` (true), `allowEmpty`, `hideStepper` + Input props. Commits on blur/Enter, ↑/↓ step | `<NumberInput value={port} min={1} max={65535} onValueChange={v => v !== null && setPort(v)} />` |
| `Select` | `value`, `onValueChange`, `options` (`SelectOption` `{value,label,icon?,hint?,triggerLabel?,disabled?}` or groups `{label, options}`), `placeholder`, `size` sm · md, `icon`, `variant` default · ghost, `invalid`, `disabled` | `<Select value={mode} onValueChange={setMode} options={[{value:'require',label:'Require'}]} />` |
| `Combobox` | `value`, `onValueChange`, `options` (`{value,label,render?,icon?,hint?,group?,keywords?}`), `placeholder`, `searchPlaceholder`, `emptyText`, `loading`, `error`, `size`, `variant` default · ghost, `icon`, `width`, `align`, `onOpen` (lazy load), `footer` | `<Combobox variant="ghost" size="sm" icon={Database} value={db} options={dbs} onOpen={load} onValueChange={setDb} />` |
| `Checkbox` | `checked` (`boolean \| 'indeterminate'`), `onCheckedChange`, `label`, `description`, `disabled` | `<Checkbox checked={save} onCheckedChange={setSave} label="Save password" />` |
| `Switch` | `checked`, `onCheckedChange`, `size` sm · md, `label`, `description` (label left, switch right) | `<Switch checked={ro} onCheckedChange={setRo} label="Read-only" description="Block writes" />` |
| `SegmentedControl` | `value`, `onValueChange`, `options` `{value,label?,icon?,ariaLabel?}`, `size` xs · sm, `fill` | `<SegmentedControl value={view} onValueChange={setView} options={[{value:'grid',label:'Grid'},{value:'text',label:'Text'}]} />` |
| `RadioCards` | `value`, `onValueChange`, `options` `{value,title,description?,icon?}`, `columns`, `layout` (`row` / `tile`: icon above the title) | `<RadioCards value={dialect} onValueChange={setDialect} options={[{value:'postgres',title:'PostgreSQL',icon:<DialectIcon dialect="postgres" size={20}/>}]} />` |
| `Field` | `label`, `htmlFor`, `hint`, `error` (replaces hint, red), `required` (red *), `labelAside`, `inline` (label left / control right) | `<Field label="Host" htmlFor="host" required error={err}><Input id="host" …/></Field>` |

`controlClassName` is the shared field chrome (border, focus ring, invalid) for custom controls.

## Overlays

| Component | Props | Usage |
| --- | --- | --- |
| `Dialog` | `open`, `onOpenChange`, `title`, `description`, `icon`, `tone` neutral · accent · danger · warning (icon tile), `size` sm 400 · md 520 · lg 680 · xl 880, `footer`, `flush` (no body padding), `hideClose`, `modalLock` (ignore outside clicks), `onOpenAutoFocus`, `bodyClassName` | `<Dialog open={o} onOpenChange={setO} title="New connection" size="lg" footer={<><Button>Cancel</Button><Button variant="primary">Save</Button></>}>…</Dialog>` |
| `DialogFooter` / `DialogClose` | footer bar for custom layouts; Radix close (use `asChild`) | `<DialogClose asChild><Button>Cancel</Button></DialogClose>` |
| `Sheet` | `open`, `onOpenChange`, `title`, `description`, `side` right · left, `width` (440), `headerActions`, `footer`, `overlay` (true) | `<Sheet open={o} onOpenChange={setO} title="History" headerActions={<Input …/>}>…</Sheet>` |
| `Popover` + `PopoverTrigger`, `PopoverContent` (`align` start, `sideOffset` 6, padded `p-3`), `PopoverAnchor`, `PopoverClose` | Radix popover | `<Popover><PopoverTrigger asChild><Button>Filter</Button></PopoverTrigger><PopoverContent>…</PopoverContent></Popover>` |
| `DropdownMenu` family | `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` (`icon`, `shortcut`, `danger`, `disabled`, `inset`, `onSelect`), `DropdownMenuCheckboxItem` (`checked`, `onCheckedChange`; stays open), `DropdownMenuRadioGroup` + `DropdownMenuRadioItem`, `DropdownMenuSub` + `DropdownMenuSubTrigger` + `DropdownMenuSubContent`, `DropdownMenuSeparator`, `DropdownMenuLabel` | `<DropdownMenuItem icon={Trash2} danger shortcut="CmdOrCtrl+Backspace" onSelect={drop}>Drop table</DropdownMenuItem>` |
| `ContextMenu` family | Same API with the `ContextMenu*` prefix; wrap the target in `<ContextMenuTrigger asChild>` | `<ContextMenu><ContextMenuTrigger asChild><div/></ContextMenuTrigger><ContextMenuContent>…</ContextMenuContent></ContextMenu>` |
| `Toaster` / `toast` | `toast.success(title, {description, action})`, `toast.error(title, error?, options)` (shows `errorMessage(error)`), `toast.info`, `toast.warning`, `toast.message`, `toast.loading`, `toast.promise(p, {loading, success, error})`, `toast.dismiss(id)` | `toast.error('Could not connect', err)` |

`floatingSurface`, `menuContentClass`, `menuItemClass`, `overlayClass` expose the shared styles.

## Navigation & layout

| Component | Props | Usage |
| --- | --- | --- |
| `Tabs`, `TabsList` (`variant` underline · pill), `TabsTrigger` (`icon`, `count`), `TabsContent` | Radix tabs | `<Tabs value={t} onValueChange={setT}><TabsList><TabsTrigger value="cols" count={12}>Columns</TabsTrigger></TabsList><TabsContent value="cols">…</TabsContent></Tabs>` |
| `Toolbar` (`size` sm 32 · md 36, `bordered`), `ToolbarGroup`, `ToolbarSeparator`, `ToolbarSpacer` | bar at the top of a view | `<Toolbar><ToolbarGroup>…</ToolbarGroup><ToolbarSeparator/><ToolbarSpacer/>…</Toolbar>` |
| `SplitGroup` (`orientation` horizontal · vertical, `onLayoutChanged`, `defaultLayout`), `SplitPanel` (`defaultSize`, `minSize`, `maxSize`, `collapsible`, `panelRef`, `groupResizeBehavior`; numbers = px, `"30"`/`"30%"` = percent), `SplitHandle` (`direction` vertical for horizontal groups · horizontal for vertical groups) | react-resizable-panels v4 (`Group`/`Panel`/`Separator`); `usePanelRef`, `useGroupRef` re-exported | `<SplitGroup orientation="vertical"><SplitPanel minSize={80}>…</SplitPanel><SplitHandle direction="horizontal"/><SplitPanel defaultSize="40">…</SplitPanel></SplitGroup>` |
| `ErrorBoundary` | `fallback(error, reset)`, `resetKeys`, `name` (recorded in `window.__datagrippeErrors`) | `<ErrorBoundary fallback={(e, reset) => <EmptyState … />}>…</ErrorBoundary>` |

## Display & feedback

| Component | Props | Usage |
| --- | --- | --- |
| `Badge` | `tone` neutral · accent · success · warning · danger · info · outline, `icon`, `size` sm · md, `mono` | `<Badge tone="warning">Read-only</Badge>` |
| `StatusDot` | `status` (`ConnectionStatus` or success · warning · danger · info · neutral), `size` (7), `halo`, `label`; `connecting` pulses | `<StatusDot status={runtime.status} />` |
| `ColorTag` | `color: ConnectionColor`, `variant` dot · square · bar (3px stripe), `size`, `showNone`; `connectionColorVar(color)` returns the CSS colour | `<ColorTag color={c.color} />` |
| `DialectIcon` | `dialect`, `size` (16), `title` (`''` = decorative); engine logos from `assets/dialects/` (128 px PNG) | `<DialectIcon dialect="mssql" size={20} />` |
| `Spinner` | `size` (14), `label` | `<Spinner className="text-subtle" />` |
| `ProgressBar` | `value` 0..1 (omit = indeterminate 2px bar), `tone` accent · warning · danger | `{running && <ProgressBar className="absolute inset-x-0 top-0" />}` |
| `Skeleton`, `SkeletonLines` | `width`, `height`, `className` / `count` | `<SkeletonLines count={6} className="p-3" />` |
| `EmptyState` | `icon`, `title`, `description` (one line), `action`, `size` compact · default, `tone` neutral · danger, `children` | `<EmptyState icon={Table2} title="No rows" description="The query returned an empty result." action={<Button size="sm">Run again</Button>} />` |
| `Callout` | `tone` info · warning · danger · success, `title`, `icon` (or `null`), `actions`, `children` | `<Callout tone="danger" title={err.message} actions={<Button size="xs" onClick={retry}>Retry</Button>}>{err.detail}</Callout>` |
| `CodeBlock` | `code`, `language` sql · text, `copyable` (true), `maxHeight`, `wrap` (true) | `<CodeBlock code={ddl} maxHeight={320} />` |
| `SqlText` | `code` — inline highlighted SQL | `<SqlText code={entry.sql} className="truncate text-xs" />` |
| `highlightSql(sql)` / `SQL_TOKEN_CLASS` | tokenizer used by CodeBlock (`--c-syn-*` colours) | `highlightSql('select 1')` |

## Data grid (`@/components/grid/DataGrid`)

Not part of the kit's index, but shared by query results and the table editor (contract: `DataGridProps`).
Virtualized rows and columns; uncontrolled client-side sort, or controlled with `sort` + `onSortChange`.
Optional props worth knowing: `primaryKeyColumns` (key glyph in the header), `aria-label`, `getRowState` /
`isCellModified` (pending-change styling), `getCellPlaceholder` (dimmed text such as `DEFAULT` for a cell with no
value yet; the editor opens empty), `contextMenuItems`, `hasMore` + `onLoadMore` (infinite scroll).
Keys: Space toggles the value inspector, Cmd/Ctrl+Backspace sets NULL, Shift+click on a header's sort button
adds a secondary sort.

`<DataGrid columns={cols} rows={rows} editable onCellEdit={(r, c, v) => edit(r, c, v)} />`

## States checklist

Every view: loading (`Skeleton`/`Spinner`/`ProgressBar`), empty (`EmptyState` with icon + one line
+ primary action), error (`Callout tone="danger"` or `EmptyState tone="danger"` with a Retry button).
Focus rings come from `focus-visible`; never remove them.

## Utilities in `@/lib`

- `format.ts`: `formatBytes`, `formatDuration` ("12 ms", "1.4 s", "2 min 3 s"), `formatCount` ("1 234"
  with narrow no-break spaces), `pluralize`, `formatRelativeTime`, `formatTimestamp`.
- `shortcuts.ts`: `formatShortcut`, `shortcutTokens`, `parseAccelerator`, `MENU_ACCELERATORS`.
- `theme.ts`: `bindTheme()` (App), `toggleTheme()`, `resolveTheme()`; the applied theme is `useUi().resolvedTheme`.
- `platform.ts`: `isMac()`, `hostPlatform()`, `recordRendererError()`.

## Living style guide

Every component above is rendered in `Gallery.tsx`. In a running app, open DevTools and run
`location.hash = '#ui-gallery'` (clear the hash to return). Lazy-loaded; not part of the shell bundle.

## App shell helpers (`@/components/layout/*`)

- `newConsole(connectionId?)` (`useGlobalCommands.ts`): opens a console for the given connection, else the
  active tab's → explorer selection (node ids start with `<connectionId>|`) → first connected → first saved;
  opens the connection dialog when none exist.
- Tabs store: `registerCloseGuard((tab) => boolean | Promise<boolean>)` lets a feature veto closing a tab
  (table tabs ask before discarding pending edits).
- `renameConsoleTab(tab)` (`TabBar.tsx`): prompt + rename.
- `AppMark` (`AppMark.tsx`): the app logo tile.
- Global commands registered by the shell: `new-console`, `new-connection`, `close-tab`, `close-other-tabs`,
  `next-tab`, `previous-tab` (Window menu: Ctrl+Tab / Ctrl+Shift+Tab, plus hidden ⌘⇧] / ⌘⇧[ on mac), `command-palette`, `go-to-object`,
  `toggle-sidebar`, `toggle-theme`, `open-history`, `open-settings`.
- Console tabs stay mounted while hidden (`display: none`); table/structure tabs mount only while active. Each tab
  view is wrapped in an `ErrorBoundary` with a "Reload tab" fallback.
