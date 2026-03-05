"use client";

export default function HelpPanel(props: {
  open: boolean;
  onClose: () => void;
}) {
  const { open, onClose } = props;
  if (!open) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 64,
        right: 16,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        background: "rgba(15, 15, 18, 0.92)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 14,
        padding: 14,
        color: "white",
        boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
        backdropFilter: "blur(10px)",
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>Controls</div>
        <button
          onClick={onClose}
          style={{
            border: "1px solid rgba(255,255,255,0.18)",
            background: "transparent",
            color: "white",
            borderRadius: 10,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.35, opacity: 0.95 }}>
        <div style={{ fontWeight: 700, marginTop: 8 }}>Camera</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li><b>Left drag</b>: Orbit</li>
          <li><b>Right drag</b>: Pan</li>
          <li><b>Scroll</b>: Zoom</li>
        </ul>

        <div style={{ fontWeight: 700, marginTop: 10 }}>Edit</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li><b>Click</b>: Place block on active layer</li>
          <li><b>Click voxel face</b>: Place adjacent block</li>
          <li><b>Shift + click voxel</b>: Remove block</li>
          <li><b>Alt (override)</b>: Use face placement across any layer</li>
        </ul>

        <div style={{ fontWeight: 700, marginTop: 10 }}>Tools</div>
        <ul style={{ margin: "6px 0 0 18px" }}>
          <li><b>Palette</b>: Choose block color</li>
          <li><b>Y Layer</b>: Change build height</li>
        </ul>
      </div>
    </div>
  );
}