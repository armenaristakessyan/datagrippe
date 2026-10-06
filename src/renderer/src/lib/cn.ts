import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Teach tailwind-merge about the custom design tokens (see styles.css) so that e.g.
// cn('text-2xs', 'text-muted') keeps both (size + color) instead of dropping one.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs'],
      color: [
        'app', 'panel', 'surface', 'elevated', 'overlay', 'hover', 'active', 'input',
        'line', 'line-strong', 'focus', 'fg', 'muted', 'subtle', 'faint',
        'accent', 'accent-hover', 'accent-fg', 'accent-soft', 'selection',
        'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'info', 'info-soft',
        'tag-red', 'tag-orange', 'tag-yellow', 'tag-green', 'tag-blue', 'tag-purple', 'tag-gray',
        'grid-header', 'grid-row-alt', 'grid-null', 'grid-modified', 'grid-inserted', 'grid-deleted',
        'syn-keyword', 'syn-string', 'syn-number', 'syn-comment', 'syn-function', 'syn-operator', 'syn-type',
        'dialect-postgres', 'dialect-postgres-deep', 'dialect-mssql', 'dialect-mssql-deep',
        'brand', 'brand-deep', 'on-solid', 'kbd', 'kbd-line', 'glow', 'skeleton',
      ],
      shadow: ['popover', 'dialog', 'raised', 'inset'],
    },
  },
})

/** Merge class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
