import VoxelCanvas from "@/components/VoxelCanvas";

export default function Home() {
  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Voxel Tool</h1>
      <p style={{ marginTop: 8, marginBottom: 12 }}>
        Orbit: left-drag · Pan: right-drag · Zoom: scroll
      </p>
      <VoxelCanvas />
    </main>
  );
}