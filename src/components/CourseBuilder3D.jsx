import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useLoader } from "@react-three/fiber";
import { Grid, Line, OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { TextureLoader } from "three";
import targetTextureUrl from "../assets/uspsa-target.svg";
import noShootTextureUrl from "../assets/uspsa-noshoot.svg";

const STAGE_WIDTH_PX = 980;
const STAGE_HEIGHT_PX = 620;
const COURSE_BUILDER_LIBRARY_STORAGE_KEY = "jmt-course-builder-library-v1";

function toScenePosition(item, stageWidth, stageDepth) {
  const xRatio = (item.x || 0) / STAGE_WIDTH_PX;
  const zRatio = (item.y || 0) / STAGE_HEIGHT_PX;
  return {
    x: (xRatio - 0.5) * stageWidth,
    z: (zRatio - 0.5) * stageDepth,
  };
}

function fromScenePosition(x, z, stageWidth, stageDepth) {
  const pxX = ((x / stageWidth) + 0.5) * STAGE_WIDTH_PX;
  const pxY = ((z / stageDepth) + 0.5) * STAGE_HEIGHT_PX;
  return {
    x: Math.max(12, Math.min(STAGE_WIDTH_PX - 12, pxX)),
    y: Math.max(12, Math.min(STAGE_HEIGHT_PX - 12, pxY)),
  };
}

function toSceneScale(item, stageWidth, stageDepth) {
  return {
    x: ((item.width || 48) / STAGE_WIDTH_PX) * stageWidth,
    z: ((item.height || 48) / STAGE_HEIGHT_PX) * stageDepth,
  };
}

function StageFloor({ stageWidth, stageDepth, onPlace, canEdit }) {
  return (
    <group>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.02, 0]}
        onClick={(event) => {
          event.stopPropagation();
          if (!canEdit) return;
          onPlace(event.point.x, event.point.z);
        }}
      >
        <planeGeometry args={[stageWidth, stageDepth]} />
        <meshStandardMaterial color="#fbfbfa" />
      </mesh>

      <Grid
        position={[0, 0.001, 0]}
        args={[stageWidth, stageDepth]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#e3e3de"
        sectionSize={5}
        sectionThickness={1.4}
        sectionColor="#afaea7"
        fadeDistance={60}
        fadeStrength={0}
        infiniteGrid={false}
      />

      <mesh position={[0, -0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[stageWidth + 4, stageDepth + 4]} />
        <meshStandardMaterial color="#f4f3ef" />
      </mesh>
    </group>
  );
}

function TargetMesh({ noShoot = false, selected = false }) {
  const edgeColor = noShoot ? "#ffffff" : "#c7b08a";
  const texture = useLoader(TextureLoader, noShoot ? noShootTextureUrl : targetTextureUrl);

  return (
    <group>
      <mesh position={[0, 0.78, 0.004]}>
        <planeGeometry args={[0.92, 1.44]} />
        <meshBasicMaterial
          map={texture}
          transparent
          alphaTest={0.22}
          side={2}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <mesh position={[-0.17, 0.28, -0.01]} rotation={[0, 0, 0.055]}>
        <boxGeometry args={[0.03, 1.02, 0.02]} />
        <meshStandardMaterial color="#d6c5b1" roughness={0.95} />
      </mesh>
      <mesh position={[0.17, 0.28, -0.01]} rotation={[0, 0, -0.055]}>
        <boxGeometry args={[0.03, 1.02, 0.02]} />
        <meshStandardMaterial color="#d6c5b1" roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.06, -0.01]}>
        <boxGeometry args={[0.48, 0.03, 0.03]} />
        <meshStandardMaterial color="#3e4348" roughness={0.82} />
      </mesh>
      <mesh position={[-0.23, 0.035, -0.01]}>
        <boxGeometry args={[0.03, 0.08, 0.18]} />
        <meshStandardMaterial color="#2f3438" roughness={0.82} />
      </mesh>
      <mesh position={[0.23, 0.035, -0.01]}>
        <boxGeometry args={[0.03, 0.08, 0.18]} />
        <meshStandardMaterial color="#2f3438" roughness={0.82} />
      </mesh>
      {selected ? (
        <mesh position={[0, 0.78, -0.05]}>
          <boxGeometry args={[0.96, 1.52, 0.02]} />
          <meshBasicMaterial color={edgeColor} transparent opacity={0.25} />
        </mesh>
      ) : null}
    </group>
  );
}

function SteelMesh({ selected = false }) {
  return (
    <group>
      <mesh position={[0, 0.65, 0]}>
        <cylinderGeometry args={[0.16, 0.29, 1.18, 24]} />
        <meshStandardMaterial color="#8ecde8" metalness={0.26} roughness={0.36} />
      </mesh>
      <mesh position={[0, 1.18, 0]}>
        <cylinderGeometry args={[0.21, 0.21, 0.12, 24]} />
        <meshStandardMaterial color="#b7e6f7" metalness={0.22} roughness={0.32} />
      </mesh>
      <mesh position={[-0.12, 0.07, 0]}>
        <boxGeometry args={[0.06, 0.14, 0.06]} />
        <meshStandardMaterial color="#3a3d42" />
      </mesh>
      <mesh position={[0.12, 0.07, 0]}>
        <boxGeometry args={[0.06, 0.14, 0.06]} />
        <meshStandardMaterial color="#3a3d42" />
      </mesh>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[0.52, 0.05, 0.18]} />
        <meshStandardMaterial color="#41454c" />
      </mesh>
      {selected ? (
        <mesh position={[0, 0.66, -0.05]}>
          <cylinderGeometry args={[0.32, 0.42, 1.28, 24]} />
          <meshBasicMaterial color="#dff8ff" transparent opacity={0.2} />
        </mesh>
      ) : null}
    </group>
  );
}

