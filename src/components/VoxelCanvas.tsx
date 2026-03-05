"use client";

import * as THREE from "three";
import { Canvas, ThreeEvent } from "@react-three/fiber";
import {
  OrbitControls,
  Grid,
  Edges,
  GizmoHelper,
  GizmoViewport,
  ContactShadows
} from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import { EffectComposer, SSAO } from "@react-three/postprocessing";
type Voxel = { x: number; y: number; z: number; color: string };
type Cell = { x: number; y: number; z: number } | null;

function keyOf(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

const GRID_SIZE = 20;
const HALF = GRID_SIZE / 2;

// Camera feel (MagicaVoxel-ish)
const CAM_TARGET = new THREE.Vector3(0, 0, 0);
const CAM_ISO_POS = new THREE.Vector3(10, 10, 10); // isometric-ish
const CAM_FRONT_POS = new THREE.Vector3(0, 6, 14);
const CAM_RIGHT_POS = new THREE.Vector3(14, 6, 0);
const CAM_TOP_POS = new THREE.Vector3(0, 18, 0.001); // avoid singularity
const CAM_LERP = 0.18;

export default function VoxelCanvas(props: { selectedColor: string; activeLayer: number }) {
  const { selectedColor, activeLayer } = props;

  const [voxels, setVoxels] = useState<Map<string, Voxel>>(() => new Map());
  const voxelList = useMemo(() => Array.from(voxels.values()), [voxels]);

  const [hoverCell, setHoverCell] = useState<Cell>(null);
  const [hoveredVoxelKey, setHoveredVoxelKey] = useState<string | null>(null);

  // --- Camera control refs ---
  const controlsRef = useRef<any>(null);
  const snapToRef = useRef<THREE.Vector3 | null>(null);
  const snapTargetRef = useRef<THREE.Vector3>(CAM_TARGET.clone());

  const inBounds = (x: number, z: number) => x >= -HALF && x < HALF && z >= -HALF && z < HALF;

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
    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    const y = activeLayer;

    if (!inBounds(x, z)) {
      setHoverCell(null);
      return;
    }

    setHoverCell((prev) => (prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }));
  };

  const handlePickPlaneLeave = () => setHoverCell(null);

  const handlePickPlaneClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.shiftKey) return;

    const p = e.point;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);

    placeAt(x, activeLayer, z);
  };

  // --- Voxel hover/click ---
  const handleVoxelPointerMove = (e: ThreeEvent<PointerEvent>, v: Voxel) => {
    e.stopPropagation();

    const allowFace = v.y === activeLayer || e.altKey;

    if (!allowFace) {
      const hit = intersectBuildPlane(e.ray);
      if (!hit) return;

      const x = Math.floor(hit.x);
      const z = Math.floor(hit.z);
      const y = activeLayer;

      if (!inBounds(x, z)) {
        setHoverCell(null);
        return;
      }

      setHoverCell((prev) => (prev && prev.x === x && prev.y === y && prev.z === z ? prev : { x, y, z }));
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

  // --- Camera snap hotkeys ---
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      // Don’t steal typing focus
      const t = ev.target as HTMLElement | null;
      const tag = t?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || (t as any)?.isContentEditable) return;

      // 1: Front, 2: Right, 3: Top, 4: Iso
      if (ev.key === "1") snapToRef.current = CAM_FRONT_POS.clone();
      if (ev.key === "2") snapToRef.current = CAM_RIGHT_POS.clone();
      if (ev.key === "3") snapToRef.current = CAM_TOP_POS.clone();
      if (ev.key === "4") snapToRef.current = CAM_ISO_POS.clone();

      if (!snapToRef.current) return;

      // Keep target at origin (or you can target center of build)
      snapTargetRef.current = CAM_TARGET.clone();

      // Kick controls update
      const c = controlsRef.current;
      if (c) {
        c.target.copy(snapTargetRef.current);
        c.update();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Smoothly animate snaps by using OrbitControls' underlying camera each frame
  const onControlsChange = () => {
    // If user is interacting, cancel snap
    // (OrbitControls sets state internally; simplest is: if they move camera, stop snapping)
    // You can keep snapping if you want, but this feels better.
    // We'll cancel on any manual change:
    // snapToRef.current = null; // optional — comment out if you want snap to continue
  };

  return (
    <div style={{ height: "80vh", width: "100%", position: "relative" }}>
      {/* HUD (voxel count + snap hint) */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 60,
          padding: "8px 10px",
          borderRadius: 12,
          background: "rgba(15, 15, 18, 0.85)",
          border: "1px solid rgba(255,255,255,0.12)",
          color: "white",
          fontSize: 12,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
          backdropFilter: "blur(10px)",
          pointerEvents: "none",
          lineHeight: 1.35,
        }}
      >
        <div>Voxels: {voxels.size}</div>
        <div style={{ opacity: 0.75 }}>Views: 1 Front · 2 Right · 3 Top · 4 Iso</div>
      </div>

      <Canvas
        camera={{ position: [CAM_ISO_POS.x, CAM_ISO_POS.y, CAM_ISO_POS.z], fov: 50, near: 0.1, far: 200 }}
        onCreated={({ camera }) => {
          camera.lookAt(CAM_TARGET);
        }}
      >
<ambientLight intensity={0.35} />

<directionalLight
  position={[10, 15, 10]}
  intensity={0.9}
  castShadow
/>

<directionalLight
  position={[-10, 8, -10]}
  intensity={0.35}
/>

<gridHelper args={[GRID_SIZE, GRID_SIZE]} position={[0, 0, 0]} />
<gridHelper args={[GRID_SIZE, GRID_SIZE]} position={[0, activeLayer + 0.01, 0]} />

<ContactShadows
  position={[0, -0.001, 0]}
  opacity={0.4}
  scale={40}
  blur={2}
/>

<EffectComposer enableNormalPass>
  <SSAO
    samples={8}
    radius={0.18}
    intensity={10}
  />
</EffectComposer>

<OrbitControls makeDefault />

      {/* Ground grid (top) */}
    <Grid infiniteGrid={false} args={[GRID_SIZE, GRID_SIZE]} position={[0, 0, 0]} />

{/* Ground grid (underside mirror) */}
<Grid
  infiniteGrid={false}
  args={[GRID_SIZE, GRID_SIZE]}
  position={[0, -0.001, 0]}
  rotation={[Math.PI, 0, 0]}
/>

{/* Active layer grid (top) */}
<Grid args={[GRID_SIZE, GRID_SIZE]} position={[0, activeLayer + 0.01, 0]} />

{/* Active layer grid (underside mirror) */}
<Grid
  args={[GRID_SIZE, GRID_SIZE]}
  position={[0, activeLayer - 0.001, 0]}
  rotation={[Math.PI, 0, 0]}
/>

        {/* Gizmo axis (MagicaVoxel-like corner widget) */}
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport axisColors={["#ff3653", "#8adb00", "#2c8fff"]} labelColor="white" />
        </GizmoHelper>

        {/* Invisible picking plane at activeLayer */}
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

        {/* Voxels */}
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

        {/* Orbit controls tuned */}
        <OrbitControls
          ref={controlsRef}
          makeDefault
          target={CAM_TARGET}
          enableDamping
          dampingFactor={0.08}
          rotateSpeed={0.55}
          zoomSpeed={0.9}
          panSpeed={0.7}
          minDistance={6}
          maxDistance={40}
          minPolarAngle={0.02}
maxPolarAngle={Math.PI - 0.02}
          onChange={onControlsChange}
        />

        {/* Smooth camera snap (runs in React, not a separate component) */}
        <SnapDriver controlsRef={controlsRef} snapToRef={snapToRef} snapTargetRef={snapTargetRef} />
      </Canvas>
    </div>
  );
}

