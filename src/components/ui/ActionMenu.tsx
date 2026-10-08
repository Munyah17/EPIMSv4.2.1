import { useEffect, useRef, useState } from 'react'

export interface ActionMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  hidden?: boolean
}

interface Props {
  items: ActionMenuItem[]
}

interface PopPos {
  top: number
  left: number
}

const MENU_WIDTH = 180
const MENU_ITEM_H = 34
const MENU_PAD = 12

/** Compact kebab-menu trigger for table row actions. The pop-up is
 *  position:fixed measured from the trigger's box — an absolutely-placed
 *  child gets clipped by the table's own overflow:auto / overflow:hidden
 *  wrappers (which is exactly what made menus vanish behind the card or
 *  be cut off at the bottom edge). It opens up or down depending on
 *  where there is room, stays inside the viewport horizontally, and
 *  closes on any scroll so it never floats detached from its row. */
export default function ActionMenu({ items }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopPos>({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const visible = items.filter(i => !i.hidden)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    // Any scroll repositions the table but not a fixed pop-up — close
    // rather than leave the menu hanging where the row used to be.
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  const toggle = () => {
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect()
      const menuHeight = visible.length * MENU_ITEM_H + MENU_PAD
      const below = r.bottom + 4
      const above = r.top - menuHeight - 4
      const top = below + menuHeight <= window.innerHeight
        ? below
        : Math.max(8, above)
      const left = Math.min(
        Math.max(8, r.right - MENU_WIDTH),
        window.innerWidth - MENU_WIDTH - 8,
      )
      setPos({ top, left })
    }
    setOpen(o => !o)
  }

  return (
    <div className="action-menu" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="action-menu-trigger"
        aria-label="Row actions"
        aria-expanded={open}
        onClick={toggle}
      >
        ⋮
      </button>
      {open && (
        <div
          className="action-menu-dropdown"
          role="menu"
          style={{ top: pos.top, left: pos.left }}
        >
          {visible.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`action-menu-item${item.danger ? ' danger' : ''}`}
              onClick={() => { setOpen(false); item.onClick() }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