function WallMesh({ width, selected = false, color = "#d7c9b4", height = 1.4 }) {
  return (
    <group>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, 0.08]} />
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
      {Array.from({ length: Math.max(1, Math.floor(width / 0.8)) }).map((_, idx) => {
        const x = -width / 2 + ((idx + 0.5) * width) / Math.max(1, Math.floor(width / 0.8));
        return (
          <mesh key={idx} position={[x, height / 2, 0.045]}>
            <boxGeometry args={[0.03, height, 0.01]} />
            <meshStandardMaterial color="#b9ab95" roughness={1} />
          </mesh>
        );
      })}
      {selected ? (
        <mesh position={[0, height / 2, -0.05]}>
          <boxGeometry args={[width + 0.06, height + 0.06, 0.02]} />
          <meshBasicMaterial color="#efe5ff" transparent opacity={0.2} />
        </mesh>
      ) : null}
    </group>
  );
}

function MeshWallMesh({ width, selected = false, height = 1.45 }) {
  const posts = Math.max(2, Math.floor(width / 0.8));

  return (
    <group>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, 0.06]} />
        <meshStandardMaterial color="#d4b08a" roughness={0.92} transparent opacity={0.22} />
      </mesh>
      {Array.from({ length: posts + 1 }).map((_, idx) => {
        const x = -width / 2 + (idx * width) / posts;
        return (
          <mesh key={`post-${idx}`} position={[x, height / 2, 0.035]}>
            <boxGeometry args={[0.03, height, 0.04]} />
            <meshStandardMaterial color="#b98f67" roughness={0.96} />
          </mesh>
        );
      })}
      {Array.from({ length: 5 }).map((_, idx) => {
        const y = 0.18 + (idx * (height - 0.36)) / 4;
        return (
          <mesh key={`rail-${idx}`} position={[0, y, 0.035]}>
            <boxGeometry args={[width, 0.02, 0.03]} />
            <meshStandardMaterial color="#c79769" roughness={0.95} />
          </mesh>
        );
      })}
      {selected ? (
        <mesh position={[0, height / 2, -0.05]}>
          <boxGeometry args={[width + 0.06, height + 0.06, 0.02]} />
          <meshBasicMaterial color="#ffe7c7" transparent opacity={0.2} />
        </mesh>
      ) : null}
    </group>
  );
}

function PortMesh({ width, height, selected = false }) {
  const frameThickness = 0.08;
  const legHeight = Math.max(0.3, height / 2);

  return (
    <group>
      <mesh position={[0, height - frameThickness / 2, 0]}>
        <boxGeometry args={[width, frameThickness, 0.1]} />
        <meshStandardMaterial color="#ceb17d" roughness={0.9} />
      </mesh>
      <mesh position={[-width / 2 + frameThickness / 2, legHeight / 2, 0]}>
        <boxGeometry args={[frameThickness, legHeight, 0.1]} />
        <meshStandardMaterial color="#ceb17d" roughness={0.9} />
      </mesh>
      <mesh position={[width / 2 - frameThickness / 2, legHeight / 2, 0]}>
        <boxGeometry args={[frameThickness, legHeight, 0.1]} />
        <meshStandardMaterial color="#ceb17d" roughness={0.9} />
      </mesh>
      <mesh position={[0, height / 2, -0.01]}>
        <planeGeometry args={[Math.max(0.2, width - frameThickness * 2), Math.max(0.3, height - frameThickness * 2)]} />
        <meshBasicMaterial color="#8fd4c0" transparent opacity={0.12} />
      </mesh>
      {selected ? (
        <mesh position={[0, height / 2, -0.05]}>
          <boxGeometry args={[width + 0.08, height + 0.08, 0.02]} />
          <meshBasicMaterial color="#d8fff4" transparent opacity={0.16} />
        </mesh>
      ) : null}
    </group>
  );
}

function BarricadeMesh({ width, height, selected = false }) {
  return (
    <group>
      <mesh position={[0, height / 2, 0]}>
        <boxGeometry args={[width, height, 0.08]} />
        <meshStandardMaterial color="#d9b37c" roughness={0.9} />
      </mesh>
      <mesh position={[0, height / 2, 0.05]}>
        <boxGeometry args={[width * 0.58, height * 0.34, 0.025]} />
        <meshStandardMaterial color="#302922" />
      </mesh>
      {[-width / 2 + 0.08, width / 2 - 0.08].map((x, idx) => (
        <mesh key={idx} position={[x, 0.18, 0]}>
          <boxGeometry args={[0.08, 0.36, 0.12]} />
          <meshStandardMaterial color="#50463a" />
        </mesh>
      ))}
      <mesh position={[0, height - 0.06, 0]}>
        <boxGeometry args={[width + 0.08, 0.06, 0.12]} />
        <meshStandardMaterial color="#c9995a" />
      </mesh>
      {selected ? (
        <mesh position={[0, height / 2, -0.05]}>
          <boxGeometry args={[width + 0.08, height + 0.08, 0.02]} />
          <meshBasicMaterial color="#ffebca" transparent opacity={0.18} />
        </mesh>
      ) : null}
    </group>
  );
}

function BarrelMesh({ selected = false }) {
  return (
    <group>
      <mesh position={[0, 0.44, 0]}>
        <cylinderGeometry args={[0.22, 0.22, 0.86, 24]} />
        <meshStandardMaterial color="#284dbd" roughness={0.52} metalness={0.08} />
      </mesh>
      <mesh position={[0, 0.83, 0]}>
        <torusGeometry args={[0.2, 0.025, 12, 32]} />
        <meshStandardMaterial color="#1b2f72" roughness={0.58} />
      </mesh>
      <mesh position={[0, 0.05, 0]}>
        <torusGeometry args={[0.2, 0.025, 12, 32]} />
        <meshStandardMaterial color="#1b2f72" roughness={0.58} />
      </mesh>
      {selected ? (
        <mesh position={[0, 0.44, 0]}>
          <boxGeometry args={[0.58, 1.02, 0.58]} />
          <meshBasicMaterial color="#dfe7ff" transparent opacity={0.12} />
        </mesh>
      ) : null}
    </group>
  );
}

function PositionMesh({ selected = false }) {
  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <mesh>
        <ringGeometry args={[0.24, 0.38, 32]} />
        <meshBasicMaterial color="#19e6ee" side={2} />
      </mesh>
      <mesh>
        <circleGeometry args={[0.16, 24]} />
        <meshBasicMaterial color="#1ef4f7" side={2} />
      </mesh>
      {selected ? (
        <mesh position={[0, 0, -0.01]}>
          <ringGeometry args={[0.17, 0.46, 32]} />
          <meshBasicMaterial color="#e6fdff" transparent opacity={0.22} side={2} />
        </mesh>
      ) : null}
    </group>
  );
}

