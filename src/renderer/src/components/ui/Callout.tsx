import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import { renderIcon, type IconLike } from './icon'

export type CalloutTone = 'info' | 'warning' | 'danger' | 'success'

const tones: Record<CalloutTone, { box: string; icon: string; Icon: IconLike }> = {
  info: { box: 'border-info/20 bg-info/[0.07]', icon: 'text-info', Icon: Info },
  warning: { box: 'border-warning/20 bg-warning/[0.07]', icon: 'text-warning', Icon: AlertTriangle },
  danger: { box: 'border-danger/20 bg-danger/[0.07]', icon: 'text-danger', Icon: OctagonAlert },
  success: { box: 'border-success/20 bg-success/[0.07]', icon: 'text-success', Icon: CheckCircle2 },
}

export interface CalloutProps {
  tone?: CalloutTone
  title?: ReactNode
  /** Override the tone's default icon (pass null for none). */
  icon?: IconLike | null
  /** Buttons rendered under the body. */
  actions?: ReactNode
  className?: string
  children?: ReactNode
}

/** Inline message box: icon, title, body, actions. */
export function Callout({ tone = 'info', title, icon, actions, className, children }: CalloutProps) {
  const t = tones[tone]
  const glyph = icon === null ? null : (icon ?? t.Icon)
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5 text-xs', t.box, className)}>
      {glyph && <span className={cn('mt-px flex shrink-0', t.icon)}>{renderIcon(glyph, 15)}</span>}
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="text-[12.5px] font-medium leading-[18px] text-fg">{title}</p>}
        {children && <div className="leading-[18px] text-muted [overflow-wrap:anywhere]">{children}</div>}
        {actions && <div className="flex flex-wrap items-center gap-2 pt-1.5">{actions}</div>}
      </div>
    </div>
  )
}
