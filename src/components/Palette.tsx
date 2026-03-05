"use client";

const DEFAULT_COLORS = [
  "#ff6b6b",
  "#feca57",
  "#1dd1a1",
  "#54a0ff",
  "#5f27cd",
  "#ffffff",
  "#222222",
] as const;

export default function Palette(props: {
  color: string;
  setColor: (c: string) => void;
}) {
  const { color, setColor } = props;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 8 }}>
        {DEFAULT_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            title={c}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: c === color ? "2px solid white" : "1px solid #444",
              background: c,
              cursor: "pointer",
            }}
          />
        ))}
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, opacity: 0.85 }}>Custom</span>
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          style={{ width: 36, height: 28, padding: 0, border: "none", background: "transparent" }}
        />
      </label>

      <div style={{ fontSize: 12, opacity: 0.85 }}>
        Current: <span style={{ fontFamily: "monospace" }}>{color}</span>
      </div>
    </div>
  );
}