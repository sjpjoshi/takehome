"use client";

import { useState } from "react";
import VoxelCanvas from "@/components/VoxelCanvas";
import Palette from "@/components/Palette";

export default function Home() {
  const [color, setColor] = useState("#ff6b6b");
  const [layer, setLayer] = useState(0);

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Voxel Tool</h1>

      <div style={{ marginTop: 8, marginBottom: 8 }}>
        <Palette color={color} setColor={setColor} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.85 }}>Y Layer</div>

        <button
          onClick={() => setLayer((y) => y - 1)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#111",
            color: "white",
            cursor: "pointer",
          }}
        >
          −
        </button>

        <div style={{ minWidth: 28, textAlign: "center", fontFamily: "monospace" }}>
          {layer}
        </div>

        <button
          onClick={() => setLayer((y) => y + 1)}
          style={{
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #444",
            background: "#111",
            color: "white",
            cursor: "pointer",
          }}
        >
          +
        </button>

        <div style={{ fontSize: 12, opacity: 0.85 }}>
          (Click ground places at y = {layer})
        </div>
      </div>

      <p style={{ marginTop: 8, marginBottom: 12, opacity: 0.9 }}>
        Orbit: left-drag · Pan: right-drag · Zoom: scroll · Place: click · Remove: shift+click
      </p>

      <VoxelCanvas selectedColor={color} activeLayer={layer} />
    </main>
  );
}