"use client";

import * as THREE from "three";
import { Canvas, ThreeEvent, useFrame } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport, ContactShadows } from "@react-three/drei";
import { EffectComposer, SSAO } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";

type Voxel = { x: number; y: number; z: number; color: string };
type Cell = { x: number; y: number; z: number } | null;

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

const GRID_SIZE = 20;
const HALF = GRID_SIZE / 2;

// MagicaVoxel-like build volume
const BUILD_HEIGHT = GRID_SIZE; // change to 40/64 etc if you want
const EPS_PLANE = 0.002;

// History
type Patch = { key: string; before: Voxel | null; after: Voxel | null };
type HistoryEntry = { kind: "single"; patch: Patch } | { kind: "batch"; patches: Patch[] };
const HISTORY_LIMIT = 600;

// Drawing tools
type Tool = "single" | "draw" | "paint" | "erase";

// Camera presets
const CAM_TARGET = new THREE.Vector3(0, 0, 0);
const CAM_ISO_POS = new THREE.Vector3(10, 10, 10);
const CAM_FRONT_POS = new THREE.Vector3(0, 6, 14);
const CAM_RIGHT_POS = new THREE.Vector3(14, 6, 0);
const CAM_TOP_POS = new THREE.Vector3(0, 18, 0.001);
const CAM_LERP = 0.18;

type BoundsPlane = "+X" | "-X" | "+Z" | "-Z" | "TOP";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function BuildCage(props: { size: number; height: number }) {
  const { size, height } = props;
  const cy = height / 2;

  return (
    <group raycast={() => null}>
      <mesh position={[0, cy, 0]}>
        <boxGeometry args={[size, height, size]} />
        <meshBasicMaterial wireframe transparent opacity={0.28} color="white" />
      </mesh>
    </group>
  );
}

function CursorPreview(props: { cell: { x: number; y: number; z: number }; color: string }) {
  const { cell, color } = props;
  const outlineRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const m = outlineRef.current;
    if (!m) return;
    const s = 1.02 + Math.sin(clock.elapsedTime * 4) * 0.01;
    m.scale.set(s, s, s);
  });

  return (
    <group position={[cell.x + 0.5, cell.y + 0.5, cell.z + 0.5]}>
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial transparent opacity={0.15} color={color} />
      </mesh>

      <mesh ref={outlineRef}>
        <boxGeometry args={[1.02, 1.02, 1.02]} />
        <meshBasicMaterial wireframe transparent opacity={0.9} color="white" />
      </mesh>
    </group>
  );
}

/**
 * Convert a raycast hit (point + face normal) into the voxel coordinate
 * that owns that face (works even when faces are merged).
 */
function voxelFromHit(point: THREE.Vector3, normal: THREE.Vector3) {
  const eps = 1e-4;

  const nx = Math.round(normal.x);
  const ny = Math.round(normal.y);
  const nz = Math.round(normal.z);

  let x = 0,
    y = 0,
    z = 0;

  if (nx === 1) x = Math.floor(point.x - eps);
  else if (nx === -1) x = Math.floor(point.x + eps);
  else x = Math.floor(point.x);

  if (ny === 1) y = Math.floor(point.y - eps);
  else if (ny === -1) y = Math.floor(point.y + eps);
  else y = Math.floor(point.y);

  if (nz === 1) z = Math.floor(point.z - eps);
  else if (nz === -1) z = Math.floor(point.z + eps);
  else z = Math.floor(point.z);

  return { x, y, z };
}

function pushTri(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  n: [number, number, number],
  r: number,
  g: number,
  b_: number,
  positions: number[],
  normals: number[],
  colors: number[]
) {
  positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  normals.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
  colors.push(r, g, b_, r, g, b_, r, g, b_);
}

/**
 * Greedy meshing for a sparse voxel map.
 * Merges adjacent faces only if they have the same color.
 */
