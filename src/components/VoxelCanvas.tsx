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
const HISTORY_LIMIT = 600;

// Camera presets
const CAM_TARGET = new THREE.Vector3(0, 0, 0);
const CAM_ISO_POS = new THREE.Vector3(10, 10, 10);
const CAM_FRONT_POS = new THREE.Vector3(0, 6, 14);
const CAM_RIGHT_POS = new THREE.Vector3(14, 6, 0);
const CAM_TOP_POS = new THREE.Vector3(0, 18, 0.001);
const CAM_LERP = 0.18;

type BoundsPlane = "+X" | "-X" | "+Z" | "-Z" | "TOP";

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
      {/* faint fill */}
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial transparent opacity={0.15} color={color} />
      </mesh>

      {/* pulsing outline */}
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

  // Bounds for the build volume
  const minX = -HALF;
  const maxX = HALF - 1;
  const minZ = -HALF;
  const maxZ = HALF - 1;
  const minY = 0;
  const maxY = BUILD_HEIGHT - 1;

  const dims = [
    maxX - minX + 1, // X count
    maxY - minY + 1, // Y count
    maxZ - minZ + 1, // Z count
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

export default function VoxelCanvas(props: { selectedColor: string; activeLayer: number }) {
  const { selectedColor, activeLayer } = props;

  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const [hoverCell, setHoverCell] = useState<Cell>(null);
  const [hoveredVoxelKey, setHoveredVoxelKey] = useState<string | null>(null);

  // Camera controls
  const controlsRef = useRef<any>(null);
  const snapToRef = useRef<THREE.Vector3 | null>(null);
  const snapTargetRef = useRef<THREE.Vector3>(CAM_TARGET.clone());

  // History stacks
  const undoRef = useRef<Patch[]>([]);
  const redoRef = useRef<Patch[]>([]);
  const [, bumpHistoryUI] = useState(0);

  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;

  const inBounds = (x: number, y: number, z: number) =>
    x >= -HALF && x < HALF && z >= -HALF && z < HALF && y >= 0 && y < BUILD_HEIGHT;

  const pushPatch = (patch: Patch) => {
    undoRef.current.push(patch);
    if (undoRef.current.length > HISTORY_LIMIT) undoRef.current.shift();
    redoRef.current.length = 0;
    bumpHistoryUI((v) => v + 1);
  };

  const applyPatch = (patch: Patch, dir: "undo" | "redo") => {
    const value = dir === "redo" ? patch.after : patch.before;
    setVoxels((prev) => {
      const next = new Map(prev);
      if (value) next.set(patch.key, value);
      else next.delete(patch.key);
      return next;
    });
  };

  const undo = () => {
    const patch = undoRef.current.pop();
    if (!patch) return;
    applyPatch(patch, "undo");
    redoRef.current.push(patch);
    bumpHistoryUI((v) => v + 1);
  };

  const redo = () => {
    const patch = redoRef.current.pop();
    if (!patch) return;
    applyPatch(patch, "redo");
    undoRef.current.push(patch);
    bumpHistoryUI((v) => v + 1);
  };

  const placeAt = (x: number, y: number, z: number) => {
    if (!inBounds(x, y, z)) return;
    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      if (prev.has(k)) return prev;

      const next = new Map(prev);
      const after: Voxel = { x, y, z, color: selectedColor };
      next.set(k, after);

      pushPatch({ key: k, before: null, after });

      return next;
    });
  };

  const removeAt = (x: number, y: number, z: number) => {
    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      const before = prev.get(k);
      if (!before) return prev;

      const next = new Map(prev);
      next.delete(k);

      pushPatch({ key: k, before, after: null });

      return next;
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

  // --- Active layer plane handlers ---
  const handlePickPlaneMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = activeLayer;

    if (!inBounds(x, y, z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) => (prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }));
  };

  const handlePickPlaneLeave = () => setHoverCell(null);

  const handlePickPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.shiftKey) return;

    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    placeAt(x, activeLayer, z);
  };

  // --- Bounds plane helpers (MagicaVoxel cage placement) ---
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
    setHoverCell((prev) => (prev && prev.x === c.x && prev.y === c.y && prev.z === c.z ? prev : c));
  };

  const handleBoundsPlaneLeave = () => setHoverCell(null);

  const handleBoundsPlaneClick = (plane: BoundsPlane) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.shiftKey) return;
    const c = cellFromBoundsPlane(plane, e.point);
    placeAt(c.x, c.y, c.z);
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

    const allowFace = hitVoxel.y === activeLayer || e.altKey;

    if (!allowFace) {
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;
      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      const y = activeLayer;

      if (!inBounds(x, y, z)) {
        setHoverCell(null);
        return;
      }
      setHoverCell((prev) => (prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }));
      return;
    }

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    const target = { x: hitVoxel.x + dx, y: hitVoxel.y + dy, z: hitVoxel.z + dz };

    if (!inBounds(target.x, target.y, target.z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) =>
      prev && prev.x === target.x && prev.y === target.y && prev.z === target.z ? prev : target
    );
  };

  const handleSurfacePointerOut = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHoveredVoxelKey(null);
  };

  const handleSurfaceClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();

    const n = e.face?.normal;
    if (!n) return;

    const hitVoxel = voxelFromHit(e.point, n);
    const hitKey = keyOf(hitVoxel.x, hitVoxel.y, hitVoxel.z);
    if (!voxels.has(hitKey)) return;

    if (e.shiftKey) {
      removeAt(hitVoxel.x, hitVoxel.y, hitVoxel.z);
      return;
    }

    const allowFace = hitVoxel.y === activeLayer || e.altKey;

    if (!allowFace) {
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;
      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      placeAt(x, activeLayer, z);
      return;
    }

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    placeAt(hitVoxel.x + dx, hitVoxel.y + dy, hitVoxel.z + dz);
  };

  // Hover preview cell validity
  const showHover =
    hoverCell !== null &&
    inBounds(hoverCell.x, hoverCell.y, hoverCell.z) &&
    !voxels.has(keyOf(hoverCell.x, hoverCell.y, hoverCell.z));

  const hoveredVoxel = useMemo(() => {
    if (!hoveredVoxelKey) return null;
    return voxels.get(hoveredVoxelKey) ?? null;
  }, [hoveredVoxelKey, voxels]);

  // Hotkeys: views + undo/redo
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
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div>Voxels: {voxels.size}</div>
            <div style={{ opacity: 0.75 }}>Views: 1 Front · 2 Right · 3 Top · 4 Iso</div>
            <div style={{ opacity: 0.7 }}>Undo: Ctrl/Cmd+Z · Redo: Ctrl/Cmd+Y / Shift+Z</div>
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
      </div>

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
          onClick={handlePickPlaneClick}
        >
          <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* Bounds picking planes (walls + top) */}
        {/* TOP */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, BUILD_HEIGHT + EPS_PLANE, 0]}
          onPointerMove={handleBoundsPlaneMove("TOP")}
          onPointerOut={handleBoundsPlaneLeave}
          onClick={handleBoundsPlaneClick("TOP")}
        >
          <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* +X */}
        <mesh
          rotation={[0, Math.PI / 2, 0]}
          position={[HALF + EPS_PLANE, BUILD_HEIGHT / 2, 0]}
          onPointerMove={handleBoundsPlaneMove("+X")}
          onPointerOut={handleBoundsPlaneLeave}
          onClick={handleBoundsPlaneClick("+X")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* -X */}
        <mesh
          rotation={[0, -Math.PI / 2, 0]}
          position={[-HALF - EPS_PLANE, BUILD_HEIGHT / 2, 0]}
          onPointerMove={handleBoundsPlaneMove("-X")}
          onPointerOut={handleBoundsPlaneLeave}
          onClick={handleBoundsPlaneClick("-X")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* +Z */}
        <mesh
          rotation={[0, 0, 0]}
          position={[0, BUILD_HEIGHT / 2, HALF + EPS_PLANE]}
          onPointerMove={handleBoundsPlaneMove("+Z")}
          onPointerOut={handleBoundsPlaneLeave}
          onClick={handleBoundsPlaneClick("+Z")}
        >
          <planeGeometry args={[GRID_SIZE, BUILD_HEIGHT]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* -Z */}
        <mesh
          rotation={[0, Math.PI, 0]}
          position={[0, BUILD_HEIGHT / 2, -HALF - EPS_PLANE]}
          onPointerMove={handleBoundsPlaneMove("-Z")}
          onPointerOut={handleBoundsPlaneLeave}
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

        {/* Gizmo axis widget (rendered after postprocessing) */}
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