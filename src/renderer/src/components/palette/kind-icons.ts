import { Eye, Hash, Layers, Shapes, SquareFunction, Table2, TableProperties, Workflow } from 'lucide-react'
import type { ObjectKind } from '@shared/types'
import type { IconLike } from '@/components/ui'

export const OBJECT_KIND_ICON: Record<ObjectKind, IconLike> = {
  table: Table2,
  view: Eye,
  'materialized-view': Layers,
  'foreign-table': TableProperties,
  function: SquareFunction,
  procedure: Workflow,
  sequence: Hash,
  type: Shapes,
}
