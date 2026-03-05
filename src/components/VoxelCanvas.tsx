"use client";

import * as THREE from "three";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, Edges } from "@react-three/drei";
import { useMemo, useState } from "react";

type Voxel = { x: number; y: number; z: number; color: string };
type Cell = { x: number; y: number; z: number } | null;

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

const GRID_SIZE = 20;
const HALF = GRID_SIZE / 2;

export default function VoxelCanvas(props: { selectedColor: string; activeLayer: number }) {
  const { selectedColor, activeLayer } = props;

  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const voxelList = useMemo(() => Array.from(voxels.values()), [voxels]);

  const [hoverCell, setHoverCell] = useState<Cell>(null);
  const [hoveredVoxelKey, setHoveredVoxelKey] = useState<string | null>(null);

  const inBounds = (x: number, z: number) =>
    x >= -HALF && x < HALF && z >= -HALF && z < HALF;

  const placeAt = (x: number, y: number, z: number) => {
    if (!inBounds(x, z)) return;
    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      if (prev.has(k)) return prev;
      const next = new Map(prev);
      next.set(k, { x, y, z, color: selectedColor });
      return next;
    });
  };

  const removeAt = (x: number, y: number, z: number) => {
    const k = keyOf(x, y, z);
    setVoxels((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Map(prev);
      next.delete(k);
      return next;
    });
  };

  // Build-plane intersection helper (y = activeLayer)
  const intersectBuildPlane = (ray: THREE.Ray) => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -activeLayer);
    const hit = new THREE.Vector3();
    const ok = ray.intersectPlane(plane, hit);
    return ok ? hit : null;
  };

  // --- Picking plane (at activeLayer) hover/click: stable layer targeting ---
  const handlePickPlaneMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = e.point; // intersection with this plane
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = activeLayer;

    if (!inBounds(x, z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) =>
      prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }
    );
  };

  const handlePickPlaneLeave = () => setHoverCell(null);

  const handlePickPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.shiftKey) return;

    const p = e.point; // intersection with this plane
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);

    placeAt(x, activeLayer, z);
  };

  // --- Voxel hover/click ---
  // Rule: if voxel is NOT on activeLayer, we don't do face-preview/face-place
  // (unless Alt is held). This prevents "cursor confusion" across layers.
  const handleVoxelPointerMove = (e: ThreeEvent<PointerEvent>, v: Voxel) => {
    e.stopPropagation();

    const allowFace = v.y === activeLayer || e.altKey;

    if (!allowFace) {
      // Keep hover stable on active layer even while hovering other-layer voxels
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;

      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      const y = activeLayer;

      if (!inBounds(x, z)) {
        setHoverCell(null);
        return;
      }

      setHoverCell((prev) =>
        prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }
      );
      return;
    }

    const n = e.face?.normal;
    if (!n) return;

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    const target = { x: v.x + dx, y: v.y + dy, z: v.z + dz };

    if (!inBounds(target.x, target.z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) =>
      prev && prev.x === target.x && prev.y === target.y && prev.z === target.z ? prev : target
    );
  };

  const handleVoxelClick = (e: ThreeEvent<MouseEvent>, v: Voxel) => {
    e.stopPropagation();

    if (e.shiftKey) {
      removeAt(v.x, v.y, v.z);
      return;
    }

    const allowFace = v.y === activeLayer || e.altKey;

    if (!allowFace) {
      // Treat click like placing on active layer plane
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;

      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      placeAt(x, activeLayer, z);
      return;
    }

    const n = e.face?.normal;
    if (!n) return;

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    placeAt(v.x + dx, v.y + dy, v.z + dz);
  };

  const showHover = hoverCell !== null && !voxels.has(keyOf(hoverCell.x, hoverCell.y, hoverCell.z));

  return (
    <div style={{ height: "80vh", width: "100%" }}>
      <Canvas camera={{ position: [8, 8, 8], fov: 50 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 10]} intensity={1} />

        {/* Ground reference grid */}
        <Grid infiniteGrid={false} args={[GRID_SIZE, GRID_SIZE]} position={[0, 0, 0]} />

        {/* Active build grid moves with layer */}
        <Grid args={[GRID_SIZE, GRID_SIZE]} position={[0, activeLayer + 0.01, 0]} />

        {/* Invisible picking plane at activeLayer (this fixes "can't place blocks") */}
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

        {/* Hover preview cube */}
        {showHover && hoverCell && (
          <mesh position={[hoverCell.x + 0.5, hoverCell.y + 0.5, hoverCell.z + 0.5]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial transparent opacity={0.35} color={selectedColor} />
          </mesh>
        )}

        {/* Voxels + outline highlight */}
        {voxelList.map((v) => {
          const k = keyOf(v.x, v.y, v.z);
          return (
            <mesh
              key={k}
              position={[v.x + 0.5, v.y + 0.5, v.z + 0.5]}
              onPointerMove={(e) => handleVoxelPointerMove(e, v)}
              onClick={(e) => handleVoxelClick(e, v)}
              onPointerOver={(e) => {
                e.stopPropagation();
                setHoveredVoxelKey(k);
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                setHoveredVoxelKey((prev) => (prev === k ? null : prev));
              }}
            >
              <boxGeometry args={[1, 1, 1]} />
              <meshStandardMaterial color={v.color} />
              {hoveredVoxelKey === k && <Edges scale={1.01} />}
            </mesh>
          );
        })}

        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}