function FaultLineMesh({ width, selected = false }) {
  return (
    <group>
      <mesh position={[0, 0.03, 0]}>
        <boxGeometry args={[width, 0.06, 0.18]} />
        <meshStandardMaterial color="#efbf63" />
      </mesh>
      {Array.from({ length: Math.max(1, Math.floor(width / 0.55)) }).map((_, idx) => {
        const x = -width / 2 + ((idx + 0.5) * width) / Math.max(1, Math.floor(width / 0.55));
        return (
          <mesh key={idx} position={[x, 0.062, 0]}>
            <boxGeometry args={[0.12, 0.01, 0.18]} />
            <meshStandardMaterial color="#ffe3a0" />
          </mesh>
        );
      })}
      {selected ? (
        <mesh position={[0, 0.03, -0.05]}>
          <boxGeometry args={[width + 0.06, 0.07, 0.02]} />
          <meshBasicMaterial color="#fff0cf" transparent opacity={0.18} />
        </mesh>
      ) : null}
    </group>
  );
}

function PositionPath({ items, stageWidth, stageDepth }) {
  const positionPoints = useMemo(
    () =>
      items
        .filter((item) => item.type === "position")
        .sort((a, b) => {
          const aNum = Number(String(a.label || "").replace(/\D+/g, "")) || 0;
          const bNum = Number(String(b.label || "").replace(/\D+/g, "")) || 0;
          return aNum - bNum;
        })
        .map((item) => {
          const point = toScenePosition(item, stageWidth, stageDepth);
          return [point.x, 0.08, point.z];
        }),
    [items, stageWidth, stageDepth]
  );

  if (positionPoints.length < 2) return null;

  return (
    <Line
      points={positionPoints}
      color="#222226"
      lineWidth={2.2}
      dashed
      dashSize={0.55}
      gapSize={0.38}
    />
  );
}

function AssignmentLines({ items, stageWidth, stageDepth }) {
  const positionItems = items.filter((item) => item.type === "position" && Array.isArray(item.assignedTargetIds));
  const targetLookup = new Map(items.map((item) => [item.id, item]));

  return (
    <>
      {positionItems.flatMap((positionItem) => {
        const from = toScenePosition(positionItem, stageWidth, stageDepth);
        return positionItem.assignedTargetIds
          .map((targetId) => targetLookup.get(targetId))
          .filter(Boolean)
          .map((targetItem) => {
            const to = toScenePosition(targetItem, stageWidth, stageDepth);
            return (
              <Line
                key={`${positionItem.id}-${targetItem.id}`}
                points={[
                  [from.x, 0.1, from.z],
                  [to.x, 0.34, to.z],
                ]}
                color="#11cdd4"
                lineWidth={1.4}
                dashed
                dashSize={0.22}
                gapSize={0.14}
              />
            );
          });
      })}
    </>
  );
}

function BuilderItem({
  item,
  stageWidth,
  stageDepth,
  isSelected,
  onSelect,
  onMove,
  selectedPositionId,
  onToggleAssignment,
}) {
  const [dragging, setDragging] = useState(false);
  const { x, z } = toScenePosition(item, stageWidth, stageDepth);
  const sceneSize = toSceneScale(item, stageWidth, stageDepth);
  const groupRef = useRef(null);

  const rotationY = useMemo(() => ((item.rotation || 0) * Math.PI) / 180, [item.rotation]);

  return (
    <group
      ref={groupRef}
      position={[x, 0, z]}
      rotation={[0, rotationY, 0]}
      onClick={(event) => {
        event.stopPropagation();
        if (
          selectedPositionId &&
          selectedPositionId !== item.id &&
          ["target", "no-shoot", "steel"].includes(item.type)
        ) {
          onToggleAssignment(selectedPositionId, item.id);
          return;
        }
        onSelect(item.id);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.target.setPointerCapture(event.pointerId);
        onSelect(item.id);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        event.stopPropagation();
        const next = fromScenePosition(event.point.x, event.point.z, stageWidth, stageDepth);
        onMove(item.id, next.x, next.y);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        event.target.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
    >
      {item.type === "target" ? <TargetMesh selected={isSelected} /> : null}
      {item.type === "no-shoot" ? <TargetMesh noShoot selected={isSelected} /> : null}
      {item.type === "steel" ? <SteelMesh selected={isSelected} /> : null}
      {item.type === "wall" ? (
        <WallMesh width={Math.max(0.6, sceneSize.x)} selected={isSelected} />
      ) : null}
      {item.type === "mesh-wall" ? (
        <MeshWallMesh width={Math.max(0.6, sceneSize.x)} selected={isSelected} />
      ) : null}
      {item.type === "port" ? (
        <PortMesh
          width={Math.max(0.8, sceneSize.x)}
          height={Math.max(0.9, sceneSize.z * 1.45)}
          selected={isSelected}
        />
      ) : null}
      {item.type === "barricade" ? (
        <BarricadeMesh
          width={Math.max(0.8, sceneSize.x)}
          height={Math.max(1.1, sceneSize.z * 1.45)}
          selected={isSelected}
        />
      ) : null}
      {item.type === "barrel-stack" ? <BarrelMesh selected={isSelected} /> : null}
      {item.type === "position" ? <PositionMesh selected={isSelected} /> : null}
      {item.type === "fault-line" ? (
        <FaultLineMesh width={Math.max(0.8, sceneSize.x)} selected={isSelected} />
      ) : null}
    </group>
  );
}

function BuilderScene({
  theme,
  stageWidth,
  stageDepth,
  items,
  selectedId,
  setSelectedId,
  addItem,
  moveItem,
  activeTool,
  canEdit,
  cameraPreset,
  cameraResetTick,
  zoomCommand,
  zoomCommandTick,
  selectedPositionId,
  onToggleAssignment,
}) {
  const cameraRef = useRef(null);
  const controlsRef = useRef(null);

  useEffect(() => {
    if (!cameraRef.current || !controlsRef.current) return;

    const presets = {
      overview: { position: [0, 12, 15], target: [0, 0.75, 0] },
      top: { position: [0, 19, 0.01], target: [0, 0, 0] },
      lane: { position: [0, 7.5, 22], target: [0, 0.8, 0] },
      angle: { position: [10, 8.5, 12], target: [0, 0.8, 0] },
    };

    const preset = presets[cameraPreset] || presets.overview;
    cameraRef.current.position.set(...preset.position);
    controlsRef.current.target.set(...preset.target);
    controlsRef.current.update();
  }, [cameraPreset, cameraResetTick, stageWidth, stageDepth]);

  useEffect(() => {
    if (!cameraRef.current || !controlsRef.current || !zoomCommand) return;

    if (typeof controlsRef.current.dollyIn === "function" && typeof controlsRef.current.dollyOut === "function") {
      if (zoomCommand === "in") {
        controlsRef.current.dollyIn(1.18);
      } else if (zoomCommand === "out") {
        controlsRef.current.dollyOut(1.18);
      }
      controlsRef.current.update();
      return;
    }

    const offset = cameraRef.current.position.clone().sub(controlsRef.current.target);
    offset.multiplyScalar(zoomCommand === "in" ? 0.88 : 1.14);
    cameraRef.current.position.copy(controlsRef.current.target.clone().add(offset));
    controlsRef.current.update();
  }, [zoomCommand, zoomCommandTick]);

  return (
    <Canvas
      shadows
      gl={{ antialias: true }}
      onPointerMissed={() => setSelectedId(null)}
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 24,
      }}
    >
      <color attach="background" args={["#f6f5f1"]} />
      <fog attach="fog" args={["#faf9f5", 18, 50]} />

      <PerspectiveCamera ref={cameraRef} makeDefault position={[0, 12, 15]} fov={42} />
      <ambientLight intensity={1.6} />
      <directionalLight
        castShadow
        intensity={1.8}
        position={[6, 14, 8]}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <directionalLight intensity={0.65} position={[-8, 10, -10]} />

      <StageFloor
        stageWidth={stageWidth}
        stageDepth={stageDepth}
        canEdit={canEdit}
        onPlace={(x, z) => {
          const next = fromScenePosition(x, z, stageWidth, stageDepth);
          addItem(activeTool, next.x, next.y);
        }}
      />

      {items.map((item) => (
        <BuilderItem
          key={item.id}
          item={item}
          stageWidth={stageWidth}
          stageDepth={stageDepth}
          isSelected={selectedId === item.id}
          onSelect={setSelectedId}
          onMove={moveItem}
          selectedPositionId={selectedPositionId}
          onToggleAssignment={onToggleAssignment}
        />
      ))}

      <PositionPath items={items} stageWidth={stageWidth} stageDepth={stageDepth} />
      <AssignmentLines items={items} stageWidth={stageWidth} stageDepth={stageDepth} />

      <OrbitControls
        ref={controlsRef}
        enablePan
        enableRotate
        enableZoom
        minPolarAngle={0.55}
        maxPolarAngle={1.45}
        minDistance={8}
        maxDistance={28}
        target={[0, 0.75, 0]}
      />
    </Canvas>
  );
}

