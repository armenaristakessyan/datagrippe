import { createContext, useContext, type ComponentProps } from 'react'
import { Tabs as RadixTabs } from 'radix-ui'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

type TabsVariant = 'underline' | 'pill'
const VariantContext = createContext<TabsVariant>('underline')

export const Tabs = RadixTabs.Root

export interface TabsListProps extends ComponentProps<typeof RadixTabs.List> {
  /** underline: bottom-border strip (panels); pill: compact segmented look (toolbars). */
  variant?: TabsVariant
}

export function TabsList({ variant = 'underline', className, ...rest }: TabsListProps) {
  return (
    <VariantContext.Provider value={variant}>
      <RadixTabs.List
        className={cn(
          'flex shrink-0 items-center',
          variant === 'underline' ? 'h-9 gap-4 border-b border-line px-3' : 'h-7 gap-0.5 rounded-md bg-hover p-0.5',
          className,
        )}
        {...rest}
      />
    </VariantContext.Provider>
  )
}

export interface TabsTriggerProps extends ComponentProps<typeof RadixTabs.Trigger> {
  icon?: IconLike
  /** Small count/badge after the label. */
  count?: number | string
}

export function TabsTrigger({ icon, count, className, children, ...rest }: TabsTriggerProps) {
  const variant = useContext(VariantContext)
  return (
    <RadixTabs.Trigger
      className={cn(
        'no-drag group relative inline-flex select-none items-center gap-1.5 whitespace-nowrap text-xs font-medium text-subtle outline-none transition-colors',
        'hover:text-fg focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40',
        variant === 'underline'
          ? cn(
              'h-full rounded-sm',
              'after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-transparent after:transition-colors',
              'data-[state=active]:text-fg data-[state=active]:after:bg-accent',
            )
          : 'h-full rounded-[4px] px-2.5 data-[state=active]:bg-elevated data-[state=active]:text-fg data-[state=active]:shadow-raised',
        className,
      )}
      {...rest}
    >
      {renderIcon(icon, 14)}
      {children}
      {count !== undefined && (
        <span className="rounded-full bg-active px-1.5 text-2xs leading-4 text-muted tabular group-data-[state=active]:bg-accent-soft group-data-[state=active]:text-accent">
          {count}
        </span>
      )}
    </RadixTabs.Trigger>
  )
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('min-h-0 outline-none', className)} {...rest} />
}
