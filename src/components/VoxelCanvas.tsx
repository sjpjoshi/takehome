"use client";

import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useMemo, useState } from "react";

type Voxel = { x: number; y: number; z: number; color: string };

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

const GRID_SIZE = 20;       // number of cells across
const HALF = GRID_SIZE / 2; // 10 for GRID_SIZE=20

export default function VoxelCanvas() {
  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const voxelList = useMemo(() => Array.from(voxels.values()), [voxels]);

  const tryPlaceAt = (x: number, y: number, z: number) => {
    // bounds check (x,z in [-HALF, HALF-1])
    if (x < -HALF || x >= HALF || z < -HALF || z >= HALF) return;

    const k = keyOf(x, y, z);
    setVoxels((prev) => {
      if (prev.has(k)) return prev; // already filled
      const next = new Map(prev);
      next.set(k, { x, y, z, color: "#ff6b6b" });
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

  const handleGroundClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();

    // If shift is held, don't place on ground.
    if (e.shiftKey) return;

    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = 0;

    tryPlaceAt(x, y, z);
  };

  const handleVoxelClick = (e: ThreeEvent<MouseEvent>, v: Voxel) => {
    e.stopPropagation();

    if (e.shiftKey) {
      removeAt(v.x, v.y, v.z);
      return;
    }

    // (optional) If you later want clicking a voxel to place *adjacent* blocks,
    // you can use e.face?.normal here. For now: do nothing on normal click.
  };

  return (
    <div style={{ height: "80vh", width: "100%" }}>
      <Canvas camera={{ position: [8, 8, 8], fov: 50 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 10]} intensity={1} />

        {/* Visual grid */}
        <Grid infiniteGrid={false} args={[GRID_SIZE, GRID_SIZE]} />

        {/* Invisible click target plane (bounded) */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
          onClick={handleGroundClick}
        >
          <planeGeometry args={[GRID_SIZE, GRID_SIZE]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* Voxels */}
        {voxelList.map((v) => (
          <mesh
            key={keyOf(v.x, v.y, v.z)}
            position={[v.x + 0.5, v.y + 0.5, v.z + 0.5]}
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