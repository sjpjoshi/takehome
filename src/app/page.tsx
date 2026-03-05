"use client";

import { useState } from "react";
import VoxelCanvas from "@/components/VoxelCanvas";
import Palette from "@/components/Palette";

export default function Home() {
  const [color, setColor] = useState("#ff6b6b");

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Voxel Tool</h1>

      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <Palette color={color} setColor={setColor} />
      </div>

      <p style={{ marginTop: 8, marginBottom: 12, opacity: 0.9 }}>
        Orbit: left-drag · Pan: right-drag · Zoom: scroll · Place: click · Remove: shift+click
      </p>

      <VoxelCanvas selectedColor={color} />
    </main>
  );
}