function buildGreedyGeometry(voxels: Map<string, Voxel>) {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  if (voxels.size === 0) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute([], 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute([], 3));
    return g;
  }

  const minX = -HALF;
  const maxX = HALF - 1;
  const minZ = -HALF;
  const maxZ = HALF - 1;
  const minY = 0;
  const maxY = BUILD_HEIGHT - 1;

  const dims = [
    maxX - minX + 1, // X
    maxY - minY + 1, // Y
    maxZ - minZ + 1, // Z
  ] as const;

  const hasVoxel = (x: number, y: number, z: number) => voxels.has(keyOf(x, y, z));
  const getVoxel = (x: number, y: number, z: number) => voxels.get(keyOf(x, y, z));

  const colorCache = new Map<string, [number, number, number]>();
  const getColorRGB = (hex: string): [number, number, number] => {
    const cached = colorCache.get(hex);
    if (cached) return cached;
    const c = new THREE.Color(hex);
    const rgb: [number, number, number] = [c.r, c.g, c.b];
    colorCache.set(hex, rgb);
    return rgb;
  };

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    type MaskCell = { color: string; sign: 1 | -1 } | null;
    const mask: MaskCell[] = new Array(dims[u] * dims[v]).fill(null);

    for (let w = 0; w <= dims[d]; w++) {
      // Build mask
      let n = 0;
      for (let j = 0; j < dims[v]; j++) {
        for (let i = 0; i < dims[u]; i++, n++) {
          const coord = [0, 0, 0] as [number, number, number];
          coord[d] = w;
          coord[u] = i;
          coord[v] = j;

          const aCoord = [coord[0], coord[1], coord[2]] as [number, number, number];
          aCoord[d] = w - 1;
          const bCoord = coord;

          const ax = minX + aCoord[0];
          const ay = minY + aCoord[1];
          const az = minZ + aCoord[2];

          const bx = minX + bCoord[0];
          const by = minY + bCoord[1];
          const bz = minZ + bCoord[2];

          const a = hasVoxel(ax, ay, az) ? getVoxel(ax, ay, az) : null;
          const b = hasVoxel(bx, by, bz) ? getVoxel(bx, by, bz) : null;

          if (a && !b) mask[n] = { color: a.color, sign: 1 };
          else if (!a && b) mask[n] = { color: b.color, sign: -1 };
          else mask[n] = null;
        }
      }

      // Greedy merge
      n = 0;
      for (let j = 0; j < dims[v]; j++) {
        for (let i = 0; i < dims[u]; ) {
          const cell = mask[n];
          if (!cell) {
            i++;
            n++;
            continue;
          }

          const { color, sign } = cell;

          let width = 1;
          while (i + width < dims[u]) {
            const c = mask[n + width];
            if (!c || c.color !== color || c.sign !== sign) break;
            width++;
          }

          let height = 1;
          outer: while (j + height < dims[v]) {
            for (let k = 0; k < width; k++) {
              const c = mask[n + k + height * dims[u]];
              if (!c || c.color !== color || c.sign !== sign) break outer;
            }
            height++;
          }

          const x = [0, 0, 0] as [number, number, number];
          x[d] = w;
          x[u] = i;
          x[v] = j;

          const du = [0, 0, 0] as [number, number, number];
          const dv = [0, 0, 0] as [number, number, number];
          du[u] = width;
          dv[v] = height;

          const x0 = [minX + x[0], minY + x[1], minZ + x[2]] as [number, number, number];
          const x1 = [x0[0] + du[0], x0[1] + du[1], x0[2] + du[2]] as [number, number, number];
          const x2 = [x0[0] + dv[0], x0[1] + dv[1], x0[2] + dv[2]] as [number, number, number];
          const x3 = [
            x0[0] + du[0] + dv[0],
            x0[1] + du[1] + dv[1],
            x0[2] + du[2] + dv[2],
          ] as [number, number, number];

          const nn = [0, 0, 0] as [number, number, number];
          nn[d] = sign;

          const [r, g, b_] = getColorRGB(color);

          if (sign === 1) {
            pushTri(x0, x1, x3, nn, r, g, b_, positions, normals, colors);
            pushTri(x0, x3, x2, nn, r, g, b_, positions, normals, colors);
          } else {
            pushTri(x0, x3, x1, nn, r, g, b_, positions, normals, colors);
            pushTri(x0, x2, x3, nn, r, g, b_, positions, normals, colors);
          }

          for (let yy = 0; yy < height; yy++) {
            for (let xx = 0; xx < width; xx++) {
              mask[n + xx + yy * dims[u]] = null;
            }
          }

          i += width;
          n += width;
        }
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geom.computeBoundingSphere();
  return geom;
}

function rasterLine(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  const pts: { x: number; y: number; z: number }[] = [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;

  const steps = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  if (steps === 0) return [a];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push({
      x: Math.round(a.x + dx * t),
      y: Math.round(a.y + dy * t),
      z: Math.round(a.z + dz * t),
    });
  }

  // de-dupe consecutive
  const out: typeof pts = [];
  let last = "";
  for (const p of pts) {
    const k = `${p.x},${p.y},${p.z}`;
    if (k !== last) out.push(p);
    last = k;
  }
  return out;
}

function SnapDriver(props: {
  controlsRef: React.RefObject<any>;
  snapToRef: React.MutableRefObject<THREE.Vector3 | null>;
  snapTargetRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const { controlsRef, snapToRef, snapTargetRef } = props;

  useFrame(() => {
    const c = controlsRef.current;
    const dest = snapToRef.current;
    if (!c || !dest) return;

    const cam: THREE.Camera = c.object;
    const camPos = (cam as any).position as THREE.Vector3;

    camPos.lerp(dest, CAM_LERP);
    c.target.lerp(snapTargetRef.current, CAM_LERP);
    c.update();

    if (camPos.distanceTo(dest) < 0.02) {
      camPos.copy(dest);
      c.target.copy(snapTargetRef.current);
      c.update();
      snapToRef.current = null;
    }
  });

  return null;
}

type CmdResult = { ok: true } | { ok: false; error: string };

export default function VoxelCanvas(props: {
  selectedColor: string;
  activeLayer: number;
  commandOpen?: boolean;
}) {
  const { selectedColor, activeLayer, commandOpen = true } = props;

  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const [hoverCell, setHoverCell] = useState<Cell>(null);
  const [hoveredVoxelKey, setHoveredVoxelKey] = useState<string | null>(null);

  // Tool
  const [tool, setTool] = useState<Tool>("single");

  // Command bar
  const [cmdText, setCmdText] = useState("fill -3 0 -3 3 0 3 #222222");
  const [cmdError, setCmdError] = useState<string | null>(null);

  // Camera controls
  const controlsRef = useRef<any>(null);
  const snapToRef = useRef<THREE.Vector3 | null>(null);
  const snapTargetRef = useRef<THREE.Vector3>(CAM_TARGET.clone());

  // History stacks
  const undoRef = useRef<HistoryEntry[]>([]);
  const redoRef = useRef<HistoryEntry[]>([]);
  const [, bumpHistoryUI] = useState(0);

  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;

  // Drawing stroke state
  const drawingRef = useRef(false);
  const strokePatchesRef = useRef<Map<string, Patch>>(new Map());
  const lastCellRef = useRef<Cell>(null);
  const lastStampRef = useRef(0);

  // For paint/erase on surface: actual hit voxel cell (not adjacent placement cell)
  const hitVoxelCellRef = useRef<Cell>(null);

  const inBounds = (x: number, y: number, z: number) =>
    x >= -HALF && x < HALF && z >= -HALF && z < HALF && y >= 0 && y < BUILD_HEIGHT;

  const pushEntry = (entry: HistoryEntry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current.length = 0;
    bumpHistoryUI((v) => v + 1);
  };

  const applySinglePatch = (patch: Patch, dir: "undo" | "redo", base: Map<string, Voxel>) => {
    const value = dir === "redo" ? patch.after : patch.before;
    if (value) base.set(patch.key, value);
    else base.delete(patch.key);
  };

  const applyEntry = (entry: HistoryEntry, dir: "undo" | "redo") => {
    setVoxels((prev) => {
      const next = new Map(prev);
      if (entry.kind === "single") {
        applySinglePatch(entry.patch, dir, next);
      } else {
        const patches = dir === "undo" ? [...entry.patches].reverse() : entry.patches;
        for (const p of patches) applySinglePatch(p, dir, next);
      }
      return next;
    });
  };

  const undo = () => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    applyEntry(entry, "undo");
    redoRef.current.push(entry);
    bumpHistoryUI((v) => v + 1);
  };

  const redo = () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    applyEntry(entry, "redo");
    undoRef.current.push(entry);
    bumpHistoryUI((v) => v + 1);
  };

  const commitStroke = () => {
    const patches = Array.from(strokePatchesRef.current.values());
    strokePatchesRef.current.clear();
    if (patches.length === 0) return;
    pushEntry({ kind: "batch", patches });
  };

  const beginStroke = () => {
    strokePatchesRef.current.clear();
    lastCellRef.current = null;
    lastStampRef.current = 0;
  };

  const applyToolAt = (cell: { x: number; y: number; z: number }) => {
    if (!inBounds(cell.x, cell.y, cell.z)) return;
    const k = keyOf(cell.x, cell.y, cell.z);

    setVoxels((prev) => {
      const next = new Map(prev);
      const existing = next.get(k) ?? null;

      if (tool === "draw") {
        if (existing) return prev;
        const after: Voxel = { x: cell.x, y: cell.y, z: cell.z, color: selectedColor };
        next.set(k, after);
        strokePatchesRef.current.set(k, { key: k, before: null, after });
        return next;
      }

      if (tool === "erase") {
        if (!existing) return prev;
        next.delete(k);
        strokePatchesRef.current.set(k, { key: k, before: existing, after: null });
        return next;
      }

      if (tool === "paint") {
        if (!existing) return prev;
        if (existing.color === selectedColor) return prev;
        const after: Voxel = { ...existing, color: selectedColor };
        next.set(k, after);
        strokePatchesRef.current.set(k, { key: k, before: existing, after });
        return next;
      }

      return prev;
    });
  };

  const placeAtSingle = (x: number, y: number, z: number) => {
    if (!inBounds(x, y, z)) return;
    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      if (prev.has(k)) return prev;

      const next = new Map(prev);
      const after: Voxel = { x, y, z, color: selectedColor };
      next.set(k, after);

      pushEntry({ kind: "single", patch: { key: k, before: null, after } });

      return next;
    });
  };

  const removeAtSingle = (x: number, y: number, z: number) => {
    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      const before = prev.get(k);
      if (!before) return prev;

      const next = new Map(prev);
      next.delete(k);

      pushEntry({ kind: "single", patch: { key: k, before, after: null } });

      return next;
    });
  };

  // === Command helpers (batch ops) ===
  const setVoxelWithPatch = (
    next: Map<string, Voxel>,
    patches: Map<string, Patch>,
    x: number,
    y: number,
    z: number,
    color: string
  ) => {
    if (!inBounds(x, y, z)) return;
    const k = keyOf(x, y, z);
    const before = next.get(k) ?? null;
    const after: Voxel = { x, y, z, color };
    if (before && before.color === after.color) return;

    const existingPatch = patches.get(k);
    const originalBefore = existingPatch ? existingPatch.before : before;

    next.set(k, after);
    patches.set(k, { key: k, before: originalBefore, after });
  };

  const deleteVoxelWithPatch = (
    next: Map<string, Voxel>,
    patches: Map<string, Patch>,
    x: number,
    y: number,
    z: number
  ) => {
    if (!inBounds(x, y, z)) return;
    const k = keyOf(x, y, z);

    const before = next.get(k) ?? null;
    if (!before) return;

    const existingPatch = patches.get(k);
    const originalBefore = existingPatch ? existingPatch.before : before;

    next.delete(k);
    patches.set(k, { key: k, before: originalBefore, after: null });
  };

  const parseColorMaybe = (s: string | undefined) => {
    if (!s) return selectedColor;
    if (/^#([0-9a-fA-F]{6})$/.test(s)) return s.toLowerCase();
    return null;
  };

  const toInt = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  
  type ParsedCommand =
  | { type: "clear" }
  | { type: "fill"; x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; color: string }
  | { type: "hollow"; x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; color: string }
  | { type: "box"; cx: number; cy: number; cz: number; size: number; color: string }
  | { type: "stick"; x: number; y: number; z: number; len: number; axis: "x" | "y" | "z"; color: string }
  | { type: "randomwalk"; steps: number; color: string }
  | { type: "replace"; oldColor: string; newColor: string };

  const parseCommand = (input: string): { ok: true; cmd: ParsedCommand } | { ok: false; error: string } => {
  const t = input.trim();
  if (!t) return { ok: true, cmd: { type: "clear" } }; // or treat empty as no-op

  const parts = t.split(/\s+/);
  const name = parts[0].toLowerCase();

  const parseColor = (s: string | undefined) => {
    if (!s) return selectedColor;
    if (!/^#([0-9a-fA-F]{6})$/.test(s)) return null;
    return s.toLowerCase();
  };

  const intAt = (i: number) => {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  };

  const requireInts = (start: number, count: number) => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = intAt(start + i);
      if (v == null) return null;
      out.push(v);
    }
    return out;
  };

    // clear
    if (name === "clear") return { ok: true, cmd: { type: "clear" } };
    // fill
    if (name === "fill") {
      const nums = requireInts(1, 6);
      if (!nums) return { ok: false, error: "Usage: fill x1 y1 z1 x2 y2 z2 [#rrggbb]" };
      const c = parseColor(parts[7]);
      if (!c) return { ok: false, error: "Invalid color. Use #rrggbb" };
      const [x1, y1, z1, x2, y2, z2] = nums;
      return { ok: true, cmd: { type: "fill", x1, y1, z1, x2, y2, z2, color: c } };
    }

    if (name === "hollow") {
      const nums = requireInts(1, 6);
      if (!nums) return { ok: false, error: "Usage: hollow x1 y1 z1 x2 y2 z2 [#rrggbb]" };
      const c = parseColor(parts[7]);
      if (!c) return { ok: false, error: "Invalid color. Use #rrggbb" };
      const [x1, y1, z1, x2, y2, z2] = nums;
      return { ok: true, cmd: { type: "hollow", x1, y1, z1, x2, y2, z2, color: c } };
    }
    if (name === "box") {
      const nums = requireInts(1, 4);
      if (!nums) return { ok: false, error: "Usage: box cx cy cz size [#rrggbb]" };
      const c = parseColor(parts[5]);
      if (!c) return { ok: false, error: "Invalid color. Use #rrggbb" };
      const [cx, cy, cz, size] = nums;
      return { ok: true, cmd: { type: "box", cx, cy, cz, size, color: c } };
    }
    if (name === "stick") {
      const nums = requireInts(1, 4);
      if (!nums) return { ok: false, error: "Usage: stick x y z len axis(x|y|z) [#rrggbb]" };
      const axisRaw = (parts[5] || "y").toLowerCase();
      if (axisRaw !== "x" && axisRaw !== "y" && axisRaw !== "z")
      return { ok: false, error: "Axis must be x, y, or z" };
      const c = parseColor(parts[6]);
      if (!c) return { ok: false, error: "Invalid color. Use #rrggbb" };
      const [x, y, z, len] = nums;
      return { ok: true, cmd: { type: "stick", x, y, z, len, axis: axisRaw, color: c } };
    }

    if (name === "randomwalk") {
      const steps = intAt(1);
      if (steps == null) return { ok: false, error: "Usage: randomwalk steps [#rrggbb]" };
      const c = parseColor(parts[2]);
      if (!c) return { ok: false, error: "Invalid color. Use #rrggbb" };
      return { ok: true, cmd: { type: "randomwalk", steps, color: c } };
    }

    if (name === "replace") {
      const oldC = parseColor(parts[1]);
      const newC = parseColor(parts[2]);
      if (!oldC || !newC) return { ok: false, error: "Usage: replace #old #new" };
      return { ok: true, cmd: { type: "replace", oldColor: oldC, newColor: newC } };
    }

    return { ok: false, error: `Unknown command: ${name}` };
  };