/**
 * Small helper component inside the same file:
 * lerps camera + target to snap view smoothly.
 */
function SnapDriver(props: {
  controlsRef: React.RefObject<any>;
  snapToRef: React.MutableRefObject<THREE.Vector3 | null>;
  snapTargetRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const { controlsRef, snapToRef, snapTargetRef } = props;

  // useFrame is from R3F, but we kept it out of the main component to avoid re-renders.
  // Importing useFrame at top would be fine too; we already didn't in this file.
  // We'll lazily require it via drei? No — simplest: add useFrame import at top if needed.
  // Instead, we can do a tiny workaround: use R3F's internal frame hook via useThree + requestAnimationFrame
  // But easiest is to just import useFrame. We'll do that properly:

  return <SnapDriverInner controlsRef={controlsRef} snapToRef={snapToRef} snapTargetRef={snapTargetRef} />;
}

function SnapDriverInner(props: {
  controlsRef: React.RefObject<any>;
  snapToRef: React.MutableRefObject<THREE.Vector3 | null>;
  snapTargetRef: React.MutableRefObject<THREE.Vector3>;
}) {
  const { controlsRef, snapToRef, snapTargetRef } = props;
  // Import useFrame properly:
  // (Placed here to keep this file copy-pasteable: you must add `useFrame` to the import line above if TS complains.)
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { useFrame } = require("@react-three/fiber") as typeof import("@react-three/fiber");

  useFrame(() => {
    const c = controlsRef.current;
    const dest = snapToRef.current;
    if (!c || !dest) return;

    const cam: THREE.Camera = c.object;
    const camPos = (cam as any).position as THREE.Vector3;

    camPos.lerp(dest, CAM_LERP);
    c.target.lerp(snapTargetRef.current, CAM_LERP);

    c.update();

    // Stop when close enough
    if (camPos.distanceTo(dest) < 0.02) {
      camPos.copy(dest);
      c.target.copy(snapTargetRef.current);
      c.update();
      snapToRef.current = null;
    }
  });

  return null;
}