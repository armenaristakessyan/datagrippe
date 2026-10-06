// DropdownMenu and ContextMenu share one look: icon · label · shortcut, danger, disabled,
// checkbox / radio items, submenus, separators and section labels.
import type { ComponentProps, ReactNode } from 'react'
import { ContextMenu as RadixContext, DropdownMenu as RadixDropdown } from 'radix-ui'
import { Check, ChevronRight, Dot } from 'lucide-react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'
import { Kbd } from './Kbd'
import { floatingSurface } from './Popover'

export const menuContentClass = cn(floatingSurface, 'min-w-[200px] overflow-hidden p-1')

export const menuItemClass = cn(
  'group relative flex h-7 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-sm text-fg outline-none',
  'data-[highlighted]:bg-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
  'data-[state=open]:bg-hover',
)
const dangerClass = 'text-danger data-[highlighted]:bg-danger-soft'
const separatorClass = '-mx-1 my-1 h-px bg-line'
const labelClass = 'px-2 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wider text-subtle'

export interface MenuItemContentProps {
  icon?: IconLike
  shortcut?: string
  /** Space reserved for the icon column even without an icon (aligns with checkbox items). */
  inset?: boolean
  children: ReactNode
}

function ItemContent({ icon, shortcut, inset, children }: MenuItemContentProps) {
  return (
    <>
      {icon ? (
        <span className="flex w-4 shrink-0 justify-center text-muted group-data-[danger=true]:text-danger">{renderIcon(icon, 14)}</span>
      ) : (
        inset && <span className="w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd variant="text" shortcut={shortcut} className="ml-4 shrink-0" />}
    </>
  )
}

interface ItemBaseProps extends MenuItemContentProps {
  danger?: boolean
  disabled?: boolean
  onSelect?: (event: Event) => void
  className?: string
}

interface CheckItemProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  shortcut?: string
  disabled?: boolean
  children: ReactNode
  className?: string
}

const indicator = (
  <span className="flex w-4 shrink-0 justify-center text-accent">
    <Check size={13} strokeWidth={2.25} />
  </span>
)

// --- DropdownMenu -------------------------------------------------------------

export const DropdownMenu = RadixDropdown.Root
export const DropdownMenuTrigger = RadixDropdown.Trigger
export const DropdownMenuGroup = RadixDropdown.Group
export const DropdownMenuSub = RadixDropdown.Sub
export const DropdownMenuRadioGroup = RadixDropdown.RadioGroup

export function DropdownMenuContent({ className, sideOffset = 4, align = 'start', ...rest }: ComponentProps<typeof RadixDropdown.Content>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(menuContentClass, className)}
        {...rest}
      />
    </RadixDropdown.Portal>
  )
}

export function DropdownMenuItem({ icon, shortcut, inset, danger, disabled, onSelect, className, children }: ItemBaseProps) {
  return (
    <RadixDropdown.Item
      disabled={disabled}
      onSelect={onSelect}
      data-danger={danger || undefined}
      className={cn(menuItemClass, danger && dangerClass, className)}
    >
      <ItemContent icon={icon} shortcut={shortcut} inset={inset}>
        {children}
      </ItemContent>
    </RadixDropdown.Item>
  )
}

