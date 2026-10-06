// Settings dialog (driven by useUi().settingsOpen): left navigation, changes apply immediately.
import { useState, type ReactNode } from 'react'
import { Check, CircleAlert, Grid3x3, Info, Palette, SquareTerminal, WandSparkles, Zap } from 'lucide-react'
import { Dialog, Spinner, Tabs, TabsContent, TabsList, TabsTrigger, type IconLike } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useUi } from '@/stores/ui'
import { AboutSection, AppearanceSection, DataGridSection, EditorSection, FormattingSection, QuerySection } from './sections'
import { useSettingsSaver, type SaveStatus, type SettingsSaver } from './useSettingsSaver'

type SectionId = 'appearance' | 'editor' | 'query' | 'formatting' | 'grid' | 'about'

const SECTIONS: { id: SectionId; label: string; icon: IconLike; render: (saver: SettingsSaver) => ReactNode }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette, render: (saver) => <AppearanceSection saver={saver} /> },
  { id: 'editor', label: 'Editor', icon: SquareTerminal, render: (saver) => <EditorSection saver={saver} /> },
  { id: 'query', label: 'Query', icon: Zap, render: (saver) => <QuerySection saver={saver} /> },
  { id: 'formatting', label: 'Formatting', icon: WandSparkles, render: (saver) => <FormattingSection saver={saver} /> },
  { id: 'grid', label: 'Data grid', icon: Grid3x3, render: (saver) => <DataGridSection saver={saver} /> },
  { id: 'about', label: 'About', icon: Info, render: () => <AboutSection /> },
]

// Remembered while the app runs, so reopening lands where the user left.
let lastSection: SectionId = 'appearance'

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen)
  const setOpen = useUi((s) => s.setSettingsOpen)
  // The dialog content (and with it the body) mounts only while open: pending saves flush on close.
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="lg"
      flush
      title="Settings"
      bodyClassName="mt-3 overflow-hidden border-t border-line"
      onOpenAutoFocus={(e) => {
        // Start on the section list (arrow keys move between sections) rather than the close button.
        const tab = document.querySelector<HTMLElement>('#settings-nav [data-state="active"]')
        if (tab) {
          e.preventDefault()
          tab.focus()
        }
      }}
    >
      <SettingsBody />
    </Dialog>
  )
}

function SettingsBody() {
  const saver = useSettingsSaver()
  const [section, setSection] = useState<SectionId>(lastSection)
  return (
    <Tabs
      orientation="vertical"
      value={section}
      onValueChange={(v) => {
        const match = SECTIONS.find((s) => s.id === v)
        if (!match) return
        lastSection = match.id
        setSection(match.id)
      }}
      className="flex h-[min(480px,calc(80vh-96px))] min-h-0"
    >
      <div className="flex w-[176px] shrink-0 flex-col border-r border-line bg-panel/50">
        <TabsList id="settings-nav" variant="pill" aria-label="Settings sections" className="h-auto flex-col items-stretch gap-0.5 rounded-none bg-transparent p-2">
          {SECTIONS.map((s) => (
            <TabsTrigger
              key={s.id}
              value={s.id}
              icon={s.icon}
              className={cn(
                'h-7 justify-start gap-2 rounded-md px-2 text-sm font-normal text-muted hover:bg-hover',
                'data-[state=active]:bg-active data-[state=active]:font-medium data-[state=active]:text-fg data-[state=active]:shadow-none',
                '[&>svg]:text-subtle data-[state=active]:[&>svg]:text-fg',
              )}
            >
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="mt-auto flex h-9 items-center px-4">
          <SaveIndicator status={saver.status} />
        </div>
      </div>
      {SECTIONS.map((s) => (
        <TabsContent key={s.id} value={s.id} className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {s.render(saver)}
        </TabsContent>
      ))}
    </Tabs>
  )
}

function SaveIndicator({ status }: { status: SaveStatus }) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center gap-1 text-2xs font-normal transition-opacity duration-150',
        status === 'idle' ? 'opacity-0' : 'opacity-100',
        status === 'error' ? 'text-danger' : 'text-subtle',
      )}
    >
      {status === 'saving' && (
        <>
          <Spinner size={10} />
          Saving…
        </>
      )}
      {status === 'saved' && (
        <>
          <Check size={11} strokeWidth={2.25} className="text-success" />
          Saved
        </>
      )}
      {status === 'error' && (
        <>
          <CircleAlert size={11} strokeWidth={2.25} />
          Not saved
        </>
      )}
    </span>
  )
}