export default function CourseBuilder3D(props) {
  const {
    theme,
    isCompactBuilderLayout,
    courseBuilderName,
    setCourseBuilderName,
    courseBuilderNotes,
    setCourseBuilderNotes,
    courseBuilderStageTitle,
    setCourseBuilderStageTitle,
    courseBuilderStageWidth,
    setCourseBuilderStageWidth,
    courseBuilderStageDepth,
    setCourseBuilderStageDepth,
    courseBuilderTool,
    setCourseBuilderTool,
    courseBuilderItems,
    courseBuilderSelectedId,
    setCourseBuilderSelectedId,
    selectedCourseBuilderItem,
    courseBuilderSummary,
    courseBuilderTransferCode,
    setCourseBuilderTransferCode,
    copyCourseBuilderCode,
    loadCourseBuilderCode,
    updateCourseBuilderItem,
    duplicateSelectedCourseItem,
    removeSelectedCourseItem,
    clearCourseBuilderLayout,
    addCourseBuilderItemAt,
    moveCourseBuilderItem,
    message,
  } = props;

  const [utilityTab, setUtilityTab] = useState("edit");
  const [cameraPreset, setCameraPreset] = useState("overview");
  const [cameraResetTick, setCameraResetTick] = useState(0);
  const [zoomCommand, setZoomCommand] = useState(null);
  const [zoomCommandTick, setZoomCommandTick] = useState(0);
  const [showBuilderHelp, setShowBuilderHelp] = useState(false);
  const [savedCourses, setSavedCourses] = useState([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(COURSE_BUILDER_LIBRARY_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      setSavedCourses(Array.isArray(parsed) ? parsed : []);
    } catch {
      setSavedCourses([]);
    }
  }, []);

  const builderTools = [
    { key: "target", label: "USPSA Target", shortLabel: "Target", icon: "◎" },
    { key: "no-shoot", label: "No Shoot", shortLabel: "No Shoot", icon: "◉" },
    { key: "steel", label: "Steel Popper", shortLabel: "Steel", icon: "◌" },
    { key: "position", label: "Start Position", shortLabel: "Position", icon: "●" },
    { key: "fault-line", label: "Fault Line", shortLabel: "Fault Line", icon: "━" },
    { key: "wall", label: "Vision Barrier", shortLabel: "Wall", icon: "▭" },
    { key: "mesh-wall", label: "Mesh Wall", shortLabel: "Mesh", icon: "▥" },
    { key: "port", label: "Port / Opening", shortLabel: "Port", icon: "⌴" },
    { key: "barricade", label: "Barricade", shortLabel: "Barricade", icon: "▣" },
    { key: "barrel-stack", label: "Barrels", shortLabel: "Barrels", icon: "◍" },
  ];

  const assignableTargets = useMemo(
    () => courseBuilderItems.filter((item) => ["target", "no-shoot", "steel"].includes(item.type)),
    [courseBuilderItems]
  );
  const selectedPositionId =
    selectedCourseBuilderItem?.type === "position" ? selectedCourseBuilderItem.id : null;

  const rulerTicksDepth = useMemo(
    () => Array.from({ length: Math.max(2, courseBuilderStageDepth + 1) }, (_, index) => index),
    [courseBuilderStageDepth]
  );

  const rulerTicksWidth = useMemo(
    () => Array.from({ length: Math.max(2, courseBuilderStageWidth + 1) }, (_, index) => index),
    [courseBuilderStageWidth]
  );

  const railButtonStyle = (active) => ({
    width: "100%",
    borderRadius: 16,
    border: `1px solid ${active ? theme.accent : theme.border}`,
    background: active ? theme.accentSoft : theme.cardBgSoft,
    color: active ? theme.text : theme.subtext,
    padding: "10px 12px",
    display: "flex",
    alignItems: "center",
    gap: 10,
    cursor: "pointer",
    fontWeight: 700,
    textAlign: "left",
  });

  const overlayPanelStyle = {
    background: "rgba(20,20,24,0.88)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 18,
    padding: 12,
    boxShadow: "0 14px 36px rgba(0,0,0,0.28)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  };

  const overlayButtonStyle = (active = false) => ({
    ...railButtonStyle(active),
    background: active ? "rgba(200,163,106,0.24)" : "rgba(255,255,255,0.06)",
    color: "#f3efe6",
    border: `1px solid ${active ? theme.accent : "rgba(255,255,255,0.08)"}`,
  });

  const fieldInputStyle = {
    background: "rgba(255,255,255,0.06)",
    color: "#f3efe6",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    boxSizing: "border-box",
  };

  const persistLibrary = (nextCourses) => {
    setSavedCourses(nextCourses);
    try {
      localStorage.setItem(COURSE_BUILDER_LIBRARY_STORAGE_KEY, JSON.stringify(nextCourses));
    } catch {
      // ignore local library persistence failures for now
    }
  };

  const saveCurrentCourseToLibrary = () => {
    const snapshot = {
      id: `course-${Date.now()}`,
      savedAt: new Date().toISOString(),
      name: courseBuilderName || "Untitled Course",
      notes: courseBuilderNotes || "",
      stageTitle: courseBuilderStageTitle || "Field Course",
      stageWidth: Number(courseBuilderStageWidth) || 32,
      stageDepth: Number(courseBuilderStageDepth) || 18,
      items: Array.isArray(courseBuilderItems) ? courseBuilderItems : [],
    };

    const deduped = savedCourses.filter((course) => course.name !== snapshot.name);
    persistLibrary([snapshot, ...deduped]);
    setUtilityTab("library");
  };

  const loadSavedCourse = (course) => {
    setCourseBuilderName(course?.name || "Loaded Course");
    setCourseBuilderNotes(course?.notes || "");
    setCourseBuilderStageTitle(course?.stageTitle || "Field Course");
    setCourseBuilderStageWidth(Number(course?.stageWidth) || 32);
    setCourseBuilderStageDepth(Number(course?.stageDepth) || 18);
    setCourseBuilderItems(Array.isArray(course?.items) ? course.items : []);
    setCourseBuilderSelectedId(null);
    setUtilityTab("edit");
  };

  const deleteSavedCourse = (courseId) => {
    persistLibrary(savedCourses.filter((course) => course.id !== courseId));
  };

  const utilityIconButtonStyle = {
    width: 44,
    height: 44,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(20,20,24,0.88)",
    color: "#f3efe6",
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    boxShadow: "0 14px 36px rgba(0,0,0,0.28)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    fontWeight: 900,
    fontSize: 16,
  };

  const topBarHeight = isCompactBuilderLayout ? 58 : 68;
  const leftRailWidth = isCompactBuilderLayout ? 0 : 86;
  const rightRailWidth = isCompactBuilderLayout ? 0 : 74;
  const lowerPanelWidth = isCompactBuilderLayout ? "calc(100% - 24px)" : 340;

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // ignore browser fullscreen failures in the builder shell
    }
  };

  const toggleAssignedTarget = (positionId, targetId) => {
    const positionItem = courseBuilderItems.find((item) => item.id === positionId && item.type === "position");
    if (!positionItem) return;

    const currentAssigned = Array.isArray(positionItem.assignedTargetIds)
      ? positionItem.assignedTargetIds
      : [];
    const nextAssigned = currentAssigned.includes(targetId)
      ? currentAssigned.filter((id) => id !== targetId)
      : [...currentAssigned, targetId];

    updateCourseBuilderItem(positionId, {
      assignedTargetIds: nextAssigned,
    });
  };

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: isCompactBuilderLayout ? 520 : 760,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: isCompactBuilderLayout ? 0 : 28,
          overflow: "hidden",
          background: "#ece8df",
        }}
      >
        <BuilderScene
          theme={theme}
          stageWidth={courseBuilderStageWidth}
          stageDepth={courseBuilderStageDepth}
          items={courseBuilderItems}
          selectedId={courseBuilderSelectedId}
          setSelectedId={setCourseBuilderSelectedId}
          addItem={addCourseBuilderItemAt}
          moveItem={moveCourseBuilderItem}
          activeTool={courseBuilderTool}
          canEdit
          cameraPreset={cameraPreset}
          cameraResetTick={cameraResetTick}
          zoomCommand={zoomCommand}
          zoomCommandTick={zoomCommandTick}
          selectedPositionId={selectedPositionId}
          onToggleAssignment={toggleAssignedTarget}
        />
      </div>

      <div
        style={{
          position: "absolute",
          top: isCompactBuilderLayout ? 10 : 14,
          left: isCompactBuilderLayout ? 10 : 14,
          right: isCompactBuilderLayout ? 10 : 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          zIndex: 7,
        }}
      >
        <div
          style={{
            ...overlayPanelStyle,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            borderRadius: 20,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 900, color: "#f3efe6", lineHeight: 1.1 }}>
            {courseBuilderStageTitle || "Field Course"}
          </div>
          <div style={{ width: 1, alignSelf: "stretch", background: "rgba(255,255,255,0.12)" }} />
          <div style={{ fontSize: 12, fontWeight: 800, color: "rgba(243,239,230,0.78)" }}>
            {courseBuilderStageWidth}×{courseBuilderStageDepth} yd
          </div>
          <button type="button" onClick={() => setUtilityTab("stage")} style={{ ...utilityIconButtonStyle, width: 36, height: 36, borderRadius: 10, boxShadow: "none" }} title="Stage settings">
            ⚙
          </button>
          <button type="button" onClick={() => setUtilityTab("library")} style={{ ...utilityIconButtonStyle, width: 36, height: 36, borderRadius: 10, boxShadow: "none" }} title="Course library">
            ☰
          </button>
        </div>

        <div
          style={{
            ...overlayPanelStyle,
            display: "flex",
            gap: 8,
            padding: 6,
            borderRadius: 20,
          }}
        >
          <button type="button" onClick={copyCourseBuilderCode} style={utilityIconButtonStyle} title="Copy course code">
            ⧉
          </button>
          <button type="button" onClick={saveCurrentCourseToLibrary} style={utilityIconButtonStyle} title="Save to library">
            ⌾
          </button>
          <button type="button" onClick={() => setUtilityTab("library")} style={utilityIconButtonStyle} title="Open library">
            📁
          </button>
          <button
            type="button"
            onClick={() => setShowBuilderHelp((value) => !value)}
            style={utilityIconButtonStyle}
            title="Builder tips"
          >
            ?
          </button>
          <button type="button" onClick={clearCourseBuilderLayout} style={utilityIconButtonStyle} title="New blank stage">
            ↺
          </button>
          <button type="button" onClick={toggleFullscreen} style={utilityIconButtonStyle} title="Toggle fullscreen">
            ⛶
          </button>
        </div>
      </div>

      {!isCompactBuilderLayout ? (
        <>
          <div
            style={{
              position: "absolute",
              top: topBarHeight + 18,
              left: 18,
              width: leftRailWidth,
              display: "grid",
              gap: 8,
              zIndex: 6,
            }}
          >
            {builderTools.map((tool) => (
              <button
                key={tool.key}
                type="button"
                onClick={() => setCourseBuilderTool(tool.key)}
                style={{
                  ...overlayPanelStyle,
                  padding: "10px 8px",
                  borderRadius: 18,
                  display: "grid",
                  justifyItems: "center",
                  gap: 5,
                  color: courseBuilderTool === tool.key ? "#f3efe6" : "rgba(243,239,230,0.72)",
                  border: `1px solid ${courseBuilderTool === tool.key ? theme.accent : "rgba(255,255,255,0.08)"}`,
                  background:
                    courseBuilderTool === tool.key
                      ? "rgba(200,163,106,0.24)"
                      : "rgba(20,20,24,0.84)",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 20, lineHeight: 1 }}>{tool.icon}</div>
                <div style={{ fontSize: 10, fontWeight: 800, textAlign: "center" }}>{tool.shortLabel}</div>
              </button>
            ))}
          </div>

          <div
            style={{
              position: "absolute",
              top: topBarHeight + 18,
              right: 18,
              width: rightRailWidth,
              display: "grid",
              gap: 8,
              zIndex: 6,
            }}
          >
            {[
              { key: "overview", label: "OV", icon: "◫" },
              { key: "top", label: "TOP", icon: "◻" },
              { key: "lane", label: "DN", icon: "↧" },
              { key: "angle", label: "ANG", icon: "◩" },
              { key: "zoom-in", label: "+", icon: "＋" },
              { key: "zoom-out", label: "-", icon: "－" },
            ].map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => {
                  if (preset.key === "zoom-in" || preset.key === "zoom-out") {
                    setZoomCommand(preset.key === "zoom-in" ? "in" : "out");
                    setZoomCommandTick((value) => value + 1);
                  } else {
                    setCameraPreset(preset.key);
                    setCameraResetTick((value) => value + 1);
                  }
                }}
                style={{
                  ...overlayPanelStyle,
                  padding: "10px 6px",
                  borderRadius: 18,
                  display: "grid",
                  justifyItems: "center",
                  gap: 4,
                  color:
                    cameraPreset === preset.key || preset.key.startsWith("zoom-")
                      ? "#f3efe6"
                      : "rgba(243,239,230,0.72)",
                  border: `1px solid ${
                    cameraPreset === preset.key ? theme.accent : "rgba(255,255,255,0.08)"
                  }`,
                  background:
                    cameraPreset === preset.key
                      ? "rgba(200,163,106,0.24)"
                      : "rgba(20,20,24,0.84)",
                  cursor: "pointer",
                }}
              >
                <div style={{ fontSize: 18, lineHeight: 1 }}>{preset.icon}</div>
                <div style={{ fontSize: 9, fontWeight: 900 }}>{preset.label}</div>
              </button>
            ))}
          </div>
        </>
      ) : null}

      {!isCompactBuilderLayout ? (
        <>
          <div
            style={{
              position: "absolute",
              top: topBarHeight + 92,
              left: leftRailWidth + 30,
              right: rightRailWidth + 30,
              bottom: 188,
              borderRadius: 28,
              boxShadow: "inset 0 0 0 2px rgba(46,44,40,0.28)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          />
          <div
            style={{
              position: "absolute",
              top: topBarHeight + 84,
              left: leftRailWidth + 34,
              right: rightRailWidth + 34,
              display: "flex",
              justifyContent: "space-between",
              zIndex: 4,
            }}
          >
            {rulerTicksDepth.map((tick) => (
              <div
                key={`depth-${tick}`}
                style={{
                  display: "grid",
                  justifyItems: "center",
                  gap: 4,
                  color: "#1f1f22",
                  fontWeight: tick < courseBuilderStageDepth ? 700 : 900,
                  fontSize: 11,
                }}
              >
                <div style={{ width: 1, height: tick % 5 === 0 ? 16 : 10, background: "rgba(40,38,34,0.6)" }} />
                <div>{tick}</div>
              </div>
            ))}
          </div>
          <div
            style={{
              position: "absolute",
              left: leftRailWidth + 6,
              top: topBarHeight + 102,
              bottom: 200,
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              zIndex: 4,
            }}
          >
            {rulerTicksWidth.map((tick) => (
              <div
                key={`width-${tick}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "#1f1f22",
                  fontWeight: tick < courseBuilderStageWidth ? 700 : 900,
                  fontSize: 11,
                }}
              >
                <div style={{ width: tick % 5 === 0 ? 16 : 10, height: 1, background: "rgba(40,38,34,0.6)" }} />
                <div>{tick}</div>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {isCompactBuilderLayout ? (
        <div
          style={{
            position: "absolute",
            top: 70,
            left: 12,
            right: 12,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            zIndex: 6,
          }}
        >
          {builderTools.map((tool) => (
            <button
              key={tool.key}
              type="button"
              onClick={() => setCourseBuilderTool(tool.key)}
              style={{
                ...overlayPanelStyle,
                padding: "8px 10px",
                textAlign: "center",
                color: courseBuilderTool === tool.key ? "#f3efe6" : "rgba(243,239,230,0.74)",
                border: `1px solid ${courseBuilderTool === tool.key ? theme.accent : "rgba(255,255,255,0.08)"}`,
                background:
                  courseBuilderTool === tool.key
                    ? "rgba(200,163,106,0.24)"
                    : "rgba(20,20,24,0.84)",
                cursor: "pointer",
                minWidth: 88,
              }}
            >
              <div style={{ fontSize: 18, lineHeight: 1, marginBottom: 3 }}>{tool.icon}</div>
              <div style={{ fontSize: 10, fontWeight: 800 }}>{tool.shortLabel}</div>
            </button>
          ))}
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          right: isCompactBuilderLayout ? 12 : 18,
          bottom: isCompactBuilderLayout ? 92 : 18,
          width: lowerPanelWidth,
          display: "grid",
          gap: 10,
          zIndex: 6,
        }}
      >
        <div
          style={{
            ...overlayPanelStyle,
            display: "flex",
            gap: 6,
            padding: 6,
          }}
        >
          {[
            { key: "edit", label: "Edit" },
            { key: "library", label: "Library" },
            { key: "transfer", label: "Transfer" },
            { key: "stage", label: "Stage" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setUtilityTab(tab.key)}
              style={{
                flex: 1,
                borderRadius: 12,
                border: `1px solid ${utilityTab === tab.key ? theme.accent : "rgba(255,255,255,0.08)"}`,
                background: utilityTab === tab.key ? "rgba(200,163,106,0.22)" : "rgba(255,255,255,0.05)",
                color: "#f3efe6",
                fontWeight: 800,
                fontSize: 12,
                padding: "10px 8px",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div style={{ ...overlayPanelStyle, color: "#f3efe6" }}>
          {utilityTab === "edit" ? (
            <>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Selected Piece</div>
              {selectedCourseBuilderItem ? (
                <div style={{ display: "grid", gap: 10 }}>
                  <input
                    value={selectedCourseBuilderItem.label}
                    onChange={(e) =>
                      updateCourseBuilderItem(selectedCourseBuilderItem.id, { label: e.target.value })
                    }
                    style={fieldInputStyle}
                  />
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                    <input
                      type="number"
                      min="10"
                      value={selectedCourseBuilderItem.width || ""}
                      onChange={(e) =>
                        updateCourseBuilderItem(selectedCourseBuilderItem.id, {
                          width: Math.max(10, Number(e.target.value) || 10),
                        })
                      }
                      style={fieldInputStyle}
                    />
                    <input
                      type="number"
                      min="8"
                      value={selectedCourseBuilderItem.height || ""}
                      onChange={(e) =>
                        updateCourseBuilderItem(selectedCourseBuilderItem.id, {
                          height: Math.max(8, Number(e.target.value) || 8),
                        })
                      }
                      style={fieldInputStyle}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      onClick={() =>
                        updateCourseBuilderItem(selectedCourseBuilderItem.id, {
                          rotation: (selectedCourseBuilderItem.rotation || 0) - 15,
                        })
                      }
                      style={overlayButtonStyle()}
                    >
                      Rotate -15
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateCourseBuilderItem(selectedCourseBuilderItem.id, {
                          rotation: (selectedCourseBuilderItem.rotation || 0) + 15,
                        })
                      }
                      style={overlayButtonStyle()}
                    >
                      Rotate +15
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button type="button" onClick={duplicateSelectedCourseItem} style={overlayButtonStyle()}>
                      Duplicate
                    </button>
                    <button type="button" onClick={removeSelectedCourseItem} style={overlayButtonStyle()}>
                      Delete
                    </button>
                  </div>
                  {selectedCourseBuilderItem.type === "position" ? (
                    <div
                      style={{
                        borderRadius: 14,
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.04)",
                        padding: 10,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div style={{ fontWeight: 800, fontSize: 12 }}>Assigned Targets</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {assignableTargets.length ? (
                          assignableTargets.map((targetItem) => {
                            const isAssigned = Array.isArray(selectedCourseBuilderItem.assignedTargetIds)
                              ? selectedCourseBuilderItem.assignedTargetIds.includes(targetItem.id)
                              : false;

                            return (
                              <button
                                key={targetItem.id}
                                type="button"
                                onClick={() => {
                                  const currentAssigned = Array.isArray(selectedCourseBuilderItem.assignedTargetIds)
                                    ? selectedCourseBuilderItem.assignedTargetIds
                                    : [];
                                  const nextAssigned = isAssigned
                                    ? currentAssigned.filter((id) => id !== targetItem.id)
                                    : [...currentAssigned, targetItem.id];
                                  updateCourseBuilderItem(selectedCourseBuilderItem.id, {
                                    assignedTargetIds: nextAssigned,
                                  });
                                }}
                                style={{
                                  borderRadius: 999,
                                  border: `1px solid ${isAssigned ? theme.accent : "rgba(255,255,255,0.08)"}`,
                                  background: isAssigned ? "rgba(200,163,106,0.22)" : "rgba(255,255,255,0.05)",
                                  color: "#f3efe6",
                                  fontWeight: 800,
                                  fontSize: 11,
                                  padding: "8px 10px",
                                  cursor: "pointer",
                                }}
                              >
                                {targetItem.label}
                              </button>
                            );
                          })
                        ) : (
                          <div style={{ color: "rgba(243,239,230,0.72)", fontSize: 12 }}>
                            Add targets or steel first, then assign them to this position.
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div style={{ color: "rgba(243,239,230,0.72)", lineHeight: 1.55 }}>
                  Click a prop in the scene to label it, resize it, rotate it, or duplicate it.
                </div>
              )}
              {selectedCourseBuilderItem?.type === "position" ? (
                <div
                  style={{
                    marginTop: 10,
                    color: "#8bf1f3",
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontWeight: 700,
                  }}
                >
                  Position assignment mode is active. Click targets or steel in the scene to toggle them on this position.
                </div>
              ) : null}
            </>
          ) : null}

          {utilityTab === "transfer" ? (
            <>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Transfer</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                <button type="button" onClick={copyCourseBuilderCode} style={overlayButtonStyle()}>
                  Copy Course Code
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCourseBuilderTransferCode(
                      JSON.stringify({
                        version: 2,
                        name: courseBuilderName,
                        notes: courseBuilderNotes,
                        stageTitle: courseBuilderStageTitle,
                        stageWidth: courseBuilderStageWidth,
                        stageDepth: courseBuilderStageDepth,
                        items: courseBuilderItems,
                      })
                    )
                  }
                  style={overlayButtonStyle()}
                >
                  Show Code
                </button>
              </div>
              <textarea
                value={courseBuilderTransferCode}
                onChange={(e) => setCourseBuilderTransferCode(e.target.value)}
                placeholder="Paste a desktop-built stage code here to load it on the phone app."
                style={{
                  ...fieldInputStyle,
                  width: "100%",
                  minHeight: 130,
                  resize: "vertical",
                  marginBottom: 8,
                }}
              />
              <button type="button" onClick={loadCourseBuilderCode} style={overlayButtonStyle(true)}>
                Load Course Code
              </button>
            </>
          ) : null}

          {utilityTab === "library" ? (
            <>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Saved Courses</div>
              <button
                type="button"
                onClick={saveCurrentCourseToLibrary}
                style={{ ...overlayButtonStyle(true), marginBottom: 8 }}
              >
                Save Current Course
              </button>
              <div style={{ display: "grid", gap: 8, maxHeight: 340, overflow: "auto" }}>
                {savedCourses.length ? (
                  savedCourses.map((course) => (
                    <div
                      key={course.id}
                      style={{
                        borderRadius: 14,
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.05)",
                        padding: 10,
                      }}
                    >
                      <div style={{ fontWeight: 800, marginBottom: 4 }}>{course.stageTitle || course.name}</div>
                      <div style={{ fontSize: 12, color: "rgba(243,239,230,0.72)", marginBottom: 8 }}>
                        {course.name} • {course.stageWidth}×{course.stageDepth} yd • {Array.isArray(course.items) ? course.items.length : 0} props
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => loadSavedCourse(course)} style={overlayButtonStyle()}>
                          Load
                        </button>
                        <button type="button" onClick={() => deleteSavedCourse(course.id)} style={overlayButtonStyle()}>
                          Delete
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ color: "rgba(243,239,230,0.72)", lineHeight: 1.55 }}>
                    Save a course to start building your local stage library.
                  </div>
                )}
              </div>
            </>
          ) : null}

          {utilityTab === "stage" ? (
            <>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>Stage Setup</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                <input
                  value={courseBuilderName}
                  onChange={(e) => setCourseBuilderName(e.target.value)}
                  placeholder="Course package"
                  style={fieldInputStyle}
                />
                <input
                  value={courseBuilderStageTitle}
                  onChange={(e) => setCourseBuilderStageTitle(e.target.value)}
                  placeholder="Stage title"
                  style={fieldInputStyle}
                />
                <input
                  type="number"
                  min="6"
                  max="80"
                  value={courseBuilderStageWidth}
                  onChange={(e) => setCourseBuilderStageWidth(Number(e.target.value) || 0)}
                  placeholder="Width"
                  style={fieldInputStyle}
                />
                <input
                  type="number"
                  min="6"
                  max="80"
                  value={courseBuilderStageDepth}
                  onChange={(e) => setCourseBuilderStageDepth(Number(e.target.value) || 0)}
                  placeholder="Depth"
                  style={fieldInputStyle}
                />
              </div>
              <textarea
                value={courseBuilderNotes}
                onChange={(e) => setCourseBuilderNotes(e.target.value)}
                placeholder="Stage briefing, movement notes, round count ideas, special props..."
                style={{
                  ...fieldInputStyle,
                  width: "100%",
                  minHeight: 100,
                  resize: "vertical",
                  marginBottom: 8,
                }}
              />
              <button type="button" onClick={clearCourseBuilderLayout} style={overlayButtonStyle()}>
                New Blank Stage
              </button>
            </>
          ) : null}
        </div>
      </div>

      {!isCompactBuilderLayout ? (
        <div
          style={{
            position: "absolute",
            left: 18,
            bottom: 18,
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            borderRadius: 18,
            background: "rgba(20,20,24,0.88)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 14px 36px rgba(0,0,0,0.28)",
            color: "#f3efe6",
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 13 }}>Path Preview</div>
          <div style={{ fontSize: 12, color: "rgba(243,239,230,0.74)" }}>
            Position markers now link in order so you can sketch movement flow.
          </div>
        </div>
      ) : null}

      {showBuilderHelp && !isCompactBuilderLayout ? (
        <div
          style={{
            position: "absolute",
            top: 72,
            right: 18,
            width: 284,
            padding: 14,
            borderRadius: 18,
            background: "rgba(20,20,24,0.92)",
            border: "1px solid rgba(255,255,255,0.08)",
            boxShadow: "0 18px 40px rgba(0,0,0,0.34)",
            color: "#f3efe6",
            zIndex: 7,
          }}
        >
          <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 8 }}>Builder Tips</div>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: "rgba(243,239,230,0.78)" }}>
            Pick a prop from the top tray, click the stage to place it, then drag it in the scene.
            Use the camera presets to switch views, and drop position markers to sketch movement with the dashed route.
          </div>
        </div>
      ) : null}

      {message ? (
        <div
          style={{
            position: "absolute",
            left: isCompactBuilderLayout ? 12 : 140,
            bottom: isCompactBuilderLayout ? 92 : 22,
            maxWidth: isCompactBuilderLayout ? "calc(100% - 24px)" : 420,
            padding: "10px 12px",
            borderRadius: 14,
            background: "rgba(20,20,24,0.88)",
            color: "#f3efe6",
            fontSize: 13,
            lineHeight: 1.45,
            zIndex: 5,
          }}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
