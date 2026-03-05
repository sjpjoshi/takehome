"use client";

import * as THREE from "three";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useMemo, useState } from "react";

type Voxel = { x: number; y: number; z: number; color: string };
type Cell = { x: number; y: number; z: number } | null;

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

const GRID_SIZE = 20;
const HALF = GRID_SIZE / 2;

export default function VoxelCanvas(props: { selectedColor: string }) {
  const { selectedColor } = props;

  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const voxelList = useMemo(() => Array.from(voxels.values()), [voxels]);

  const [hoverCell, setHoverCell] = useState<Cell>(null);

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

  // --- Ground interactions: y=0 placement + hover preview ---
  const handleGroundMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = 0;

    if (!inBounds(x, z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) => (prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }));
  };

  const handleGroundLeave = () => setHoverCell(null);

  const handleGroundClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.shiftKey) return; // no erase on ground
    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    placeAt(x, 0, z);
  };

  // --- Voxel interactions: place adjacent on face normal, remove with shift ---
  const handleVoxelPointerMove = (e: ThreeEvent<PointerEvent>, v: Voxel) => {
    e.stopPropagation();

    // Face normal in local space; convert to axis step (-1/0/1)
    const n = e.face?.normal;
    if (!n) return;

    const dx = Math.round(n.x);
    const dy = Math.round(n.y);
    const dz = Math.round(n.z);

    const target = { x: v.x + dx, y: v.y + dy, z: v.z + dz };

    // keep preview bounded on x/z; allow y to grow
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

        <Grid infiniteGrid={false} args={[GRID_SIZE, GRID_SIZE]} />

        {/* Bounded ground plane: click + hover */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
          onClick={handleGroundClick}
          onPointerMove={handleGroundMove}
          onPointerOut={handleGroundLeave}
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

        {/* Voxels */}
        {voxelList.map((v) => (
          <mesh
            key={keyOf(v.x, v.y, v.z)}
            position={[v.x + 0.5, v.y + 0.5, v.z + 0.5]}
            onPointerMove={(e) => handleVoxelPointerMove(e, v)}
            onClick={(e) => handleVoxelClick(e, v)}
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={v.color} />
          </mesh>
        ))}

        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}