const runCommandSafe = (input: string) => {
  const parsed = parseCommand(input);

  if (!parsed.ok) {
    setCmdError(parsed.error);
    return;
  }

  setCmdError(null);
  const cmd = parsed.cmd;

  setVoxels((prev) => {
    const next = new Map(prev);
    const patches = new Map<string, Patch>();

    const commit = () => {
      const list = Array.from(patches.values());
      if (list.length) pushEntry({ kind: "batch", patches: list });
    };

    // Apply with NO THROWS
    switch (cmd.type) {
      case "clear": {
        for (const v of next.values()) {
          deleteVoxelWithPatch(next, patches, v.x, v.y, v.z);
        }
        commit();
        return next;
      }

      case "fill": {
        const xa = Math.min(cmd.x1, cmd.x2),
          xb = Math.max(cmd.x1, cmd.x2);
        const ya = Math.min(cmd.y1, cmd.y2),
          yb = Math.max(cmd.y1, cmd.y2);
        const za = Math.min(cmd.z1, cmd.z2),
          zb = Math.max(cmd.z1, cmd.z2);

        for (let y = ya; y <= yb; y++) {
          for (let z = za; z <= zb; z++) {
            for (let x = xa; x <= xb; x++) {
              setVoxelWithPatch(next, patches, x, y, z, cmd.color);
            }
          }
        }

        commit();
        return next;
      }

      case "hollow": {
        const xa = Math.min(cmd.x1, cmd.x2),
          xb = Math.max(cmd.x1, cmd.x2);
        const ya = Math.min(cmd.y1, cmd.y2),
          yb = Math.max(cmd.y1, cmd.y2);
        const za = Math.min(cmd.z1, cmd.z2),
          zb = Math.max(cmd.z1, cmd.z2);

        for (let y = ya; y <= yb; y++) {
          for (let z = za; z <= zb; z++) {
            for (let x = xa; x <= xb; x++) {
              const onSurface =
                x === xa || x === xb || y === ya || y === yb || z === za || z === zb;
              if (onSurface) setVoxelWithPatch(next, patches, x, y, z, cmd.color);
            }
          }
        }

        commit();
        return next;
      }

      case "box": {
        const r = Math.max(0, Math.floor(cmd.size / 2));
        for (let y = cmd.cy - r; y <= cmd.cy + r; y++) {
          for (let z = cmd.cz - r; z <= cmd.cz + r; z++) {
            for (let x = cmd.cx - r; x <= cmd.cx + r; x++) {
              setVoxelWithPatch(next, patches, x, y, z, cmd.color);
            }
          }
        }
        commit();
        return next;
      }

      case "stick": {
        const L = clamp(Math.abs(cmd.len), 1, 5000);
        for (let i = 0; i < L; i++) {
          const dx = cmd.axis === "x" ? i : 0;
          const dy = cmd.axis === "y" ? i : 0;
          const dz = cmd.axis === "z" ? i : 0;
          setVoxelWithPatch(next, patches, cmd.x + dx, cmd.y + dy, cmd.z + dz, cmd.color);
        }
        commit();
        return next;
      }

      case "randomwalk": {
        let x = 0,
          y = activeLayer,
          z = 0;

        setVoxelWithPatch(next, patches, x, y, z, cmd.color);

        const dirs = [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ] as const;

        const S = clamp(cmd.steps, 1, 5000);
        for (let i = 0; i < S; i++) {
          const d = dirs[(Math.random() * dirs.length) | 0];
          x += d[0];
          y += d[1];
          z += d[2];

          x = clamp(x, -HALF, HALF - 1);
          z = clamp(z, -HALF, HALF - 1);
          y = clamp(y, 0, BUILD_HEIGHT - 1);

          setVoxelWithPatch(next, patches, x, y, z, cmd.color);
        }

        commit();
        return next;
      }

      case "replace": {
        for (const v of next.values()) {
          if (v.color.toLowerCase() === cmd.oldColor) {
            setVoxelWithPatch(next, patches, v.x, v.y, v.z, cmd.newColor);
          }
        }
        commit();
        return next;
      }

      default: {
        // TypeScript should make this unreachable, but this is a safe runtime fallback.
        setCmdError("Unknown command");
        return prev;
      }
    }
  });
};

  const surfaceGeom = useMemo(() => buildGreedyGeometry(voxels), [voxels]);

  // Build-plane intersection helper (y = activeLayer)
  const intersectBuildPlane = (ray: THREE.Ray) => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -activeLayer);
    const hit = new THREE.Vector3();
    const ok = ray.intersectPlane(plane, hit);
    return ok ? hit : null;
  };

  // Hover setter that also draws if dragging
  const setHoverAndMaybeDraw = (c: Cell) => {
    setHoverCell(c);
    if (!c) return;
    if (!drawingRef.current) return;
    if (tool === "single") return;

    // throttle ~60fps
    const now = performance.now();
    if (now - lastStampRef.current < 16) return;
    lastStampRef.current = now;

    const last = lastCellRef.current;
    if (!last) {
      applyToolAt(c);
      lastCellRef.current = c;
      return;
    }

    const manhattanJump = Math.abs(c.x - last.x) + Math.abs(c.y - last.y) + Math.abs(c.z - last.z);
    if (manhattanJump > 6) {
      applyToolAt(c);
      lastCellRef.current = c;
      return;
    }

    const pts = rasterLine(last, c);
    for (const p of pts) applyToolAt(p);
    lastCellRef.current = c;
  };

  const onPointerDownDraw = (e: ThreeEvent<PointerEvent>) => {
    if (tool === "single") return;
    e.stopPropagation();

    (e.target as any)?.setPointerCapture?.((e as any).pointerId);

    drawingRef.current = true;
    beginStroke();

    const startCell =
      tool === "paint" || tool === "erase" ? hitVoxelCellRef.current ?? hoverCell : hoverCell;

    if (startCell) {
      applyToolAt(startCell);
      lastCellRef.current = startCell;
    }
  };

  const onPointerUpDraw = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastCellRef.current = null;
    commitStroke();
  };

  useEffect(() => {
    const up = () => onPointerUpDraw();
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // --- Active layer plane handlers ---
  const handlePickPlaneMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = activeLayer;

    if (!inBounds(x, y, z)) {
      setHoverAndMaybeDraw(null);
      return;
    }
    setHoverAndMaybeDraw({ x, y, z });
  };

  const handlePickPlaneLeave = () => setHoverAndMaybeDraw(null);

  const handlePickPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (tool !== "single") return;
    if (e.shiftKey) return;

    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    placeAtSingle(x, activeLayer, z);
  };

  // --- Bounds plane helpers (MagicaVoxel cage placement) ---
  const cellFromBoundsPlane = (plane: BoundsPlane, p: THREE.Vector3) => {
    const y = clamp(Math.floor(p.y), 0, BUILD_HEIGHT - 1);

    if (plane === "TOP") {
      const x = clamp(Math.floor(p.x), -HALF, HALF - 1);
      const z = clamp(Math.floor(p.z), -HALF, HALF - 1);
      return { x, y: BUILD_HEIGHT - 1, z };
    }

    if (plane === "+X") {
      const z = clamp(Math.floor(p.z), -HALF, HALF - 1);
      return { x: HALF - 1, y, z };
    }
    if (plane === "-X") {
      const z = clamp(Math.floor(p.z), -HALF, HALF - 1);
      return { x: -HALF, y, z };
    }
    if (plane === "+Z") {
      const x = clamp(Math.floor(p.x), -HALF, HALF - 1);
      return { x, y, z: HALF - 1 };
    }
    const x = clamp(Math.floor(p.x), -HALF, HALF - 1);
    return { x, y, z: -HALF };
  };

  const handleBoundsPlaneMove = (plane: BoundsPlane) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const c = cellFromBoundsPlane(plane, e.point);
    setHoverAndMaybeDraw(c);
  };

  const handleBoundsPlaneLeave = () => setHoverAndMaybeDraw(null);

  const handleBoundsPlaneClick = (plane: BoundsPlane) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (tool !== "single") return;
    if (e.shiftKey) return;

    const c = cellFromBoundsPlane(plane, e.point);
    placeAtSingle(c.x, c.y, c.z);
  };

  // --- Surface mesh hover/click (adjacent placement + delete) ---
  const handleSurfacePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();

    const n = e.face?.normal;
    if (!n) return;

    const hitVoxel = voxelFromHit(e.point, n);
    const hitKey = keyOf(hitVoxel.x, hitVoxel.y, hitVoxel.z);
    if (!voxels.has(hitKey)) return;

    setHoveredVoxelKey(hitKey);
    hitVoxelCellRef.current = hitVoxel;

    const allowFace = hitVoxel.y === activeLayer || e.altKey;

    // paint/erase should target the hit voxel cell
    if (tool === "paint" || tool === "erase") {
      setHoverAndMaybeDraw(hitVoxel);
      return;
    }

    // draw/single target the adjacent placement cell
    if (!allowFace) {
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;
      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      const y = activeLayer;

      if (!inBounds(x, y, z)) {
        setHoverAndMaybeDraw(null);
        return;
      }
      setHoverAndMaybeDraw({ x, y, z });
      return;
    }

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    const target = { x: hitVoxel.x + dx, y: hitVoxel.y + dy, z: hitVoxel.z + dz };

    if (!inBounds(target.x, target.y, target.z)) {
      setHoverAndMaybeDraw(null);
      return;
    }

    setHoverAndMaybeDraw(target);
  };

  const handleSurfacePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHoveredVoxelKey(null);
    hitVoxelCellRef.current = null;
  };

  const handleSurfaceClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (tool !== "single") return;

    const n = e.face?.normal;
    if (!n) return;

    const hitVoxel = voxelFromHit(e.point, n);
    const hitKey = keyOf(hitVoxel.x, hitVoxel.y, hitVoxel.z);
    if (!voxels.has(hitKey)) return;

    if (e.shiftKey) {
      removeAtSingle(hitVoxel.x, hitVoxel.y, hitVoxel.z);
      return;
    }

    const allowFace = hitVoxel.y === activeLayer || e.altKey;

    if (!allowFace) {
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;
      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      placeAtSingle(x, activeLayer, z);
      return;
    }

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    placeAtSingle(hitVoxel.x + dx, hitVoxel.y + dy, hitVoxel.z + dz);
  };

  const showHover = useMemo(() => {
    if (!hoverCell) return false;
    if (!inBounds(hoverCell.x, hoverCell.y, hoverCell.z)) return false;

    const occupied = voxels.has(keyOf(hoverCell.x, hoverCell.y, hoverCell.z));

    if (tool === "draw") return !occupied;
    if (tool === "paint") return occupied;
    if (tool === "erase") return occupied;
    return !occupied;
  }, [hoverCell, voxels, tool]);

  const hoveredVoxel = useMemo(() => {
    if (!hoveredVoxelKey) return null;
    return voxels.get(hoveredVoxelKey) ?? null;
  }, [hoveredVoxelKey, voxels]);

  // Hotkeys: views + undo/redo + tools
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (t as any)?.isContentEditable) return;

      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? ev.metaKey : ev.ctrlKey;

      if (mod) {
        const k = ev.key.toLowerCase();

        if (k === "z" && !ev.shiftKey) {
          ev.preventDefault();
          undo();
          return;
        }

        if ((k === "z" && ev.shiftKey) || k === "y") {
          ev.preventDefault();
          redo();
          return;
        }
      }

      // tools
      if (ev.key.toLowerCase() === "b") setTool("draw");
      if (ev.key.toLowerCase() === "p") setTool("paint");
      if (ev.key.toLowerCase() === "e") setTool("erase");
      if (ev.key.toLowerCase() === "v") setTool("single");

      // camera views
      if (ev.key === "1") snapToRef.current = CAM_FRONT_POS.clone();
      if (ev.key === "2") snapToRef.current = CAM_RIGHT_POS.clone();
      if (ev.key === "3") snapToRef.current = CAM_TOP_POS.clone();
      if (ev.key === "4") snapToRef.current = CAM_ISO_POS.clone();
      if (!snapToRef.current) return;

      snapTargetRef.current = CAM_TARGET.clone();

      const c = controlsRef.current;
      if (c) {
        c.target.copy(snapTargetRef.current);
        c.update();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div style={{ height: "80vh", width: "100%", position: "relative" }}>
      {/* HUD */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 60,
          padding: "10px 10px",
          borderRadius: 12,
          background: "rgba(15, 15, 18, 0.85)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "white",
          fontSize: 12,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          backdropFilter: "blur(10px)",
          pointerEvents: "auto",
          lineHeight: 1.35,
          width: 340,
          maxWidth: "calc(100vw - 24px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div>Voxels: {voxels.size}</div>
            <div style={{ opacity: 0.75 }}>Views: 1 Front · 2 Right · 3 Top · 4 Iso</div>
            <div style={{ opacity: 0.7 }}>Undo: Ctrl/Cmd+Z · Redo: Ctrl/Cmd+Y / Shift+Z</div>
            <div style={{ opacity: 0.7 }}>Tools: V(single) · B(draw) · P(paint) · E(erase)</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={undo}
              disabled={!canUndo}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: canUndo ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                color: "white",
                cursor: canUndo ? "pointer" : "not-allowed",
                fontSize: 12,
              }}
              title="Undo (Ctrl/Cmd+Z)"
            >
              Undo
            </button>

            <button
              onClick={redo}
              disabled={!canRedo}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: canRedo ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.03)",
                color: "white",
                cursor: canRedo ? "pointer" : "not-allowed",
                fontSize: 12,
              }}
              title="Redo (Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z)"
            >
              Redo
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {(["single", "draw", "paint", "erase"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTool(t)}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: tool === t ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
                textTransform: "capitalize",
              }}
              title={
                t === "draw"
                  ? "Free-draw (place while dragging)"
                  : t === "paint"
                  ? "Paint existing voxels (drag)"
                  : t === "erase"
                  ? "Erase voxels (drag)"
                  : "Single click behavior"
              }
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Command bar */}
      {commandOpen && (
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            zIndex: 60,
            width: 560,
            maxWidth: "calc(100vw - 24px)",
            padding: 10,
            borderRadius: 12,
            background: "rgba(15, 15, 18, 0.85)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "white",
            boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
            backdropFilter: "blur(10px)",
            pointerEvents: "auto",
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
            Commands:{" "}
            <span style={{ fontFamily: "monospace" }}>
              fill / hollow / box / stick / randomwalk / replace / clear
            </span>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={cmdText}
              onChange={(e) => setCmdText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const r = runCommandSafe(cmdText);
                
                }
              }}
              placeholder="e.g. fill -3 0 -3 3 0 3 #54a0ff"
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(0,0,0,0.35)",
                color: "white",
                outline: "none",
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                fontSize: 12,
              }}
            />
            <button
              onClick={() => runCommandSafe(cmdText)}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.08)",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Run
            </button>
          </div>

          {cmdError && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#ff6b6b" }}>{cmdError}</div>
          )}

          <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7, lineHeight: 1.4 }}>
            Examples:{" "}
            <span style={{ fontFamily: "monospace" }}>
              fill -9 0 -9 9 0 9 #222222 · hollow -6 0 -6 6 6 6 #ffffff · box 0 4 0 5 · stick 0 0
              0 10 y · randomwalk 800 #1dd1a1 · replace #222222 #54a0ff · clear
            </span>
          </div>
        </div>
      )}

      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{
          position: [CAM_ISO_POS.x, CAM_ISO_POS.y, CAM_ISO_POS.z],
          fov: 50,
          near: 0.1,
          far: 250,
        }}
        onCreated={({ camera }) => camera.lookAt(CAM_TARGET)}
        gl={{ antialias: true }}
      >
        <color attach="background" args={["#0b0c10"]} />

        {/* Lighting */}
        <ambientLight intensity={0.32} />
        <directionalLight position={[12, 18, 10]} intensity={1.0} castShadow />
        <directionalLight position={[-10, 8, -10]} intensity={0.35} />

        {/* Always-visible floor + active layer grids */}
        <gridHelper args={[GRID_SIZE, GRID_SIZE]} position={[0, 0, 0]} />
        <gridHelper args={[GRID_SIZE, GRID_SIZE]} position={[0, activeLayer + 0.01, 0]} />

        {/* Build cage */}
        <BuildCage size={GRID_SIZE} height={BUILD_HEIGHT} />

        {/* Contact shadows */}
        <ContactShadows position={[0, -0.001, 0]} opacity={0.45} scale={40} blur={2.2} far={30} />

        {/* Active layer pick plane */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, activeLayer, 0]}
          onPointerMove={handlePickPlaneMove}
          onPointerOut={handlePickPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handlePickPlaneClick}
        >
          <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* Bounds picking planes (walls + top) */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, BUILD_HEIGHT + EPS_PLANE, 0]}
          onPointerMove={handleBoundsPlaneMove("TOP")}
          onPointerOut={handleBoundsPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handleBoundsPlaneClick("TOP")}
        >
          <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        <mesh
          rotation={[0, Math.PI / 2, 0]}
          position={[HALF + EPS_PLANE, BUILD_HEIGHT / 2, 0]}
          onPointerMove={handleBoundsPlaneMove("+X")}
          onPointerOut={handleBoundsPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handleBoundsPlaneClick("+X")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        <mesh
          rotation={[0, -Math.PI / 2, 0]}
          position={[-HALF - EPS_PLANE, BUILD_HEIGHT / 2, 0]}
          onPointerMove={handleBoundsPlaneMove("-X")}
          onPointerOut={handleBoundsPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handleBoundsPlaneClick("-X")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        <mesh
          rotation={[0, 0, 0]}
          position={[0, BUILD_HEIGHT / 2, HALF + EPS_PLANE]}
          onPointerMove={handleBoundsPlaneMove("+Z")}
          onPointerOut={handleBoundsPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handleBoundsPlaneClick("+Z")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        <mesh
          rotation={[0, Math.PI, 0]}
          position={[0, BUILD_HEIGHT / 2, -HALF - EPS_PLANE]}
          onPointerMove={handleBoundsPlaneMove("-Z")}
          onPointerOut={handleBoundsPlaneLeave}
          onPointerDown={onPointerDownDraw}
          onClick={handleBoundsPlaneClick("-Z")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* Cursor preview */}
        {showHover && hoverCell && <CursorPreview cell={hoverCell} color={selectedColor} />}

        {/* Greedy meshed surface (single mesh) */}
        <mesh
          geometry={surfaceGeom}
          castShadow
          receiveShadow
          onPointerMove={handleSurfacePointerMove}
          onPointerOut={handleSurfacePointerOut}
          onPointerDown={onPointerDownDraw}
          onClick={handleSurfaceClick}
        >
          <meshStandardMaterial vertexColors roughness={0.7} metalness={0.0} />
        </mesh>

        {/* Hovered voxel outline */}
        {hoveredVoxel && (
          <mesh position={[hoveredVoxel.x + 0.5, hoveredVoxel.y + 0.5, hoveredVoxel.z + 0.5]}>
            <boxGeometry args={[1.03, 1.03, 1.03]} />
            <meshBasicMaterial wireframe transparent opacity={0.7} color="white" />
          </mesh>
        )}

        {/* Post-processing AO */}
        <EffectComposer enableNormalPass>
          <SSAO samples={8} radius={0.18} intensity={10} luminanceInfluence={0.7} />
        </EffectComposer>

        {/* Gizmo axis widget */}
        <GizmoHelper alignment="bottom-right" margin={[80, 80]} renderPriority={2}>
          <GizmoViewport axisColors={["#ff3653", "#8adb00", "#2c8fff"]} labelColor="white" />
        </GizmoHelper>

        {/* Controls */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          target={CAM_TARGET}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.55}
          zoomSpeed={0.9}
          panSpeed={0.7}
          minDistance={6}
          maxDistance={60}
          minPolarAngle={0.02}
          maxPolarAngle={Math.PI - 0.02}
        />

        <SnapDriver controlsRef={controlsRef} snapToRef={snapToRef} snapTargetRef={snapTargetRef} />
      </Canvas>
    </div>
  );
}