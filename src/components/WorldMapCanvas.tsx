import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TERRAIN_COLORS } from '../lib/worldMap'
import type { Contact, LocationNode, WorldMapRecord } from '../types'

const CELL = 22
const MAX_SCALE = 2.4
const EMOJI: Record<string, string> = { residence: '🏠', school: '🏫', mall: '🏬', hospital: '🏥', park: '🌳', farm: '🚜', beach: '🏖️', custom: '📍' }

interface Viewport { width: number; height: number }
interface Point { x: number; y: number }

export function WorldMapCanvas({ map, locations, contacts, playerLocationId, onTileClick }: {
  map: WorldMapRecord
  locations: LocationNode[]
  contacts: Contact[]
  playerLocationId: string
  onTileClick: (x: number, y: number) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mapWidth = map.width * CELL, mapHeight = map.height * CELL
  const [viewport, setViewport] = useState<Viewport>({ width: 1, height: 1 })
  const minScale = Math.min(viewport.width / mapWidth, viewport.height / mapHeight)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const initialized = useRef(false)
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ distance?: number; midpoint?: Point; dragStart?: Point; offsetStart?: Point; moved: boolean }>({ moved: false })

  const clampOffset = useCallback((value: Point, nextScale: number): Point => {
    const width = mapWidth * nextScale, height = mapHeight * nextScale
    return {
      x: width <= viewport.width ? (viewport.width - width) / 2 : Math.max(viewport.width - width, Math.min(0, value.x)),
      y: height <= viewport.height ? (viewport.height - height) / 2 : Math.max(viewport.height - height, Math.min(0, value.y)),
    }
  }, [mapWidth, mapHeight, viewport])

  const reset = useCallback(() => {
    const s = Math.min(MAX_SCALE, Math.max(0.01, minScale))
    setScale(s)
    setOffset(clampOffset({ x: 0, y: 0 }, s))
  }, [minScale, clampOffset])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      setViewport({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (viewport.width <= 1 || viewport.height <= 1) return
    if (!initialized.current) { initialized.current = true; reset(); return }
    const nextScale = Math.max(minScale, Math.min(MAX_SCALE, scale))
    setScale(nextScale)
    setOffset((current) => clampOffset(current, nextScale))
  }, [viewport, minScale, scale, reset, clampOffset])

  const zoomAt = useCallback((requested: number, focal: Point) => {
    const next = Math.max(minScale, Math.min(MAX_SCALE, requested))
    setScale((current) => {
      const worldX = (focal.x - offset.x) / current
      const worldY = (focal.y - offset.y) / current
      setOffset(clampOffset({ x: focal.x - worldX * next, y: focal.y - worldY * next }, next))
      return next
    })
  }, [minScale, offset, clampOffset])

  const locationById = useMemo(() => new Map(locations.map((item) => [item.id, item])), [locations])
  const anchorFor = useCallback((id?: string): LocationNode | undefined => {
    let current = id ? locationById.get(id) : undefined
    while (current && !current.mapBinding) current = current.parentId ? locationById.get(current.parentId) : undefined
    return current
  }, [locationById])
  const roots = useMemo(() => locations.filter((item) => item.mapBinding), [locations])
  const playerAnchor = anchorFor(playerLocationId)
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const contact of contacts) {
      const anchor = anchorFor(contact.currentLocationId)
      if (anchor) result.set(anchor.id, (result.get(anchor.id) ?? 0) + 1)
    }
    return result
  }, [contacts, anchorFor])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = mapWidth * dpr
    canvas.height = mapHeight * dpr
    canvas.style.width = `${mapWidth}px`
    canvas.style.height = `${mapHeight}px`
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) {
      ctx.fillStyle = TERRAIN_COLORS[map.tiles[y * map.width + x]]
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL)
      ctx.strokeStyle = 'rgba(255,255,255,.22)'
      ctx.strokeRect(x * CELL, y * CELL, CELL, CELL)
    }
  }, [map, mapWidth, mapHeight])

  function localPoint(clientX: number, clientY: number): Point {
    const rect = hostRef.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  return <div ref={hostRef} className="relative h-full touch-none overflow-hidden bg-slate-200"
    onWheel={(event) => {
      event.preventDefault()
      const point = localPoint(event.clientX, event.clientY)
      zoomAt(scale * (event.deltaY > 0 ? .9 : 1.1), point)
    }}
    onPointerDown={(event) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      const point = localPoint(event.clientX, event.clientY)
      pointers.current.set(event.pointerId, point)
      gesture.current = { dragStart: point, offsetStart: offset, moved: false }
    }}
    onPointerMove={(event) => {
      if (!pointers.current.has(event.pointerId)) return
      pointers.current.set(event.pointerId, localPoint(event.clientX, event.clientY))
      const points = [...pointers.current.values()]
      if (points.length >= 2) {
        const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
        const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
        if (gesture.current.distance) zoomAt(scale * distance / gesture.current.distance, midpoint)
        gesture.current.distance = distance
        gesture.current.midpoint = midpoint
        gesture.current.moved = true
      } else if (gesture.current.dragStart && gesture.current.offsetStart) {
        const dx = points[0].x - gesture.current.dragStart.x, dy = points[0].y - gesture.current.dragStart.y
        if (Math.abs(dx) + Math.abs(dy) > 4) gesture.current.moved = true
        setOffset(clampOffset({ x: gesture.current.offsetStart.x + dx, y: gesture.current.offsetStart.y + dy }, scale))
      }
    }}
    onPointerUp={(event) => {
      const moved = gesture.current.moved
      const point = localPoint(event.clientX, event.clientY)
      pointers.current.delete(event.pointerId)
      if (!moved) {
        const x = Math.floor((point.x - offset.x) / scale / CELL), y = Math.floor((point.y - offset.y) / scale / CELL)
        if (x >= 0 && y >= 0 && x < map.width && y < map.height) onTileClick(x, y)
      }
      gesture.current = { moved: false }
    }}>
    <canvas ref={canvasRef} className="absolute left-0 top-0 origin-top-left shadow-xl" style={{ transform: `translate(${offset.x}px,${offset.y}px) scale(${scale})` }} />
    <div className="pointer-events-none absolute inset-0">
      {roots.map((location) => {
        const binding = location.mapBinding!
        const left = offset.x + (binding.x + .5) * CELL * scale
        const top = offset.y + (binding.y + .5) * CELL * scale
        const isPlayer = playerAnchor?.id === location.id
        const count = counts.get(location.id) ?? 0
        return <button key={location.id} type="button" className="pointer-events-auto absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left, top }} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onTileClick(binding.x, binding.y) }}>
          <span className={`relative flex h-10 w-10 items-center justify-center rounded-full border-2 border-white text-xl shadow-[0_2px_8px_rgba(0,0,0,.55)] ${isPlayer ? 'bg-violet-600 ring-2 ring-violet-200' : count ? 'bg-amber-500' : 'bg-slate-800'}`}>
            {EMOJI[binding.buildingCategory] ?? EMOJI[location.kind] ?? '📍'}
            {count > 0 && <span className="absolute -right-2 -top-2 min-w-5 rounded-full bg-red-600 px-1 text-[10px] font-bold leading-5 text-white">{count}</span>}
          </span>
          <span className="mt-0.5 block max-w-24 truncate rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-white shadow">{location.name}</span>
        </button>
      })}
    </div>
    <div className="absolute bottom-3 right-3 z-20 flex gap-1 rounded-full bg-white/95 p-1 shadow">
      <button onClick={() => zoomAt(scale - .2, { x: viewport.width / 2, y: viewport.height / 2 })} className="h-8 w-8 rounded-full">−</button>
      <button onClick={reset} className="px-2 text-xs">复位</button>
      <button onClick={() => zoomAt(scale + .2, { x: viewport.width / 2, y: viewport.height / 2 })} className="h-8 w-8 rounded-full">＋</button>
    </div>
  </div>
}
