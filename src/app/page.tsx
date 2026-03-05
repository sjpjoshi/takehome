"use client";

import { useState } from "react";
import VoxelCanvas from "@/components/VoxelCanvas";
import Palette from "@/components/Palette";
import HelpPanel from "@/components/HelpPanel";

export default function Home() {
  const [color, setColor] = useState("#ff6b6b");
  const [layer, setLayer] = useState(0);
  const [helpOpen, setHelpOpen] = useState(true);

  return (
    <main style={{ height: "100vh", background: "#0b0c10", color: "white" }}>
      {/* Top bar */}
      <div
        style={{
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 14px",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
          background: "rgba(12, 12, 16, 0.85)",
          backdropFilter: "blur(10px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>Voxel Tool</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Layer: <span style={{ fontFamily: "monospace" }}>{layer}</span> · Color:{" "}
            <span style={{ fontFamily: "monospace" }}>{color}</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => setHelpOpen((v) => !v)}
            style={{
              padding: "7px 10px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.16)",
              background: "rgba(255,255,255,0.06)",
              color: "white",
              cursor: "pointer",
            }}
          >
            {helpOpen ? "Hide Help" : "Show Help"}
          </button>
        </div>
      </div>

      {/* Canvas area */}
      <div style={{ position: "relative", height: "calc(100vh - 56px)" }}>
        {/* Floating left toolbar */}
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            background: "rgba(15, 15, 18, 0.92)",
            border: "1px solid rgba(255,255,255,0.12)",
            borderRadius: 14,
            padding: 14,
            boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
            backdropFilter: "blur(10px)",
            zIndex: 40,
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, opacity: 0.95 }}>
            Tools
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Color</div>
            <Palette color={color} setColor={setColor} />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Y Layer</div>

            <button
              onClick={() => setLayer((y) => y - 1)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                cursor: "pointer",
                fontSize: 18,
              }}
              title="Layer down"
            >
              −
            </button>

            <div
              style={{
                minWidth: 36,
                textAlign: "center",
                fontFamily: "monospace",
                padding: "6px 8px",
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "rgba(0,0,0,0.25)",
              }}
            >
              {layer}
            </div>

            <button
              onClick={() => setLayer((y) => y + 1)}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.16)",
                background: "rgba(255,255,255,0.06)",
                color: "white",
                cursor: "pointer",
                fontSize: 18,
              }}
              title="Layer up"
            >
              +
            </button>

            <div style={{ fontSize: 12, opacity: 0.7, marginLeft: 6 }}>
              Click places at y={layer}
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            Tip: Shift+click to erase. Alt to override face placement across layers.
          </div>
        </div>

        {/* Help panel */}
        <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />

        {/* The 3D view */}
        <VoxelCanvas selectedColor={color} activeLayer={layer} />
      </div>
    </main>
  );
}