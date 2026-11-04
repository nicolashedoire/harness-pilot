import type { BlockInstance } from '../types'
import type { BlockSize } from '../shell'

/** What every block renderer gets: a validated block, where it is drawn, and the shared actions. */
export type RendererProps = {
  block: BlockInstance
  size: BlockSize
  /** Opens the block in the side panel (absent inside the panel itself). */
  onOpenBeside?: () => void
  /** Shows the block's raw data. */
  onRaw?: () => void
  /** A stable key of this block (type + data) for what the browser remembers about it (form sent, boxes ticked). */
  memoKey: string
}
