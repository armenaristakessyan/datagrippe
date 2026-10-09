// The panels of the settings dialog. Every control applies immediately through the saver.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import { BUILTIN_APP_ICON, type AppInfo, type AppSettings, type ThemePreference } from '@shared/types'
import { formatSql } from '@shared/sql'
import { AppMark } from '@/components/layout/AppMark'
import { Button, Callout, CodeBlock, Input, NumberInput, RadioCards, SegmentedControl, Skeleton, Switch, toast } from '@/components/ui'
import { api, errorMessage } from '@/lib/api'
import { cn } from '@/lib/cn'
import { formatCount } from '@/lib/format'
import { useAppIcons } from '@/stores/app-icons'
import { SETTINGS_LIMITS, useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { SectionHeader, SettingRow, SettingsGroup, ThemeSwatch, useDraftSetting } from './controls'
import { TEXT_DEBOUNCE_MS, type SettingsSaver } from './useSettingsSaver'

interface SectionProps {
  saver: SettingsSaver
}

const useSetting = <K extends keyof AppSettings>(key: K): AppSettings[K] => useSettings((s) => s.settings[key])

export function AppearanceSection({ saver }: SectionProps) {
  const theme = useSetting('theme')
  const appIcon = useSetting('appIcon')
  const customIcons = useAppIcons((s) => s.icons)
  const resolved = useUi((s) => s.resolvedTheme)
  // The user may have added icons since the app started.
  useEffect(() => void useAppIcons.getState().load(), [])
  // An icon whose file was removed: the built-in one is what the Dock shows.
  const iconValue = customIcons.some((icon) => icon.id === appIcon) ? appIcon : BUILTIN_APP_ICON
  return (
    <>
      <SectionHeader title="Appearance" description="How DataGrippe looks." />
      <SettingsGroup>
        <SettingRow
          label="Theme"
          description={theme === 'system' ? `Follows your system — currently ${resolved}.` : 'Choose a palette, or follow your system.'}
        >
          <SegmentedControl<ThemePreference>
            aria-label="Theme"
            value={theme}
            onValueChange={(value) => saver.save({ theme: value })}
            options={[
              { value: 'dark', label: 'Dark', icon: <ThemeSwatch theme="dark" /> },
              { value: 'light', label: 'Light', icon: <ThemeSwatch theme="light" /> },
              { value: 'system', label: 'System', icon: <ThemeSwatch theme="system" /> },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="App icon"
          description="Shown in the Dock and the About panel. Add your own as PNG files in the icons folder."
          below={
            <div className="flex flex-col gap-2">
              <RadioCards<string>
                aria-label="App icon"
                layout="tile"
                columns={4}
                value={iconValue}
                onValueChange={(value) => saver.save({ appIcon: value })}
                options={[
                  { value: BUILTIN_APP_ICON, title: 'DataGrippe', icon: <AppMark builtin size={40} /> },
                  ...customIcons.map((icon) => ({
                    value: icon.id,
                    title: icon.label,
                    icon: <img src={icon.dataUrl} width={40} height={40} alt="" draggable={false} className="shrink-0" />,
                  })),
                ]}
              />
              <Button
                size="xs"
                variant="ghost"
                leadingIcon={FolderOpen}
                className="self-start"
                onClick={() => void api.app.openIconsFolder().catch((error: unknown) => toast.error('Could not open the icons folder', error))}
              >
                Open icons folder
              </Button>
            </div>
          }
        />
      </SettingsGroup>
    </>
  )
}

export function EditorSection({ saver }: SectionProps) {
  const [fontSize, setFontSize] = useDraftSetting('editorFontSize', saver)
  const [tabSize, setTabSize] = useDraftSetting('editorTabSize', saver)
  const wordWrap = useSetting('editorWordWrap')
  const minimap = useSetting('editorMinimap')
  return (
    <>
      <SectionHeader title="Editor" description="The SQL editor of consoles." />
      <SettingsGroup>
        <SettingRow
          label="Font size"
          htmlFor="settings-font-size"
          description={`${SETTINGS_LIMITS.editorFontSize.min}–${SETTINGS_LIMITS.editorFontSize.max} px`}
        >
          <NumberInput
            id="settings-font-size"
            value={fontSize}
            min={SETTINGS_LIMITS.editorFontSize.min}
            max={SETTINGS_LIMITS.editorFontSize.max}
            onValueChange={(v) => v !== null && setFontSize(v)}
            trailing={<span className="text-xs text-subtle">px</span>}
            wrapperClassName="w-[92px]"
          />
        </SettingRow>
        <SettingRow label="Tab size" htmlFor="settings-tab-size" description="Spaces inserted for a tab, also used when formatting.">
          <NumberInput
            id="settings-tab-size"
            value={tabSize}
            min={SETTINGS_LIMITS.editorTabSize.min}
            max={SETTINGS_LIMITS.editorTabSize.max}
            onValueChange={(v) => v !== null && setTabSize(v)}
            wrapperClassName="w-[92px]"
          />
        </SettingRow>
        <SettingRow label="Word wrap" htmlFor="settings-word-wrap" description="Wrap long lines instead of scrolling horizontally.">
          <Switch id="settings-word-wrap" checked={wordWrap} onCheckedChange={(v) => saver.save({ editorWordWrap: v })} />
        </SettingRow>
        <SettingRow label="Minimap" htmlFor="settings-minimap" description="Show a code overview on the right of the editor.">
          <Switch id="settings-minimap" checked={minimap} onCheckedChange={(v) => saver.save({ editorMinimap: v })} />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

export const MAX_ROWS_PRESETS = [100, 500, 1000, 5000, 10_000] as const

export function QuerySection({ saver }: SectionProps) {
  const [maxRows, setMaxRows] = useDraftSetting('maxRows', saver)
  const [nullDisplay, setNullDisplay] = useDraftSetting('nullDisplay', saver, TEXT_DEBOUNCE_MS)
  const confirmDestructive = useSetting('confirmDestructive')
  const detectParameters = useSetting('detectParameters')
  return (
    <>
      <SectionHeader title="Query" description="Running statements and showing their results." />
      <SettingsGroup>
        <SettingRow
          label="Rows per result"
          htmlFor="settings-max-rows"
          description="Fetched per result set; the rest loads on demand."
          below={
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Rows per result presets">
              {MAX_ROWS_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  size="xs"
                  variant="subtle"
                  active={maxRows === preset}
                  aria-pressed={maxRows === preset}
                  onClick={() => setMaxRows(preset)}
                  className="tabular"
                >
                  {formatCount(preset)}
                </Button>
              ))}
            </div>
          }
        >
          <NumberInput
            id="settings-max-rows"
            value={maxRows}
            min={SETTINGS_LIMITS.maxRows.min}
            max={SETTINGS_LIMITS.maxRows.max}
            step={100}
            onValueChange={(v) => v !== null && setMaxRows(v)}
            wrapperClassName="w-[112px]"
          />
        </SettingRow>
        <SettingRow label="NULL display" htmlFor="settings-null-display" description="Shown in grid cells holding NULL.">
          <span
            aria-hidden
            className="flex h-6 min-w-12 items-center justify-center rounded-[4px] border border-line bg-panel px-2 font-mono text-xs italic text-grid-null"
          >
            {nullDisplay || ' '}
          </span>
          <Input
            id="settings-null-display"
            mono
            value={nullDisplay}
            maxLength={SETTINGS_LIMITS.nullDisplayMaxLength}
            placeholder="(empty)"
            onChange={(e) => setNullDisplay(e.target.value)}
            wrapperClassName="w-[132px]"
          />
        </SettingRow>
        <SettingRow
          label="Confirm destructive statements on production connections"
          htmlFor="settings-confirm-destructive"
          description="Ask before DROP, TRUNCATE, or DELETE/UPDATE without WHERE on connections marked “Production connection” (connection settings › Advanced). When off, they run without asking."
        >
          <Switch
            id="settings-confirm-destructive"
            checked={confirmDestructive}
            onCheckedChange={(v) => saver.save({ confirmDestructive: v })}
          />
        </SettingRow>
        <SettingRow
          label="Detect query parameters"
          htmlFor="settings-detect-parameters"
          description=":name, $1, ?, @name and ${name} prompt for values before a run."
        >
          <Switch id="settings-detect-parameters" checked={detectParameters} onCheckedChange={(v) => saver.save({ detectParameters: v })} />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

const FORMAT_SAMPLE =
  'select c.id, c.name, count(o.id) as order_count from customers c left join orders o on o.customer_id = c.id where c.active = true group by c.id, c.name order by order_count desc'

export function FormattingSection({ saver }: SectionProps) {
  const keywordCase = useSetting('formatKeywordCase')
  const tabSize = useSetting('editorTabSize')
  const preview = useMemo(() => formatSql(FORMAT_SAMPLE, 'postgres', { keywordCase, tabWidth: tabSize }), [keywordCase, tabSize])
  return (
    <>
      <SectionHeader title="Formatting" description="Applied by Format SQL in consoles." />
      <SettingsGroup>
        <SettingRow
          label="Keyword case"
          description="Upper- or lower-case SQL keywords, or keep them as typed."
          below={<CodeBlock code={preview} copyable={false} maxHeight={180} className="bg-panel" />}
        >
          <SegmentedControl<AppSettings['formatKeywordCase']>
            aria-label="Keyword case"
            value={keywordCase}
            onValueChange={(value) => saver.save({ formatKeywordCase: value })}
            options={[
              { value: 'upper', label: 'UPPER' },
              { value: 'lower', label: 'lower' },
              { value: 'preserve', label: 'Preserve' },
            ]}
          />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

export function DataGridSection({ saver }: SectionProps) {
  const rowNumbers = useSetting('gridRowNumbers')
  return (
    <>
      <SectionHeader title="Data grid" description="Result sets and table data." />
      <SettingsGroup>
        <SettingRow
          label="Row numbers"
          htmlFor="settings-row-numbers"
          description="Show a numbered gutter on the left of grids."
          below={<GridPreview rowNumbers={rowNumbers} />}
        >
          <Switch id="settings-row-numbers" checked={rowNumbers} onCheckedChange={(v) => saver.save({ gridRowNumbers: v })} />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}

function GridPreview({ rowNumbers }: { rowNumbers: boolean }) {
  const nullDisplay = useSetting('nullDisplay')
  const rows: [string, string, string | null][] = [
    ['1', 'Ada Lovelace', 'ada@example.com'],
    ['2', 'Alan Turing', null],
  ]
  return (
    <div aria-hidden className="overflow-hidden rounded-md border border-line bg-surface font-mono text-xs">
      <div className="flex h-6 items-center border-b border-line bg-grid-header text-2xs font-medium text-muted">
        {rowNumbers && <span className="w-8 shrink-0 border-r border-line" />}
        <span className="w-12 shrink-0 px-2 text-right">id</span>
        <span className="w-32 shrink-0 px-2">name</span>
        <span className="min-w-0 flex-1 px-2">email</span>
      </div>
      {rows.map(([id, name, email], i) => (
        <div key={id} className={cn('flex h-6 items-center text-fg', i % 2 === 1 && 'bg-grid-row-alt')}>
          {rowNumbers && <span className="w-8 shrink-0 border-r border-line pr-2 text-right text-2xs text-faint tabular">{i + 1}</span>}
          <span className="w-12 shrink-0 px-2 text-right tabular">{id}</span>
          <span className="w-32 shrink-0 truncate px-2">{name}</span>
          <span className={cn('min-w-0 flex-1 truncate px-2', email === null && 'italic text-grid-null')}>{email ?? nullDisplay}</span>
        </div>
      ))}
    </div>
  )
}

type InfoState = { status: 'loading' } | { status: 'ready'; info: AppInfo } | { status: 'error'; error: string }

const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

export function AboutSection() {
  const [state, setState] = useState<InfoState>({ status: 'loading' })
  const load = useCallback(() => {
    setState({ status: 'loading' })
    api.app
      .info()
      .then((info) => setState({ status: 'ready', info }))
      .catch((error: unknown) => setState({ status: 'error', error: errorMessage(error) }))
  }, [])
  useEffect(load, [load])

  const reveal = (path: string) => {
    void api.app.showItemInFolder(path).catch(() => undefined)
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-3.5">
        <AppMark size={44} />
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-fg">DataGrippe</h2>
          <p className="text-xs text-subtle">A calm database IDE for PostgreSQL and SQL Server.</p>
        </div>
      </div>
      {state.status === 'error' ? (
        <Callout
          tone="danger"
          title="Could not read the application info"
          actions={
            <Button size="xs" leadingIcon={RefreshCw} onClick={load}>
              Retry
            </Button>
          }
        >
          {state.error}
        </Callout>
      ) : (
        <SettingsGroup>
          <InfoRow label="Version" value={state.status === 'ready' ? state.info.version : undefined} />
          <InfoRow label="Electron" value={state.status === 'ready' ? state.info.electronVersion : undefined} />
          <InfoRow
            label="Platform"
            value={state.status === 'ready' ? (PLATFORM_LABEL[state.info.platform] ?? state.info.platform) : undefined}
          />
          <div className="flex items-center gap-4 px-3.5 py-2.5">
            <span className="w-24 shrink-0 text-sm text-muted">Data folder</span>
            {state.status === 'ready' ? (
              <>
                <span className="selectable min-w-0 flex-1 truncate font-mono text-xs text-fg" title={state.info.userDataPath}>
                  {state.info.userDataPath}
                </span>
                <Button size="xs" variant="ghost" leadingIcon={FolderOpen} onClick={() => reveal(state.info.userDataPath)}>
                  Reveal
                </Button>
              </>
            ) : (
              <Skeleton className="flex-1" height={12} />
            )}
          </div>
        </SettingsGroup>
      )}
      <p className="mt-5 text-2xs leading-4 text-subtle">
        Built with Electron, React, Monaco Editor, node-postgres, tedious, Radix UI, cmdk, Tailwind CSS and Lucide icons.
        Connections, settings and history stay on this machine; passwords are encrypted by the operating system.
      </p>
    </>
  )
}

function InfoRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex h-10 items-center gap-4 px-3.5">
      <span className="w-24 shrink-0 text-sm text-muted">{label}</span>
      {value === undefined ? (
        <Skeleton width={96} height={12} />
      ) : (
        <span className="selectable min-w-0 truncate font-mono text-xs text-fg tabular">{value}</span>
      )}
    </div>
  )
}
