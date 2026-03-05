"use client";

import * as THREE from "three";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid } from "@react-three/drei";
import { useMemo, useState } from "react";

type Voxel = { x: number; y: number; z: number; color: string };

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

export default function VoxelCanvas() {
  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());

  const voxelList = useMemo(() => Array.from(voxels.values()), [voxels]);

  const handleGroundClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();

    // Intersection point in world space
    const p = e.point;

    // Convert to grid coords (cell size = 1)
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = 0;

    const k = keyOf(x, y, z);

    setVoxels((prev) => {
      const next = new Map(prev);
      if (!next.has(k)) {
        next.set(k, { x, y, z, color: "#ff6b6b" });
      }
      return next;
    });
  };

  return (
    <div style={{ height: "80vh", width: "100%" }}>
      <Canvas camera={{ position: [8, 8, 8], fov: 50 }}>
        <ambientLight intensity={0.7} />
        <directionalLight position={[10, 15, 10]} intensity={1} />

        {/* Visual grid */}
        <Grid infiniteGrid={false} args={[20, 20]} />

        {/* Invisible click target plane at y=0 */}
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0, 0]}
          onClick={handleGroundClick}
        >
          <planeGeometry args={[200, 200]} />
          <meshBasicMaterial transparent opacity={0} />
        </mesh>

        {/* Voxels */}
        {voxelList.map((v) => (
          <mesh key={keyOf(v.x, v.y, v.z)} position={[v.x + 0.5, v.y + 0.5, v.z + 0.5]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={v.color} />
          </mesh>
        ))}

        <OrbitControls makeDefault />
      </Canvas>
    </div>
  );
}