export function DropdownMenuCheckboxItem({ checked, onCheckedChange, shortcut, disabled, children, className }: CheckItemProps) {
  return (
    <RadixDropdown.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      onSelect={(e) => e.preventDefault()}
      className={cn(menuItemClass, className)}
    >
      {checked ? indicator : <span className="w-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd variant="text" shortcut={shortcut} className="ml-4" />}
    </RadixDropdown.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({ value, disabled, children, className }: { value: string; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <RadixDropdown.RadioItem value={value} disabled={disabled} className={cn(menuItemClass, className)}>
      <span className="flex w-4 shrink-0 justify-center">
        <RadixDropdown.ItemIndicator className="text-accent">
          <Dot size={20} strokeWidth={3} />
        </RadixDropdown.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </RadixDropdown.RadioItem>
  )
}

export function DropdownMenuSubTrigger({ icon, inset, disabled, children, className }: Omit<ItemBaseProps, 'shortcut' | 'danger' | 'onSelect'>) {
  return (
    <RadixDropdown.SubTrigger disabled={disabled} className={cn(menuItemClass, className)}>
      <ItemContent icon={icon} inset={inset}>
        {children}
      </ItemContent>
      <ChevronRight size={13} strokeWidth={2} className="-mr-0.5 shrink-0 text-subtle" />
    </RadixDropdown.SubTrigger>
  )
}

export function DropdownMenuSubContent({ className, ...rest }: ComponentProps<typeof RadixDropdown.SubContent>) {
  return (
    <RadixDropdown.Portal>
      <RadixDropdown.SubContent sideOffset={6} alignOffset={-5} collisionPadding={8} className={cn(menuContentClass, className)} {...rest} />
    </RadixDropdown.Portal>
  )
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <RadixDropdown.Separator className={cn(separatorClass, className)} />
}

export function DropdownMenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <RadixDropdown.Label className={cn(labelClass, className)}>{children}</RadixDropdown.Label>
}

// --- ContextMenu --------------------------------------------------------------

export const ContextMenu = RadixContext.Root
export const ContextMenuTrigger = RadixContext.Trigger
export const ContextMenuGroup = RadixContext.Group
export const ContextMenuSub = RadixContext.Sub
export const ContextMenuRadioGroup = RadixContext.RadioGroup

export function ContextMenuContent({ className, ...rest }: ComponentProps<typeof RadixContext.Content>) {
  return (
    <RadixContext.Portal>
      <RadixContext.Content collisionPadding={8} className={cn(menuContentClass, className)} {...rest} />
    </RadixContext.Portal>
  )
}

export function ContextMenuItem({ icon, shortcut, inset, danger, disabled, onSelect, className, children }: ItemBaseProps) {
  return (
    <RadixContext.Item
      disabled={disabled}
      onSelect={onSelect}
      data-danger={danger || undefined}
      className={cn(menuItemClass, danger && dangerClass, className)}
    >
      <ItemContent icon={icon} shortcut={shortcut} inset={inset}>
        {children}
      </ItemContent>
    </RadixContext.Item>
  )
}

export function ContextMenuCheckboxItem({ checked, onCheckedChange, shortcut, disabled, children, className }: CheckItemProps) {
  return (
    <RadixContext.CheckboxItem
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      disabled={disabled}
      onSelect={(e) => e.preventDefault()}
      className={cn(menuItemClass, className)}
    >
      {checked ? indicator : <span className="w-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd variant="text" shortcut={shortcut} className="ml-4" />}
    </RadixContext.CheckboxItem>
  )
}

export function ContextMenuRadioItem({ value, disabled, children, className }: { value: string; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <RadixContext.RadioItem value={value} disabled={disabled} className={cn(menuItemClass, className)}>
      <span className="flex w-4 shrink-0 justify-center">
        <RadixContext.ItemIndicator className="text-accent">
          <Dot size={20} strokeWidth={3} />
        </RadixContext.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </RadixContext.RadioItem>
  )
}

export function ContextMenuSubTrigger({ icon, inset, disabled, children, className }: Omit<ItemBaseProps, 'shortcut' | 'danger' | 'onSelect'>) {
  return (
    <RadixContext.SubTrigger disabled={disabled} className={cn(menuItemClass, className)}>
      <ItemContent icon={icon} inset={inset}>
        {children}
      </ItemContent>
      <ChevronRight size={13} strokeWidth={2} className="-mr-0.5 shrink-0 text-subtle" />
    </RadixContext.SubTrigger>
  )
}

export function ContextMenuSubContent({ className, ...rest }: ComponentProps<typeof RadixContext.SubContent>) {
  return (
    <RadixContext.Portal>
      <RadixContext.SubContent sideOffset={6} alignOffset={-5} collisionPadding={8} className={cn(menuContentClass, className)} {...rest} />
    </RadixContext.Portal>
  )
}

export function ContextMenuSeparator({ className }: { className?: string }) {
  return <RadixContext.Separator className={cn(separatorClass, className)} />
}

export function ContextMenuLabel({ className, children }: { className?: string; children: ReactNode }) {
  return <RadixContext.Label className={cn(labelClass, className)}>{children}</RadixContext.Label>
}
