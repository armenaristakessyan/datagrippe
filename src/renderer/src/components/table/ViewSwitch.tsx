import { Columns3, Table2 } from 'lucide-react'
import { SegmentedControl } from '@/components/ui'
import type { TableTab } from '@/stores/tabs'
import { openSibling } from './table-actions'

/** Data | Structure toggle: opens (or focuses) the sibling tab of the same object. */
export function ViewSwitch({ tab }: { tab: TableTab }) {
  return (
    <SegmentedControl
      size="xs"
      aria-label="View"
      value={tab.kind}
      onValueChange={(view) => {
        if (view !== tab.kind) openSibling(tab, view)
      }}
      options={[
        { value: 'table', label: 'Data', icon: Table2 },
        { value: 'structure', label: 'Structure', icon: Columns3 },
      ]}
    />
  )
}
