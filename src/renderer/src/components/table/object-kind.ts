import { Eye, FunctionSquare, Hash, Layers, Shapes, Table2, TableProperties, Workflow } from 'lucide-react'
import type { ObjectKind } from '@shared/types'
import type { IconLike } from '@/components/ui'

export const OBJECT_KIND_ICON: Record<ObjectKind, IconLike> = {
  table: Table2,
  view: Eye,
  'materialized-view': Layers,
  'foreign-table': TableProperties,
  function: FunctionSquare,
  procedure: Workflow,
  sequence: Hash,
  type: Shapes,
}

export const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  table: 'Table',
  view: 'View',
  'materialized-view': 'Materialized view',
  'foreign-table': 'Foreign table',
  function: 'Function',
  procedure: 'Procedure',
  sequence: 'Sequence',
  type: 'Type',
}

/** Views only expose columns and DDL in the structure tab. */
export function isViewLike(kind: ObjectKind): boolean {
  return kind === 'view' || kind === 'materialized-view'
}
