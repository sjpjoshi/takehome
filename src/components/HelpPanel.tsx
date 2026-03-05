"use client";

import { useEffect, useRef, useState } from "react";

type Pos = { x: number; y: number };

const STORAGE_KEY = "voxel_help_pos_v1";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export default function HelpPanel(props: { open: boolean; onClose: () => void }) {
  const { open, onClose } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  const [pos, setPos] = useState<Pos>({ x: 16, y: 64 });

  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    pointerId: number | null;
  }>({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, pointerId: null });

  // Load saved position
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Pos;
      if (typeof parsed?.x === "number" && typeof parsed?.y === "number") setPos(parsed);
    } catch {}
  }, []);

  // Save position
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch {}
  }, [pos]);

  // Keep it inside viewport on resize
  useEffect(() => {
    const onResize = () => {
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - rect.width - 8);
      const maxY = Math.max(8, window.innerHeight - rect.height - 8);
      setPos((p) => ({
        x: clamp(p.x, 8, maxX),
        y: clamp(p.y, 8, maxY),
      }));
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const beginDrag = (e: React.PointerEvent) => {
    // ✅ If the user clicked a button, don't start drag.
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;

    const el = panelRef.current;
    if (!el) return;

    dragRef.current.dragging = true;
    dragRef.current.startX = e.clientX;
    dragRef.current.startY = e.clientY;
    dragRef.current.origX = pos.x;
    dragRef.current.origY = pos.y;
    dragRef.current.pointerId = e.pointerId;

    // capture pointer so drag continues even if you move fast
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDrag = (e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    const el = panelRef.current;
    if (!el) return;

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    const rect = el.getBoundingClientRect();
    const maxX = Math.max(8, window.innerWidth - rect.width - 8);
    const maxY = Math.max(8, window.innerHeight - rect.height - 8);

    setPos({
      x: clamp(dragRef.current.origX + dx, 8, maxX),
      y: clamp(dragRef.current.origY + dy, 8, maxY),
    });
  };

  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current.dragging) return;
    dragRef.current.dragging = false;

    const pid = dragRef.current.pointerId;
    if (pid != null) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(pid);
      } catch {}
    }
    dragRef.current.pointerId = null;
  };

  const resetPos = () => setPos({ x: 16, y: 64 });

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        background: "rgba(15, 15, 18, 0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 14,
        padding: 14,
        color: "white",
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        zIndex: 50,
        userSelect: dragRef.current.dragging ? "none" : "auto",
      }}
    >
      {/* Drag handle */}
      <div
        onPointerDown={beginDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: "grab",
          paddingBottom: 8,
          borderBottom: "1px solid rgba(255,255,255,0.10)",
          marginBottom: 10,
        }}
        title="Drag to move"
      >
        <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: 0.2 }}>Controls</div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            onPointerDown={(e) => e.stopPropagation()} // ✅ prevent drag start
            onClick={(e) => {
              e.stopPropagation();
              resetPos();
            }}
            style={{
              border: "1px solid rgba(255,255,255,0.18)",
              background: "transparent",
              color: "white",
              borderRadius: 10,
              padding: "4px 10px",
              cursor: "pointer",
            }}
            title="Reset position"
          >
            Reset
          </button>

          <button
            onPointerDown={(e) => e.stopPropagation()} // ✅ prevent drag start
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            style={{
              border: "1px solid rgba(255,255,255,0.18)",
              background: "transparent",
              color: "white",
              borderRadius: 10,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>

      <div style={{ fontSize: 13, lineHeight: 1.35, opacity: 0.95 }}>
        <div style={{ fontWeight: 700, marginTop: 6 }}>Camera</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li>
            <b>Left drag</b>: Orbit
          </li>
          <li>
            <b>Right drag</b>: Pan
          </li>
          <li>
            <b>Scroll</b>: Zoom
          </li>
        </ul>

        <div style={{ fontWeight: 700, marginTop: 10 }}>Edit</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li>
            <b>Click</b>: Place block on active layer
          </li>
          <li>
            <b>Click voxel face</b>: Place adjacent block
          </li>
          <li>
            <b>Shift + click voxel</b>: Remove block
          </li>
          <li>
            <b>Alt (override)</b>: Use face placement across any layer
          </li>
        </ul>

        <div style={{ fontWeight: 700, marginTop: 10 }}>Tools</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li>
            <b>Palette</b>: Choose block color
          </li>
          <li>
            <b>Y Layer</b>: Change build height
          </li>
          <li>
            <b>V/B/P/E</b>: Single / Draw / Paint / Erase
          </li>
          <li>
            <b>Ctrl/Cmd+Z</b>: Undo · <b>Ctrl/Cmd+Y</b>: Redo
          </li>
        </ul>
      </div>
    </div>
  );
}