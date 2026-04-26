import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Browser } from "@capacitor/browser";
import { BleClient } from "@capacitor-community/bluetooth-le";
import { createPortal } from "react-dom";
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import headerImg from "./assets/jmt-header.png";
import {
  Timer,
  PenLine,
  TrendingUp,
  Trophy,
  Clock,
  BookOpen,
  Award,
  Zap,
  Plus,
  Users,
  Play,
  SkipForward,
  RotateCcw,
  CheckCircle2,
  ChevronUp,
  ChevronDown,
  Trash2,
} from "lucide-react";
import { collection, getDocs, orderBy, query } from "firebase/firestore";
import PullToRefresh from "react-simple-pull-to-refresh";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import {
  createManagedUserAccount,
  ensureUserProfileRecord,
  getFirebaseAuthInstance,
  getFirebaseFirestoreInstance,
  getFirebaseStorageInstance,
  getUserProfile,
  isFirebaseConfigured,
  listUserProfiles,
  registerWithEmailPassword,
  signInWithEmailPassword,
  signOutCurrentUser,
  subscribeToAuthChanges,
  updateUserProfileRecord,
} from "./firebase";
import CourseLibrary from "./components/CourseLibrary";

const API_BASE = "https://script.google.com/macros/s/AKfycbxXKU0hXi-xsLV1K5TvpwHy9738WbJfAC_lXFSO_b8D82TUAgUfZF0JZSuSROUTCkT7/exec";
const VIDEO_NOTE_PREFIX = "[VideoMeta]";
const NativeVideoRecorder = registerPlugin("VideoRecorderPlugin");
const NativeRunVideoPlayer = registerPlugin("RunVideoPlayerPlugin");
const COURSE_BUILDER_STORAGE_KEY = "jmt-course-builder-v1";
const COURSE_COLLECTION_NAME = "courses";
const MATCH_STORAGE_KEY = "jmt-active-match-v1";
const MATCH_HISTORY_STORAGE_KEY = "jmt-match-history-v1";
const QUALIFICATION_STORAGE_KEY = "jmt-active-qualification-v1";
const AUTH_PENDING_ROLE_KEY = "jmt-auth-pending-role";

function normalizeCloudCourse(docId, data = {}) {
  const createdAtValue = data.createdAt;
  const updatedAtValue = data.updatedAt;

  const createdAt =
    typeof createdAtValue?.toDate === "function"
      ? createdAtValue.toDate().toISOString()
      : String(createdAtValue || "");
  const updatedAt =
    typeof updatedAtValue?.toDate === "function"
      ? updatedAtValue.toDate().toISOString()
      : String(updatedAtValue || createdAt || "");

  return {
    id: String(docId || data.id || ""),
    title: String(data.title || "").trim(),
    folder: String(data.folder || ""),
    drillId: String(data.drillId || ""),
    sessionId: String(data.sessionId || ""),
    sessionType: String(data.sessionType || "").trim(),
    pdfFileName: String(data.pdfFileName || "").trim(),
    pdfFileSize: Number(data.pdfFileSize || 0),
    storagePath: String(data.storagePath || "").trim(),
    storageUrl: String(data.storageUrl || "").trim(),
    createdAt,
    updatedAt,
  };
}

function buildVideoViewerUrl(rawVideoUrl, fileName = "") {
  const normalizedRawUrl = String(rawVideoUrl || "").trim();

  if (!normalizedRawUrl) return "";

  const params = new URLSearchParams({
    view: "video",
    src: normalizedRawUrl,
  });

  const normalizedName = String(fileName || "").trim();

  if (normalizedName) {
    params.set("name", normalizedName);
  }

  return `${API_BASE}?${params.toString()}`;
}

function extractRawVideoUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim();

  if (!normalizedUrl) return "";

  try {
    const parsedUrl = new URL(normalizedUrl);
    const embeddedSource = String(parsedUrl.searchParams.get("src") || "").trim();
    return embeddedSource || normalizedUrl;
  } catch {
    return normalizedUrl;
  }
}

function unwrapNestedVideoUrl(sourceUrl, maxDepth = 4) {
  let currentUrl = String(sourceUrl || "").trim();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const nextUrl = extractRawVideoUrl(currentUrl);

    if (!nextUrl || nextUrl === currentUrl) {
      return currentUrl;
    }

    currentUrl = nextUrl;
  }

  return currentUrl;
}

function normalizePlayableVideoUrl(sourceUrl) {
  const normalizedUrl = unwrapNestedVideoUrl(sourceUrl);

  if (!normalizedUrl) return "";

  if (/^https?:\/\//i.test(normalizedUrl) || /^file:\/\//i.test(normalizedUrl)) {
    return normalizedUrl;
  }

  try {
    return decodeURIComponent(normalizedUrl);
  } catch {
    return normalizedUrl;
  }
}

function normalizePersonName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findExactShooterMatchByName(shooterList, displayName) {
  const normalizedDisplayName = normalizePersonName(displayName);
  if (!normalizedDisplayName) return null;

  const matches = (Array.isArray(shooterList) ? shooterList : []).filter((shooter) => {
    return normalizePersonName(shooter?.Name) === normalizedDisplayName;
  });

  return matches.length === 1 ? matches[0] : null;
}

function buildSparklinePath(points, width, height, padding = 12) {
  if (!Array.isArray(points) || points.length === 0) return "";

  const values = points.map((point) => Number(point?.value || 0));
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = maxValue - minValue || 1;
  const innerWidth = Math.max(width - padding * 2, 1);
  const innerHeight = Math.max(height - padding * 2, 1);

  return points
    .map((point, index) => {
      const x =
        padding +
        (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
      const normalizedValue = (Number(point?.value || 0) - minValue) / valueRange;
      const y = padding + innerHeight - normalizedValue * innerHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildSparklineArea(points, width, height, padding = 12) {
  if (!Array.isArray(points) || points.length === 0) return "";

  const linePath = buildSparklinePath(points, width, height, padding);
  if (!linePath) return "";

  const innerWidth = Math.max(width - padding * 2, 1);
  const baseY = height - padding;
  const startX = padding;
  const endX = points.length === 1 ? padding + innerWidth / 2 : padding + innerWidth;

  return `${linePath} L ${endX.toFixed(2)} ${baseY.toFixed(2)} L ${startX.toFixed(2)} ${baseY.toFixed(2)} Z`;
}

function StudentSparklineCard({
  title,
  subtitle,
  points,
  accent,
  fill,
  emptyMessage,
  valueSuffix = "s",
  onOpen,
  fullscreen = false,
}) {
  const width = fullscreen ? 820 : 360;
  const height = fullscreen ? 280 : 150;
  const latestPoint = points[points.length - 1] || null;
  const bestValue = points.length ? Math.min(...points.map((point) => Number(point.value || 0))) : null;
  const previousPoint = points.length > 1 ? points[points.length - 2] : null;
  const values = points
    .map((point) => Number(point.value || 0))
    .filter((value) => !Number.isNaN(value));
  const minValue = values.length ? Math.min(...values) : null;
  const maxValue = values.length ? Math.max(...values) : null;
  const midValue =
    minValue !== null && maxValue !== null ? minValue + (maxValue - minValue) / 2 : null;
  const delta =
    latestPoint && previousPoint
      ? Number(latestPoint.value || 0) - Number(previousPoint.value || 0)
      : null;
  const trendLabel =
    delta === null
      ? "No change yet"
      : delta < 0
      ? `${formatSplitForDisplay(Math.abs(delta).toFixed(2))}${valueSuffix} faster`
      : delta > 0
      ? `${formatSplitForDisplay(Math.abs(delta).toFixed(2))}${valueSuffix} slower`
      : "Even with last run";
  const gradientId = `student-chart-fill-${title.replace(/\s+/g, "-").toLowerCase()}`;

  return (
    <div
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      style={{
        position: "relative",
        overflow: "hidden",
        border: "1px solid rgba(200,163,106,0.22)",
        borderRadius: 22,
        padding: 18,
        background:
          "linear-gradient(180deg, rgba(23,23,27,0.98), rgba(10,10,12,0.98))",
        boxShadow:
          "0 18px 40px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.04)",
        display: "grid",
        gap: 12,
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "-40% auto auto 55%",
          width: 180,
          height: 180,
          background: `radial-gradient(circle, ${fill.replace(/0\.\d+\)/, "0.18)")}, transparent 68%)`,
          pointerEvents: "none",
        }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "#c8a36a", fontSize: 11, fontWeight: 900, letterSpacing: 1.3, textTransform: "uppercase" }}>
            {title}
          </div>
          <div style={{ color: "rgba(255,255,255,0.68)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>
            {subtitle}
          </div>
        </div>
        {latestPoint ? (
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "#f4efe6", fontSize: 26, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>
              {formatSplitForDisplay(Number(latestPoint.value || 0).toFixed(2))}
              {valueSuffix}
            </div>
            {bestValue ? (
              <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 12, fontWeight: 700 }}>
                Best {formatSplitForDisplay(Number(bestValue).toFixed(2))}
                {valueSuffix}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {onOpen ? (
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(6,6,8,0.55)",
            color: "#f4efe6",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Expand
        </div>
      ) : null}

      {points.length > 1 ? (
        <div
          style={{
            borderRadius: 18,
            padding: "10px 10px 6px",
            background: "linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "56px minmax(0, 1fr)",
              gap: 10,
              alignItems: "stretch",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                padding: "12px 0",
                color: "rgba(255,255,255,0.46)",
                fontSize: fullscreen ? 12 : 10,
                fontWeight: 800,
                lineHeight: 1.1,
                textAlign: "right",
              }}
            >
              <span>{maxValue !== null ? `${formatSplitForDisplay(maxValue.toFixed(2))}${valueSuffix}` : ""}</span>
              <span>{midValue !== null ? `${formatSplitForDisplay(midValue.toFixed(2))}${valueSuffix}` : ""}</span>
              <span>{minValue !== null ? `${formatSplitForDisplay(minValue.toFixed(2))}${valueSuffix}` : ""}</span>
            </div>

            <div>
              <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: fullscreen ? 280 : 150, display: "block" }} preserveAspectRatio="none">
                <defs>
                  <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor={fill} stopOpacity="0.46" />
                    <stop offset="100%" stopColor={fill} stopOpacity="0.05" />
                  </linearGradient>
                </defs>
                {[0.2, 0.5, 0.8].map((fraction) => (
                  <line
                    key={`${title}-${fraction}`}
                    x1="12"
                    x2={width - 12}
                    y1={fraction * (height - 24) + 12}
                    y2={fraction * (height - 24) + 12}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth="1"
                  />
                ))}
                <path
                  d={buildSparklineArea(points, width, height, 12)}
                  fill={`url(#${gradientId})`}
                  stroke="none"
                />
                <path
                  d={buildSparklinePath(points, width, height, 12)}
                  fill="none"
                  stroke={accent}
                  strokeWidth="3.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {points.map((point, index) => {
                  const pointMinValue = Math.min(...values);
                  const pointMaxValue = Math.max(...values);
                  const valueRange = pointMaxValue - pointMinValue || 1;
                  const innerWidth = width - 24;
                  const innerHeight = height - 24;
                  const x = 12 + (index / (points.length - 1)) * innerWidth;
                  const normalizedValue = (Number(point.value || 0) - pointMinValue) / valueRange;
                  const y = 12 + innerHeight - normalizedValue * innerHeight;

                  return (
                    <g key={`${title}-point-${point.label}-${index}`}>
                      <circle
                        cx={x}
                        cy={y}
                        r={index === points.length - 1 ? 5.5 : 3.5}
                        fill={index === points.length - 1 ? "#f4efe6" : accent}
                        stroke={accent}
                        strokeWidth="2"
                      />
                      {index === points.length - 1 ? (
                        <>
                          <rect
                            x={Math.max(x - 31, 12)}
                            y={Math.max(y - 31, 6)}
                            rx="8"
                            ry="8"
                            width="62"
                            height="20"
                            fill="rgba(4,4,6,0.82)"
                            stroke="rgba(255,255,255,0.12)"
                          />
                          <text
                            x={x}
                            y={Math.max(y - 17, 20)}
                            textAnchor="middle"
                            fill="#f4efe6"
                            fontSize={fullscreen ? "12" : "10"}
                            fontWeight="900"
                          >
                            {formatSplitForDisplay(Number(point.value || 0).toFixed(2))}
                            {valueSuffix}
                          </text>
                        </>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 6, color: "rgba(255,255,255,0.46)", fontSize: fullscreen ? 12 : 11, fontWeight: 800 }}>
                <span>{points[0]?.label || "Earlier"}</span>
                <span>{points[points.length - 1]?.label || "Latest"}</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            minHeight: 150,
            borderRadius: 16,
            border: "1px dashed rgba(255,255,255,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.56)",
            fontWeight: 700,
            textAlign: "center",
            padding: 16,
          }}
        >
          {emptyMessage}
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          paddingTop: 2,
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            borderRadius: 999,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
            color: "rgba(255,255,255,0.74)",
            fontSize: 12,
            fontWeight: 800,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: accent,
              boxShadow: `0 0 12px ${accent}`,
            }}
          />
          {trendLabel}
        </div>
        <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 11, fontWeight: 800 }}>
          Based on {points.length} runs
        </div>
      </div>
    </div>
  );
}

function StudentBarBreakdownCard({ title, subtitle, items, emptyMessage, onOpen, fullscreen = false }) {
  const maxValue = items.length ? Math.max(...items.map((item) => Number(item.value || 0))) : 0;

  return (
    <div
      onClick={onOpen}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      style={{
        position: "relative",
        overflow: "hidden",
        border: "1px solid rgba(200,163,106,0.22)",
        borderRadius: 22,
        padding: 18,
        background:
          "linear-gradient(180deg, rgba(23,23,27,0.98), rgba(10,10,12,0.98))",
        boxShadow:
          "0 18px 40px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.04)",
        display: "grid",
        gap: 14,
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: "-42% auto auto 62%",
          width: 180,
          height: 180,
          background: "radial-gradient(circle, rgba(200,163,106,0.14), transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div>
        <div style={{ color: "#c8a36a", fontSize: 11, fontWeight: 900, letterSpacing: 1.3, textTransform: "uppercase" }}>
          {title}
        </div>
        <div style={{ color: "rgba(255,255,255,0.68)", fontSize: 13, fontWeight: 700, marginTop: 4 }}>
          {subtitle}
        </div>
      </div>
      {onOpen ? (
        <div
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(6,6,8,0.55)",
            color: "#f4efe6",
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textTransform: "uppercase",
          }}
        >
          Expand
        </div>
      ) : null}

      {items.length ? (
        <div style={{ display: "grid", gap: fullscreen ? 12 : 10 }}>
          {items.map((item) => {
            const widthPercent = maxValue ? Math.max((Number(item.value || 0) / maxValue) * 100, 10) : 0;

            return (
              <div
                key={`${item.label}-${item.meta || ""}`}
                style={{
                  display: "grid",
                  gap: 6,
                  padding: fullscreen ? 14 : 12,
                  borderRadius: 16,
                  background: "rgba(255,255,255,0.025)",
                  border: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
                  <div style={{ color: "#f4efe6", fontSize: fullscreen ? 17 : 15, fontWeight: 800 }}>
                    {item.label}
                  </div>
                  <div style={{ color: "rgba(255,255,255,0.68)", fontSize: fullscreen ? 13 : 12, fontWeight: 800 }}>
                    {item.meta}
                  </div>
                </div>
                <div style={{ height: 12, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${widthPercent}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: "linear-gradient(90deg, rgba(200,163,106,0.92), rgba(236,211,154,0.98))",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div
          style={{
            minHeight: 150,
            borderRadius: 16,
            border: "1px dashed rgba(255,255,255,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "rgba(255,255,255,0.56)",
            fontWeight: 700,
            textAlign: "center",
            padding: 16,
          }}
        >
          {emptyMessage}
        </div>
      )}
    </div>
  );
}

function isRemoteHttpUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim();
  if (!normalizedUrl) return false;

  return /^https?:\/\//i.test(normalizedUrl);
}

function isEmbeddedVideoViewerUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim();
  if (!normalizedUrl) return false;

  try {
    const candidate = new URL(normalizedUrl);
    const apiUrl = new URL(API_BASE);
    return (
      candidate.origin === apiUrl.origin &&
      candidate.pathname === apiUrl.pathname &&
      String(candidate.searchParams.get("view") || "").trim().toLowerCase() === "video"
    );
  } catch {
    return false;
  }
}

function looksLikeDirectVideoFileUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim().toLowerCase();
  if (!normalizedUrl) return false;

  return [".mp4", ".mov", ".m4v", ".webm", ".ogg"].some((extension) =>
    normalizedUrl.includes(extension)
  );
}

function isProbablyDirectVideoUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim();
  if (!normalizedUrl) return false;

  if (
    normalizedUrl.startsWith("blob:") ||
    normalizedUrl.startsWith("capacitor://") ||
    normalizedUrl.startsWith("file://") ||
    normalizedUrl.startsWith("http://localhost/_capacitor_file_")
  ) {
    return true;
  }

  if (looksLikeDirectVideoFileUrl(normalizedUrl)) {
    return true;
  }

  try {
    const parsedUrl = new URL(normalizedUrl);
    const host = String(parsedUrl.hostname || "").toLowerCase();

    return (
      host.includes("firebasestorage.googleapis.com") ||
      host.includes("storage.googleapis.com") ||
      host.includes("googleusercontent.com")
    );
  } catch {
    return false;
  }
}

function extractGoogleDriveFileId(sourceUrl) {
  const normalizedUrl = String(sourceUrl || "").trim();
  if (!normalizedUrl) return "";

  try {
    const parsedUrl = new URL(normalizedUrl);
    const host = String(parsedUrl.hostname || "").toLowerCase();
    const pathname = String(parsedUrl.pathname || "");

    const queryId = String(parsedUrl.searchParams.get("id") || "").trim();
    if (queryId) return queryId;

    if (host.includes("drive.google.com") || host.includes("docs.google.com")) {
      const filePathMatch = pathname.match(/\/file\/d\/([^/]+)/i);
      if (filePathMatch?.[1]) return String(filePathMatch[1]).trim();

      const previewPathMatch = pathname.match(/\/uc$/i);
      if (previewPathMatch && queryId) return queryId;
    }

    return "";
  } catch {
    return "";
  }
}

function buildGoogleDrivePreviewUrl(fileId) {
  const normalizedId = String(fileId || "").trim();
  if (!normalizedId) return "";
  return `https://drive.google.com/file/d/${normalizedId}/preview`;
}

function buildGoogleDriveDownloadUrl(fileId) {
  const normalizedId = String(fileId || "").trim();
  if (!normalizedId) return "";
  return `https://drive.google.com/uc?export=download&id=${normalizedId}`;
}

async function pushNativeRecordingStats({ shots = 0, totalTime = 0 } = {}) {
  if (!Capacitor.isNativePlatform()) return;

  try {
    await NativeVideoRecorder.updateRecordingStats({
      shots: Number(shots || 0),
      totalTime: Number(totalTime || 0),
    });
  } catch (error) {
    console.error("Update native recording stats failed:", error);
  }
}

async function apiGet(action) {
  try {
    const res = await fetch(`${API_BASE}?action=${action}`);
    if (!res.ok) throw new Error("Network response failed");
    return await res.json();
  } catch (err) {
    console.error("apiGet error:", err);
    return null;
  }
}

async function apiSaveRun(run) {
  const destinationSheet = String(run?.destinationSheet || "Runs").trim() || "Runs";
  const payload = {
    run,
    destinationSheet,
  };

  try {
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error("Save failed");

    const text = await res.text();

    try {
      return JSON.parse(text);
    } catch {
      return { success: false, raw: text };
    }
  } catch (err) {
    console.error("apiSaveRun error:", err);
    return null;
  }
}

function isQualificationDrill(drill) {
  if (!drill || typeof drill !== "object") return false;

  const modeValues = [
    drill.Mode,
    drill.mode,
    drill.DrillMode,
    drill.Type,
    drill.type,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (modeValues.some((value) => value === "qualification" || value === "qual")) {
    return true;
  }

  return Boolean(String(drill.QualificationConfig || "").trim());
}

function parseQualificationConfig(drill) {
  if (!isQualificationDrill(drill)) return null;

  const parsedFromJson = (() => {
    const rawConfig = String(drill?.QualificationConfig || "").trim();
    if (!rawConfig) return null;

    try {
      const parsed = JSON.parse(rawConfig);
      if (!parsed || typeof parsed !== "object") return null;

      const distances = Array.isArray(parsed.distances)
        ? parsed.distances
            .map((distance, index) => ({
              label: String(distance?.label || distance?.name || `Distance ${index + 1}`).trim(),
              roundCount: Number(distance?.roundCount || distance?.rounds || 0) || 0,
              maxScore: Number(distance?.maxScore || distance?.points || 0) || 0,
              passPercent: Number(distance?.passPercent || parsed?.passPercent || 80) || 80,
            }))
            .filter((distance) => distance.label)
        : [];

      return {
        type: String(parsed.type || "marksmanship").trim().toLowerCase() || "marksmanship",
        passScore: Number(parsed.passScore || 0) || 0,
        distances,
      };
    } catch (error) {
      console.warn("Qualification config parse warning:", error);
      return null;
    }
  })();

  if (parsedFromJson?.distances?.length) {
    return parsedFromJson;
  }

  const fallbackDistances = [];
  for (let index = 1; index <= 10; index += 1) {
    const stageValue = String(
      drill?.[`Stage${index}`] ||
        drill?.[`Distance${index}`] ||
        drill?.[`String${index}`] ||
        ""
    ).trim();

    if (!stageValue) continue;

    fallbackDistances.push({
      label: stageValue,
      roundCount: Number(drill?.[`Stage${index}Rounds`] || drill?.[`Distance${index}Rounds`] || 0) || 0,
      maxScore: Number(drill?.[`Stage${index}MaxScore`] || drill?.[`Distance${index}MaxScore`] || 0) || 0,
      passPercent:
        Number(
          drill?.[`Stage${index}PassPercent`] ||
            drill?.[`Distance${index}PassPercent`] ||
            drill?.PassPercent ||
            80
        ) || 80,
    });
  }

  return {
    type: "marksmanship",
    passScore: Number(drill?.PassScore || drill?.MinScore || 0) || 0,
    distances: fallbackDistances.length
      ? fallbackDistances
      : [
          { label: "Distance 1", roundCount: 0, maxScore: 0 },
          { label: "Distance 2", roundCount: 0, maxScore: 0 },
          { label: "Distance 3", roundCount: 0, maxScore: 0 },
          { label: "Distance 4", roundCount: 0, maxScore: 0 },
          { label: "Distance 5", roundCount: 0, maxScore: 0 },
        ],
  };
}

function getQualificationStageTarget(distance) {
  const maxScore = Number(distance?.maxScore || 0) || 0;
  const roundCount = Number(distance?.roundCount || 0) || 0;
  return maxScore > 0 ? maxScore : roundCount;
}

function getQualificationStagePassPercent(distance) {
  return Number(distance?.passPercent || 80) || 80;
}

function findItemById(list, id, idKey) {
  return list.find((item) => String(item[idKey]) === String(id));
}

function parseTimestampValue(timestamp) {
  if (!timestamp) return null;
  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  const raw = String(timestamp).trim();
  if (!raw) return null;

  const directDate = new Date(raw);
  if (!Number.isNaN(directDate.getTime())) {
    return directDate;
  }

  const normalizedIsoLike = raw.replace(
    /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2}:\d{2})(?:\s*(AM|PM))?$/i,
    (_, datePart, timePart, meridiem) => {
      if (!meridiem) return `${datePart}T${timePart}`;
      return `${datePart} ${timePart} ${meridiem.toUpperCase()}`;
    }
  );

  if (normalizedIsoLike !== raw) {
    const retryDate = new Date(normalizedIsoLike);
    if (!Number.isNaN(retryDate.getTime())) {
      return retryDate;
    }
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
  );

  if (!match) {
    const slashMatch = raw.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
    );

    if (!slashMatch) return null;

    const [, month, day, year, hoursRaw = "0", minutesRaw = "0", secondsRaw = "0", meridiem = ""] =
      slashMatch;

    let hours = Number(hoursRaw);
    const minutes = Number(minutesRaw);
    const seconds = Number(secondsRaw);

    if (meridiem) {
      const upper = meridiem.toUpperCase();
      if (upper === "PM" && hours < 12) hours += 12;
      if (upper === "AM" && hours === 12) hours = 0;
    }

    const parsedSlashDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      hours,
      minutes,
      seconds
    );

    return Number.isNaN(parsedSlashDate.getTime()) ? null : parsedSlashDate;
  }

  const [, year, month, day, hoursRaw = "0", minutesRaw = "0", secondsRaw = "0", meridiem = ""] =
    match;

  let hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  const seconds = Number(secondsRaw);

  if (meridiem) {
    const upper = meridiem.toUpperCase();
    if (upper === "PM" && hours < 12) hours += 12;
    if (upper === "AM" && hours === 12) hours = 0;
  }

  const parsedDate = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    hours,
    minutes,
    seconds
  );

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function formatDate(timestamp) {
  if (!timestamp) return "";
  try {
    const parsedDate = parseTimestampValue(timestamp);
    return parsedDate ? parsedDate.toLocaleString() : String(timestamp);
  } catch {
    return String(timestamp);
  }
}

function formatDateOnly(timestamp) {
  if (!timestamp) return "";
  try {
    const parsedDate = parseTimestampValue(timestamp);
    return parsedDate ? parsedDate.toLocaleDateString() : String(timestamp);
  } catch {
    return String(timestamp);
  }
}

function parseNumber(value) {
  if (value === "" || value === null || value === undefined) return "";
  const num = Number(value);
  return Number.isNaN(num) ? "" : num;
}

function formatErrorMessage(error) {
  const code = String(error?.code || "").trim().toLowerCase();
  const message = String(error?.message || "").trim();

  if (code === "auth/email-already-in-use") {
    return "That email is already registered. Please sign in instead.";
  }

  if (code === "auth/invalid-email") {
    return "That email address does not look valid.";
  }

  if (code === "auth/missing-password") {
    return "Please enter a password.";
  }

  if (code === "auth/weak-password") {
    return "That password is too weak. Please use at least 6 characters.";
  }

  if (
    code === "auth/invalid-credential" ||
    code === "auth/wrong-password" ||
    code === "auth/user-not-found"
  ) {
    return "Email or password is incorrect.";
  }

  if (code === "auth/too-many-requests") {
    return "Too many attempts right now. Please wait a minute and try again.";
  }

  if (code === "auth/network-request-failed") {
    return "Network request failed. Please check your connection and try again.";
  }

  if (message) {
    return message;
  }

  return "We could not complete that sign-in request. Please try again.";
}

function readStoredJson(key, fallbackValue) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function withClientTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(message));
      }, ms);
    }),
  ]);
}

function formatSplitForExport(value) {
  const normalizedValue = String(value ?? "").trim().replace(/^'+/, "");
  const num = Number(normalizedValue);

  if (Number.isNaN(num)) return "";

  const formatted = num.toFixed(2);
  return num > 0 && num < 1 ? formatted.replace(/^0/, "") : formatted;
}

function formatSplitForDisplay(value) {
  const formatted = formatSplitForExport(value);
  return formatted === "" ? "" : formatted;
}

function formatRunDateKey(timestamp) {
  if (!timestamp) return "";

  const date = parseTimestampValue(timestamp);
  if (!date || Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatRunDateLabel(dateKey) {
  if (!dateKey) return "";

  const date = new Date(`${dateKey}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;

  return date.toLocaleDateString([], {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function isUspsaSessionName(value) {
  return String(value || "").trim().toLowerCase().includes("uspsa");
}

function isTrainingSessionName(value) {
  return String(value || "").trim().toLowerCase().includes("training");
}

function isLevelEvaluationSessionName(value) {
  return String(value || "").trim().toLowerCase().includes("level evaluation");
}

function getStageScoringSessionType(session, fallbackValue = "") {
  const values = [
    session?.SessionName,
    session?.Name,
    session?.SessionID,
    fallbackValue,
  ];

  if (values.some((value) => isUspsaSessionName(value))) return "USPSA";
  if (values.some((value) => isLevelEvaluationSessionName(value))) return "LEVEL_EVALUATION";

  return "";
}

function formatSplitCellValue(value) {
  const formatted = formatSplitForExport(value);
  return formatted ? `'${formatted}` : "";
}

function parseSplitNumber(value) {
  const normalizedValue = String(value ?? "").trim().replace(/^'+/, "");
  const num = Number(normalizedValue);
  return Number.isNaN(num) ? NaN : num;
}

function calculateShooterTotalRounds(runList, shooterId, additionalShotCount = 0) {
  const existingRounds = runList
    .filter((run) => String(run.ShooterID) === String(shooterId))
    .reduce((sum, run) => {
      const shotValue = Number(run.ShotCount || run.shotCount || 0);
      return sum + (Number.isNaN(shotValue) ? 0 : shotValue);
    }, 0);

  const extraRounds = Number(additionalShotCount || 0);
  return existingRounds + (Number.isNaN(extraRounds) ? 0 : extraRounds);
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);

  if (!size) return "";
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds) {
  const totalSeconds = Number(seconds || 0);

  if (!totalSeconds) return "";

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toFixed(1).padStart(4, "0")}`;
}

function parseNotesContent(value) {
  const raw = String(value || "");
  const prefixIndex = raw.indexOf(VIDEO_NOTE_PREFIX);

  if (prefixIndex === -1) {
    return {
      displayNotes: raw.trim(),
      videoMeta: null,
    };
  }

  const displayNotes = raw.slice(0, prefixIndex).trim();
  const metaString = raw.slice(prefixIndex + VIDEO_NOTE_PREFIX.length).trim();

  try {
    return {
      displayNotes,
      videoMeta: JSON.parse(metaString),
    };
  } catch {
    return {
      displayNotes: raw.trim(),
      videoMeta: null,
    };
  }
}

function buildNotesWithVideo(notesValue, videoMeta) {
  const trimmedNotes = String(notesValue || "").trim();

  if (!videoMeta) return trimmedNotes;

  const serializedMeta = JSON.stringify(videoMeta);
  return trimmedNotes
    ? `${trimmedNotes}\n${VIDEO_NOTE_PREFIX} ${serializedMeta}`
    : `${VIDEO_NOTE_PREFIX} ${serializedMeta}`;
}

async function uploadVideoAttachment(file, metadata = {}) {
  const storage = getFirebaseStorageInstance();

  if (!storage || !file) {
    return { uploaded: false, url: "", rawUrl: "", mode: "local-only" };
  }

  const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const storageRef = ref(
    storage,
    [
      "run-videos",
      metadata.sessionId || "unknown-session",
      metadata.shooterId || "unknown-shooter",
      safeName,
    ].join("/")
  );

  await uploadBytes(storageRef, file, {
    contentType: file.type || "video/quicktime",
    customMetadata: {
      shooterId: String(metadata.shooterId || ""),
      drillId: String(metadata.drillId || ""),
      sessionId: String(metadata.sessionId || ""),
      source: String(metadata.source || ""),
    },
  });

  const rawUrl = await getDownloadURL(storageRef);
  const viewerUrl = buildVideoViewerUrl(rawUrl, file.name);

  return {
    uploaded: true,
    url: viewerUrl || rawUrl,
    rawUrl,
    mode: "cloud",
  };
}

function releasePreviewUrl(url) {
  if (url && url.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function base64ToUint8Array(base64Value) {
  const normalized = String(base64Value || "").trim();

  if (!normalized) {
    return new Uint8Array();
  }

  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);

  for (let i = 0; i < binaryString.length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}

async function buildUploadFile({ file, filePath, fileName }) {
  if (file) return file;
  if (!filePath) return null;

  if (Capacitor.isNativePlatform()) {
    try {
      const nativeResult = await NativeVideoRecorder.readVideoFile({ filePath });
      const fileBytes = base64ToUint8Array(nativeResult?.base64Data || "");
      const inferredName = fileName || nativeResult?.fileName || filePath.split("/").pop() || `run-video-${Date.now()}.mov`;

      return new File([fileBytes], inferredName, {
        type: nativeResult?.mimeType || "video/quicktime",
      });
    } catch (error) {
      console.error("Native video file read failed, falling back to fetch path:", error);
    }
  }

  const fetchablePath = Capacitor.convertFileSrc(filePath);
  const response = await fetch(fetchablePath);

  if (!response.ok) {
    throw new Error("Unable to read recorded video for upload");
  }

  const blob = await response.blob();
  const inferredName = fileName || filePath.split("/").pop() || `run-video-${Date.now()}.mov`;

  return new File([blob], inferredName, {
    type: blob.type || "video/quicktime",
  });
}

function getRunVideoMeta(run) {
  const { displayNotes, videoMeta } = parseNotesContent(run.Notes);
  const directVideoUrl = String(run.VideoURL || run.videoUrl || "").trim();
  const directVideoRawUrl = String(run.VideoRawURL || run.videoRawUrl || "").trim();
  const directVideoStatus = String(run.VideoStatus || run.videoStatus || "").trim();
  const directVideoUploadedAt = String(run.VideoUploadedAt || run.videoUploadedAt || "").trim();
  const directVideoFileName = String(run.VideoFileName || run.videoFileName || "").trim();

  if (directVideoUrl || directVideoRawUrl || directVideoStatus || directVideoUploadedAt || directVideoFileName) {
    const resolvedRawUrl =
      directVideoRawUrl ||
      videoMeta?.rawUrl ||
      extractRawVideoUrl(directVideoUrl);

    return {
      displayNotes,
      videoMeta: {
        ...(videoMeta || {}),
        name: directVideoFileName || videoMeta?.name || "",
        url: directVideoUrl || videoMeta?.url || "",
        rawUrl: resolvedRawUrl,
        storage: directVideoUrl ? "cloud" : videoMeta?.storage || "",
        uploadedAt: directVideoUploadedAt || videoMeta?.uploadedAt || "",
        status: directVideoStatus || videoMeta?.status || "",
        localFilePath: videoMeta?.localFilePath || "",
      },
    };
  }

  return { displayNotes, videoMeta };
}

function getRunTimestamp(run) {
  return run?.Timestamp || run?.timestamp || "";
}

function getPlayableVideoUrl(videoMeta) {
  if (!videoMeta) return "";

  const localFilePath = String(videoMeta.localFilePath || "").trim();
  const rawUrl = normalizePlayableVideoUrl(videoMeta.rawUrl || videoMeta.url || "");
  const viewerOrDirectUrl = normalizePlayableVideoUrl(videoMeta.url || "");
  const googleDriveFileId =
    extractGoogleDriveFileId(rawUrl) || extractGoogleDriveFileId(viewerOrDirectUrl);

  if (localFilePath && Capacitor.isNativePlatform()) {
    return Capacitor.convertFileSrc(localFilePath);
  }

  if (isProbablyDirectVideoUrl(rawUrl)) {
    return rawUrl;
  }

  if (isProbablyDirectVideoUrl(viewerOrDirectUrl)) {
    return viewerOrDirectUrl;
  }

  if (googleDriveFileId) {
    return buildGoogleDriveDownloadUrl(googleDriveFileId);
  }

  return rawUrl || viewerOrDirectUrl;
}

function normalizeNativeFilePath(filePath) {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return "";

  if (normalizedPath.startsWith("file://")) {
    return normalizedPath;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${normalizedPath}`;
  }

  return "";
}

function getNativePlayableVideoUrl(videoMeta) {
  if (!videoMeta) return "";

  const storage = String(videoMeta.storage || "").trim().toLowerCase();
  const hasRemoteSource = Boolean(
    String(videoMeta.rawUrl || "").trim() || String(videoMeta.url || "").trim()
  );
  const normalizedLocalPath = normalizeNativeFilePath(videoMeta.localFilePath || "");

  if ((storage === "cloud" || hasRemoteSource) && getPlayableVideoUrl(videoMeta)) {
    return getPlayableVideoUrl(videoMeta);
  }

  if (normalizedLocalPath) {
    return normalizedLocalPath;
  }

  return getPlayableVideoUrl(videoMeta);
}

function describeError(error) {
  if (!error) return "Unknown error";

  const parts = [
    error.code,
    error.message,
    error.name,
  ].filter(Boolean);

  if (parts.length) {
    return parts.join(" | ");
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export default function App() {
  const [shooters, setShooters] = useState([]);
  const [drills, setDrills] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [runs, setRuns] = useState([]);
  const shootersRef = useRef([]);
  const drillsRef = useRef([]);
  const sessionsRef = useRef([]);
  const runsRef = useRef([]);

  const [selectorOpen, setSelectorOpen] = useState(null);
// "shooter" | "drill" | "session" | null

  const [selectedShooter, setSelectedShooter] = useState("");
  const [selectedDrill, setSelectedDrill] = useState("");
  const [selectedSession, setSelectedSession] = useState("");

  const [totalTime, setTotalTime] = useState("");
  const [shotCount, setShotCount] = useState("");
  const [firstShot, setFirstShot] = useState("");
  const [avgSplit, setAvgSplit] = useState("");
  const [bestSplit, setBestSplit] = useState("");
  const [worstSplit, setWorstSplit] = useState("");
  const [splitsRaw, setSplitsRaw] = useState("");

  const [score, setScore] = useState("");
  const [passFail, setPassFail] = useState("");
  const [notes, setNotes] = useState("");
  const [qualificationLevel, setQualificationLevel] = useState("");
  const [videoFile, setVideoFile] = useState(null);
  const [videoFilePath, setVideoFilePath] = useState("");
  const [videoFileName, setVideoFileName] = useState("");
  const [videoPreviewUrl, setVideoPreviewUrl] = useState("");
  const [videoDuration, setVideoDuration] = useState("");
  const [videoStatus, setVideoStatus] = useState("");
  const [videoUploadedUrl, setVideoUploadedUrl] = useState("");
  const [nativeVideoModeOpen, setNativeVideoModeOpen] = useState(false);
  const [activeRunVideo, setActiveRunVideo] = useState(null);
  const [selectedRecentRun, setSelectedRecentRun] = useState(null);
  const [selectedStudentChart, setSelectedStudentChart] = useState(null);

  const [filterShooter, setFilterShooter] = useState("all");
  const [filterDrill, setFilterDrill] = useState("all");
  const [filterSession, setFilterSession] = useState("all");
  const [filterPassFail, setFilterPassFail] = useState("all");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [authReady, setAuthReady] = useState(!isFirebaseConfigured());
  const [authUser, setAuthUser] = useState(null);
  const [authProfile, setAuthProfile] = useState(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [authError, setAuthError] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [studentAccounts, setStudentAccounts] = useState([]);
  const [studentAccountsLoading, setStudentAccountsLoading] = useState(false);
  const [studentAccountMessage, setStudentAccountMessage] = useState("");
  const [studentAccountSavingUid, setStudentAccountSavingUid] = useState("");
  const [adminCreateAccountOpen, setAdminCreateAccountOpen] = useState(false);
  const [adminCreateAccountName, setAdminCreateAccountName] = useState("");
  const [adminCreateAccountEmail, setAdminCreateAccountEmail] = useState("");
  const [adminCreateAccountPassword, setAdminCreateAccountPassword] = useState("");
  const [adminCreateAccountRole, setAdminCreateAccountRole] = useState("student");
  const [adminCreateAccountShooterId, setAdminCreateAccountShooterId] = useState("");
  const [adminCreateAccountSaving, setAdminCreateAccountSaving] = useState(false);
  const [studentProfileSyncing, setStudentProfileSyncing] = useState(false);
  const [studentProfileMessage, setStudentProfileMessage] = useState("");
  const [studentFilterDrill, setStudentFilterDrill] = useState("all");
  const [studentFilterSession, setStudentFilterSession] = useState("all");
  const [studentFilterDate, setStudentFilterDate] = useState("all");

  const [timerConnected, setTimerConnected] = useState(false);
const [timerDeviceName, setTimerDeviceName] = useState("");
const [liveShotTimes, setLiveShotTimes] = useState([]);
const [lastTimerRun, setLastTimerRun] = useState(null);

const timerDeviceRef = useRef(null);
const timerServerRef = useRef(null);
const eventCharRef = useRef(null);

const selectedShooterRef = useRef("");
const selectedDrillRef = useRef("");
const selectedSessionRef = useRef("");

const nativeDeviceIdRef = useRef("");
const nativeNotifyActiveRef = useRef(false);

const nativeScanInProgressRef = useRef(false);

const lastNativeDeviceIdRef = useRef("");
const lastNativeDeviceNameRef = useRef("");

const nativeDisconnectingRef = useRef(false);
const nativeManualConnectInProgressRef = useRef(false);
const reconnectAttemptTimeoutRef = useRef(null);
const discardCurrentTimerRunRef = useRef(false);

const isSavingRef = useRef(false);
const videoInputRef = useRef(null);
const lastShotSnapshotRef = useRef([]);
const videoCaptureSessionRef = useRef({
  active: false,
  awaitingStop: false,
  pendingFinalize: false,
  discardPending: false,
  recordedMeta: null,
});
const nativeVideoListenerHandlesRef = useRef([]);
const runVideoTouchStartYRef = useRef(null);
const runVideoTouchCurrentYRef = useRef(null);

  const [darkMode, setDarkMode] = useState(true);

  function closeRunVideoPlayer() {
    setActiveRunVideo(null);
  }

  function handleRunVideoPlaybackError() {
    setActiveRunVideo((current) => {
      if (!current) return current;

      const browserTarget = String(current.browserUrl || current.externalUrl || current.url || "").trim();

      if (
        Capacitor.isNativePlatform() &&
        browserTarget &&
        !current.browserFallbackOpened
      ) {
        window.setTimeout(() => {
          openRunVideoExternalLink(null, browserTarget);
        }, 0);

        return {
          ...current,
          browserFallbackOpened: true,
          errorMessage: "Opening native in-app video viewer...",
        };
      }

      return {
        ...current,
        errorMessage: "This video could not be played directly in the app player.",
      };
    });
  }

  async function openRunVideoExternalLink(event, sourceUrl) {
    event?.stopPropagation?.();

    const targetUrl = normalizePlayableVideoUrl(sourceUrl);
    if (!targetUrl) return;

    if (Capacitor.isNativePlatform()) {
      try {
        await Browser.open({
          url: targetUrl,
          presentationStyle: "fullscreen",
        });
        return;
      } catch (error) {
        console.error("Native in-app browser open failed:", error);
      }
    }

    const popup = window.open(targetUrl, "_blank", "noopener,noreferrer");

    if (!popup) {
      window.location.href = targetUrl;
    }
  }

  function closeRecentRunDetail() {
    setSelectedRecentRun(null);
  }

  function buildRunDetailPayload(run) {
    if (!run) return null;

    const shooter = findItemById(shooters, run.ShooterID, "ShooterID");
    const drill = findItemById(drills, run.DrillID, "DrillID");
    const session = findItemById(sessions, run.SessionID, "SessionID");
    const { displayNotes, videoMeta } = getRunVideoMeta(run);

    return {
      run,
      shooter,
      drill,
      session,
      displayNotes,
      videoMeta,
    };
  }

  function openRunDetail(run) {
    const payload = buildRunDetailPayload(run);
    if (!payload) return;
    setSelectedRecentRun(payload);
  }

  function handleRunVideoTouchStart(event) {
    const touch = event.touches?.[0];
    if (!touch) return;

    runVideoTouchStartYRef.current = touch.clientY;
    runVideoTouchCurrentYRef.current = touch.clientY;
  }

  function handleRunVideoTouchMove(event) {
    const touch = event.touches?.[0];
    if (!touch) return;

    runVideoTouchCurrentYRef.current = touch.clientY;
  }

  function handleRunVideoTouchEnd() {
    const startY = runVideoTouchStartYRef.current;
    const endY = runVideoTouchCurrentYRef.current;

    runVideoTouchStartYRef.current = null;
    runVideoTouchCurrentYRef.current = null;

    if (startY === null || endY === null) return;

    const swipeDistance = endY - startY;

    if (swipeDistance > 110) {
      closeRunVideoPlayer();
    }
  }

  async function openRunVideoPlayer(videoMeta, fallbackTitle = "Run Video") {
    const externalUrl = normalizePlayableVideoUrl(videoMeta?.url || "");
    const rawUrl = normalizePlayableVideoUrl(videoMeta?.rawUrl || "");
    const playableUrl = getPlayableVideoUrl(videoMeta);
    const nativePlayableUrl = getNativePlayableVideoUrl(videoMeta);
    const googleDriveFileId =
      extractGoogleDriveFileId(rawUrl) ||
      extractGoogleDriveFileId(externalUrl) ||
      extractGoogleDriveFileId(playableUrl);
    const googleDriveDownloadUrl = buildGoogleDriveDownloadUrl(googleDriveFileId);
    const directPlayerUrl = normalizePlayableVideoUrl(
      playableUrl || externalUrl || rawUrl || googleDriveDownloadUrl
    );
    const canUseDirectVideoPlayer = Boolean(directPlayerUrl);

    if (!directPlayerUrl && !externalUrl) {
      setMessage("No playable video URL found for this run.");
      return;
    }

    if (Capacitor.isNativePlatform() && nativePlayableUrl) {
      try {
        await NativeRunVideoPlayer.open({
          url: nativePlayableUrl,
          title: fallbackTitle,
        });
        return;
      } catch (error) {
        console.error("Native direct video player open failed:", error);
      }
    }

    if (Capacitor.isNativePlatform() && isRemoteHttpUrl(directPlayerUrl)) {
      try {
        await Browser.open({
          url: directPlayerUrl,
          presentationStyle: "fullscreen",
        });
        return;
      } catch (error) {
        console.error("Native browser video open failed:", error);
      }
    }

    setActiveRunVideo({
      url: directPlayerUrl,
      title: fallbackTitle,
      externalUrl:
        directPlayerUrl ||
        externalUrl ||
        rawUrl ||
        googleDriveDownloadUrl,
      browserUrl:
        directPlayerUrl ||
        googleDriveDownloadUrl ||
        externalUrl ||
        rawUrl,
      fallbackUrl: "",
      mode: "video",
      errorMessage: "",
      browserFallbackOpened: false,
    });
  }

  function openEventDisplayRecentRuns() {
    if (eventDisplayRecentCloseTimeoutRef.current) {
      clearTimeout(eventDisplayRecentCloseTimeoutRef.current);
      eventDisplayRecentCloseTimeoutRef.current = null;
    }

    setEventDisplayRecentOpen(true);

    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      window.requestAnimationFrame(() => {
        setEventDisplayRecentVisible(true);
      });
    } else {
      setEventDisplayRecentVisible(true);
    }
  }

  function closeEventDisplayRecentRuns() {
    setEventDisplayRecentVisible(false);

    if (eventDisplayRecentCloseTimeoutRef.current) {
      clearTimeout(eventDisplayRecentCloseTimeoutRef.current);
    }

    eventDisplayRecentCloseTimeoutRef.current = setTimeout(() => {
      setEventDisplayRecentOpen(false);
      eventDisplayRecentCloseTimeoutRef.current = null;
    }, 220);
  }

  function openEventDisplayRecentVideo(videoMeta, fallbackTitle = "Run Video") {
    setEventDisplayRecentVisible(false);

    if (eventDisplayRecentCloseTimeoutRef.current) {
      clearTimeout(eventDisplayRecentCloseTimeoutRef.current);
      eventDisplayRecentCloseTimeoutRef.current = null;
    }

    window.setTimeout(() => {
      setEventDisplayRecentOpen(false);
      openRunVideoPlayer(videoMeta, fallbackTitle);
    }, 140);
  }

  function openEventDisplayStages() {
    if (eventDisplayStagesCloseTimeoutRef.current) {
      clearTimeout(eventDisplayStagesCloseTimeoutRef.current);
      eventDisplayStagesCloseTimeoutRef.current = null;
    }

    setEventDisplayStagesOpen(true);

    if (typeof window !== "undefined" && window.requestAnimationFrame) {
      window.requestAnimationFrame(() => {
        setEventDisplayStagesVisible(true);
      });
    } else {
      setEventDisplayStagesVisible(true);
    }
  }

  function closeEventDisplayStages() {
    setEventDisplayStagesVisible(false);

    if (eventDisplayStagesCloseTimeoutRef.current) {
      clearTimeout(eventDisplayStagesCloseTimeoutRef.current);
    }

    eventDisplayStagesCloseTimeoutRef.current = setTimeout(() => {
      setEventDisplayStagesOpen(false);
      eventDisplayStagesCloseTimeoutRef.current = null;
    }, 220);
  }

  function closeEventDisplayStageViewer() {
    setEventDisplayStageViewerOpen(false);
    setEventDisplayStagePdf(null);
  }

const [timerRunning, setTimerRunning] = useState(false);

const [buttonLocked, setButtonLocked] = useState(false);

const [timerActionLocked, setTimerActionLocked] = useState(false);

const [headerLoaded, setHeaderLoaded] = useState(false);

const [powerFactor, setPowerFactor] = useState("minor");
const [aHits, setAHits] = useState("");
const [cHits, setCHits] = useState("");
const [dHits, setDHits] = useState("");
const [misses, setMisses] = useState("");
const [noShoots, setNoShoots] = useState("");
const [steelHits, setSteelHits] = useState("");
const [steelMisses, setSteelMisses] = useState("");
const [stageName, setStageName] = useState("");

const [showUspsaScoringModal, setShowUspsaScoringModal] = useState(false);
const [pendingUspsaRun, setPendingUspsaRun] = useState(null);

const [trainingLeaderboardBoard, setTrainingLeaderboardBoard] = useState("");
const [uspsaLeaderboardBoard, setUspsaLeaderboardBoard] = useState("");
const [eventDisplayLeaderboardMode, setEventDisplayLeaderboardMode] = useState("training");
const [eventDisplayTrainingBoard, setEventDisplayTrainingBoard] = useState("");
const [eventDisplayUspsaBoard, setEventDisplayUspsaBoard] = useState("");
const [eventDisplayBoardSelection, setEventDisplayBoardSelection] = useState("__all__");
const [eventDisplayRotationToken, setEventDisplayRotationToken] = useState(0);
const eventDisplayBoardOptionsRef = useRef([]);
const activeEventDisplayBoardKeyRef = useRef("");

const [shooterSearch, setShooterSearch] = useState("");

const [showTimerPicker, setShowTimerPicker] = useState(false);
const [availableTimers, setAvailableTimers] = useState([]);
const [scanningTimers, setScanningTimers] = useState(false);
const [activeCourseId, setActiveCourseId] = useState("");
const [courseHomeToken, setCourseHomeToken] = useState(0);
const [courseBuilderName, setCourseBuilderName] = useState("New Course");
const [courseBuilderNotes, setCourseBuilderNotes] = useState("");
const [courseBuilderTool, setCourseBuilderTool] = useState("target");
const [courseBuilderItems, setCourseBuilderItems] = useState([]);
const [courseBuilderSelectedId, setCourseBuilderSelectedId] = useState(null);
const [courseBuilderTransferCode, setCourseBuilderTransferCode] = useState("");
const [courseBuilderStageWidth, setCourseBuilderStageWidth] = useState(32);
const [courseBuilderStageDepth, setCourseBuilderStageDepth] = useState(18);
const [courseBuilderStageTitle, setCourseBuilderStageTitle] = useState("Field Course");
const [viewportWidth, setViewportWidth] = useState(() =>
  typeof window !== "undefined" ? window.innerWidth : 1280
);

function clearVideoSelection() {
  setVideoFile(null);
  setVideoFilePath("");
  setVideoFileName("");
  setVideoDuration("");
  setVideoStatus("");
  setVideoUploadedUrl("");
  videoCaptureSessionRef.current = {
    active: false,
    awaitingStop: false,
    pendingFinalize: false,
    discardPending: false,
    recordedMeta: null,
  };

  if (videoInputRef.current) {
    videoInputRef.current.value = "";
  }

  setVideoPreviewUrl((currentUrl) => {
    releasePreviewUrl(currentUrl);

    return "";
  });
}

async function handleVideoFileChange(event) {
  const file = event.target.files?.[0];

  if (!file) {
    clearVideoSelection();
    return;
  }

  if (!String(file.type || "").startsWith("video/")) {
    clearVideoSelection();
    setVideoStatus("Please select a video file.");
    return;
  }

  const nextPreviewUrl = URL.createObjectURL(file);

  setVideoFile(file);
  setVideoFilePath("");
  setVideoFileName(file.name);
  setVideoDuration("");
  setVideoStatus(
    isFirebaseConfigured()
      ? "Video selected. It will upload to cloud storage when you save the run."
      : "Video selected for local preview. Add Firebase env vars to enable permanent cloud upload."
  );
  setVideoUploadedUrl("");
  setVideoPreviewUrl((currentUrl) => {
    releasePreviewUrl(currentUrl);

    return nextPreviewUrl;
  });
}

useEffect(() => {
  return () => {
    releasePreviewUrl(videoPreviewUrl);
  };
}, [videoPreviewUrl]);

useEffect(() => {
  return () => {
    if (eventDisplayRecentCloseTimeoutRef.current) {
      clearTimeout(eventDisplayRecentCloseTimeoutRef.current);
    }
    if (eventDisplayStagesCloseTimeoutRef.current) {
      clearTimeout(eventDisplayStagesCloseTimeoutRef.current);
    }
  };
}, []);

useEffect(() => {
  if (!Capacitor.isNativePlatform()) {
    return undefined;
  }

  NativeVideoRecorder.cleanupExpiredVideos({ maxAgeHours: 24 }).catch((error) => {
    console.error("Expired video cleanup failed:", error);
  });

  return undefined;
}, []);

async function openNativeVideoMode() {
  const showVideoModeError = (text) => {
    setVideoStatus(text);
    setMessage(text);
    alert(text);
  };

  if (!Capacitor.isNativePlatform()) {
    showVideoModeError("Video mode is only available in the iPhone/iPad app.");
    return;
  }

  if (!timerConnected || !nativeDeviceIdRef.current) {
    showVideoModeError("Connect the timer before opening video mode.");
    return;
  }

  if (!selectedShooterData || !selectedDrillData || !selectedSessionData) {
    showVideoModeError("Choose a shooter, drill, and session first.");
    return;
  }

  try {
    setVideoStatus("Opening rear camera...");
    setMessage("Opening rear camera...");
    await NativeVideoRecorder.presentRecorder({
      shooter: selectedShooterData?.Name || "",
      drill: selectedDrillData?.DrillName || "",
      session: selectedSessionData?.SessionName || "",
    });
    await pushNativeRecordingStats({ shots: 0, totalTime: 0 });
    setNativeVideoModeOpen(true);
  } catch (error) {
    console.error("Open native video mode error:", error);
    setNativeVideoModeOpen(false);
    showVideoModeError(error?.message || "Unable to open video mode.");
  }
}






useEffect(() => {
  async function initBle() {
    try {
      if (Capacitor.isNativePlatform()) {
        await BleClient.initialize();
        console.log("Native BLE initialized");
      }
    } catch (err) {
      console.error("BLE init error:", err);
    }
  }

  initBle();
}, []);

useEffect(() => {
  selectedShooterRef.current = selectedShooter;
}, [selectedShooter]);

useEffect(() => {
  selectedDrillRef.current = selectedDrill;
}, [selectedDrill]);

useEffect(() => {
  selectedSessionRef.current = selectedSession;
}, [selectedSession]);

useEffect(() => {
  shootersRef.current = shooters;
}, [shooters]);

useEffect(() => {
  drillsRef.current = drills;
}, [drills]);

useEffect(() => {
  sessionsRef.current = sessions;
}, [sessions]);

useEffect(() => {
  runsRef.current = runs;
}, [runs]);

const [timerStatusMessage, setTimerStatusMessage] = useState("");
const hasRememberedNativeTimer = useMemo(() => {
  try {
    return Boolean(
      localStorage.getItem("lastDeviceId") ||
        localStorage.getItem("lastDeviceName") ||
        localStorage.getItem("preferredTimerDevice")
    );
  } catch {
    return false;
  }
}, [timerStatusMessage, timerConnected]);

const shouldShowForgetTimerButton =
  hasRememberedNativeTimer ||
  /pair|peer removed pairing|failed to connect|connection timeout|saved timer unavailable/i.test(
    timerStatusMessage || ""
  );

const [activeTab, setActiveTab] = useState("timer");
const eventDisplayParams = useMemo(() => new URLSearchParams(window.location.search), []);
const isEventDisplayMode = eventDisplayParams.get("view") === "event-display";
const [eventDisplaySlide, setEventDisplaySlide] = useState(0);
const [eventDisplayNow, setEventDisplayNow] = useState(() => new Date());
const [eventDisplayRecentOpen, setEventDisplayRecentOpen] = useState(false);
const [eventDisplayRecentVisible, setEventDisplayRecentVisible] = useState(false);
const [eventDisplayStagesOpen, setEventDisplayStagesOpen] = useState(false);
const [eventDisplayStageViewerOpen, setEventDisplayStageViewerOpen] = useState(false);
const [eventDisplayStagesVisible, setEventDisplayStagesVisible] = useState(false);
const [eventDisplayStagePdf, setEventDisplayStagePdf] = useState(null);
const [eventDisplayCourses, setEventDisplayCourses] = useState([]);
const [eventDisplayCoursesLoading, setEventDisplayCoursesLoading] = useState(false);
const eventDisplayRecentCloseTimeoutRef = useRef(null);
const eventDisplayStagesCloseTimeoutRef = useRef(null);
const [activeMatch, setActiveMatch] = useState(() => readStoredJson(MATCH_STORAGE_KEY, null));
const [matchHistory, setMatchHistory] = useState(() => readStoredJson(MATCH_HISTORY_STORAGE_KEY, []));
const [matchNameInput, setMatchNameInput] = useState("");
const [matchDrillId, setMatchDrillId] = useState("");
const [matchSessionId, setMatchSessionId] = useState("");
const [matchShooterSearch, setMatchShooterSearch] = useState("");
const [matchRosterIds, setMatchRosterIds] = useState([]);
const [activeQualification, setActiveQualification] = useState(() =>
  readStoredJson(QUALIFICATION_STORAGE_KEY, null)
);
const [qualificationShooterSearch, setQualificationShooterSearch] = useState("");
const [qualificationRosterIds, setQualificationRosterIds] = useState([]);
const [qualificationStageEntries, setQualificationStageEntries] = useState({});
const [qualificationSaving, setQualificationSaving] = useState(false);
const selectedShooterData = findItemById(shooters, selectedShooter, "ShooterID");
const selectedDrillData = findItemById(drills, selectedDrill, "DrillID");
const selectedSessionData = findItemById(sessions, selectedSession, "SessionID");
const defaultMatchSessionId = useMemo(() => {
  const defaultMatchSession = sessions.find((session) =>
    isUspsaSessionName(String(session?.SessionName || session?.Name || session?.SessionID || "").trim())
  );

  return defaultMatchSession?.SessionID ? String(defaultMatchSession.SessionID) : "";
}, [sessions]);
const defaultMatchDrillId = useMemo(() => {
  const defaultMatchDrill = drills.find(
    (drill) => String(drill?.DrillName || "").trim().toLowerCase() === "course"
  );

  return defaultMatchDrill?.DrillID ? String(defaultMatchDrill.DrillID) : "";
}, [drills]);

useEffect(() => {
  if (isEventDisplayMode || !isFirebaseConfigured()) {
    setAuthReady(true);
    return undefined;
  }

  let timeoutId = null;
  let unsubscribe = () => {};
  let settled = false;

  timeoutId = window.setTimeout(() => {
    if (settled) return;

    console.warn("Firebase auth startup timed out. Falling back to login screen.");
    setAuthProfile(null);
    setAuthUser(null);
    setAuthError("Account check took too long. Please sign in.");
    setAuthReady(true);
  }, 4000);

  try {
    unsubscribe = subscribeToAuthChanges(async (nextUser) => {
      settled = true;

      if (timeoutId) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }

      setAuthUser(nextUser || null);
      setAuthError("");

      if (!nextUser) {
        setAuthProfile(null);
        setAuthReady(true);
        return;
      }

      try {
        const profileCacheKey = `jmt-auth-profile-${nextUser.uid}`;
        const cachedProfile = readStoredJson(profileCacheKey, null);
        const pendingRole = String(localStorage.getItem(AUTH_PENDING_ROLE_KEY) || "").trim().toLowerCase();
        let profile = await withClientTimeout(
          getUserProfile(nextUser.uid),
          6000,
          "Account profile load timed out."
        );

        if (!profile) {
          profile = await withClientTimeout(
            ensureUserProfileRecord({
              uid: nextUser.uid,
              email: nextUser.email || "",
              displayName: nextUser.displayName || "",
              role: cachedProfile?.role || pendingRole || "instructor",
              shooterId: cachedProfile?.shooterId || "",
            }),
            6000,
            "Account profile creation timed out."
          );
        }

        setAuthProfile(profile || null);
        try {
          localStorage.setItem(profileCacheKey, JSON.stringify(profile || null));
          localStorage.removeItem(AUTH_PENDING_ROLE_KEY);
        } catch {
          // ignore local cache write issues
        }
      } catch (error) {
        console.error("Auth profile load error:", error);
        const cachedProfile = readStoredJson(`jmt-auth-profile-${nextUser.uid}`, null);
        const pendingRole = String(localStorage.getItem(AUTH_PENDING_ROLE_KEY) || "").trim().toLowerCase();
        const fallbackProfile =
          cachedProfile ||
          {
            id: nextUser.uid,
            email: nextUser.email || "",
            displayName: nextUser.displayName || "",
            role: pendingRole || "instructor",
            shooterId: "",
          };

        setAuthProfile(fallbackProfile);
        setAuthError("Account profile took too long to load. Using saved account info.");
      } finally {
        setAuthReady(true);
      }
    });
  } catch (error) {
    settled = true;

    if (timeoutId) {
      window.clearTimeout(timeoutId);
      timeoutId = null;
    }

    console.error("Auth subscription startup error:", error);
    setAuthProfile(null);
    setAuthUser(null);
    setAuthError("Could not start login. Please check Firebase setup.");
    setAuthReady(true);
  }

  return () => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    unsubscribe();
  };
}, [isEventDisplayMode]);

useEffect(() => {
  if (!activeMatch) return;
  syncMatchSelection(activeMatch);
}, [activeMatch?.currentIndex, activeMatch?.drillId, activeMatch?.sessionId]);

useEffect(() => {
  if (!activeQualification) return;

  setSelectedDrill(String(activeQualification.drillId || ""));
  selectedDrillRef.current = String(activeQualification.drillId || "");
  setSelectedSession(String(activeQualification.sessionId || ""));
  selectedSessionRef.current = String(activeQualification.sessionId || "");
}, [activeQualification?.distanceIndex, activeQualification?.drillId, activeQualification?.sessionId]);

useEffect(() => {
  if (activeMatch) return;

  if (!matchSessionId && defaultMatchSessionId) {
    setMatchSessionId(defaultMatchSessionId);
  }

  if (!matchDrillId && defaultMatchDrillId) {
    setMatchDrillId(defaultMatchDrillId);
  }
}, [activeMatch, defaultMatchDrillId, defaultMatchSessionId, matchDrillId, matchSessionId]);

useEffect(() => {
  try {
    if (activeQualification) {
      localStorage.setItem(
        QUALIFICATION_STORAGE_KEY,
        JSON.stringify(activeQualification)
      );
    } else {
      localStorage.removeItem(QUALIFICATION_STORAGE_KEY);
    }
  } catch {
    // ignore qualification storage errors
  }
}, [activeQualification]);

useEffect(() => {
  if (!activeQualification) {
    setQualificationStageEntries({});
    return;
  }

  const nextEntries = {};
  const currentDistanceIndex = Number(activeQualification.distanceIndex || 0);

  (activeQualification.shooterIds || []).forEach((shooterId) => {
    const savedEntry = (activeQualification.results || []).find(
      (entry) =>
        String(entry?.shooterId || "") === String(shooterId) &&
        Number(entry?.distanceIndex || 0) === currentDistanceIndex
    );

    nextEntries[String(shooterId)] = {
      score:
        savedEntry && savedEntry.score !== undefined && savedEntry.score !== null
          ? String(savedEntry.score)
          : "",
      notes: savedEntry?.notes || "",
    };
  });

  setQualificationStageEntries(nextEntries);
}, [activeQualification]);

const activeMatchCurrentShooterId =
  activeMatch?.shooterIds?.[activeMatch?.currentIndex || 0] || "";
const activeMatchCurrentShooter = activeMatchCurrentShooterId
  ? findItemById(shooters, activeMatchCurrentShooterId, "ShooterID")
  : null;
const activeMatchNextShooterId =
  activeMatch?.shooterIds?.[(activeMatch?.currentIndex || 0) + 1] || "";
const activeMatchNextShooter = activeMatchNextShooterId
  ? findItemById(shooters, activeMatchNextShooterId, "ShooterID")
  : null;
const filteredMatchShooterOptions = useMemo(() => {
  const searchValue = matchShooterSearch.trim().toLowerCase();

  return shooters.filter((shooter) => {
    const alreadySelected = matchRosterIds.includes(String(shooter.ShooterID));
    if (alreadySelected) return false;

    if (!searchValue) return true;

    const haystack = [
      shooter.Name,
      shooter.Level,
      shooter.ShooterID,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(searchValue);
  });
}, [matchRosterIds, matchShooterSearch, shooters]);
const selectedQualificationConfig = useMemo(
  () => parseQualificationConfig(selectedDrillData),
  [selectedDrillData]
);
const qualificationModeActive = Boolean(selectedQualificationConfig || activeQualification);
const qualificationDistances = selectedQualificationConfig?.distances || [];
const activeQualificationDistanceIndex = Number(activeQualification?.distanceIndex || 0);
const activeQualificationDistance =
  activeQualification?.distances?.[activeQualificationDistanceIndex] || null;
const selectedQualificationPassPercent = getQualificationStagePassPercent(
  qualificationDistances[0] || selectedQualificationConfig?.distances?.[0] || null
);
const selectedQualificationPreviewTarget = getQualificationStageTarget(
  qualificationDistances[0] || selectedQualificationConfig?.distances?.[0] || null
);
const activeQualificationPassPercent = getQualificationStagePassPercent(activeQualificationDistance);
const activeQualificationStageTarget = getQualificationStageTarget(activeQualificationDistance);
const filteredQualificationShooterOptions = useMemo(() => {
  const searchValue = qualificationShooterSearch.trim().toLowerCase();

  return shooters.filter((shooter) => {
    const alreadySelected = qualificationRosterIds.includes(String(shooter.ShooterID));
    if (alreadySelected) return false;

    if (!searchValue) return true;

    const searchableText = [
      shooter.Name,
      shooter.Level,
      shooter.ShooterID,
    ]
      .map((value) => String(value || "").toLowerCase())
      .join(" ");

    return searchableText.includes(searchValue);
  });
}, [qualificationRosterIds, qualificationShooterSearch, shooters]);
const activeQualificationRoster = useMemo(
  () =>
    (activeQualification?.shooterIds || [])
      .map((shooterId) => findItemById(shooters, shooterId, "ShooterID"))
      .filter(Boolean),
  [activeQualification?.shooterIds, shooters]
);
const qualificationOverallResults = useMemo(() => {
  const totals = new Map();

  (activeQualification?.results || []).forEach((entry) => {
    const shooterId = String(entry?.shooterId || "").trim();
    if (!shooterId) return;

    const existing = totals.get(shooterId) || {
      shooterId,
      totalScore: 0,
      stagesCompleted: 0,
      notesCount: 0,
    };

    existing.totalScore += Number(entry?.score || 0) || 0;
    existing.stagesCompleted += 1;
    if (String(entry?.notes || "").trim()) {
      existing.notesCount += 1;
    }

    totals.set(shooterId, existing);
  });

  return Array.from(totals.values())
    .map((entry) => ({
      ...entry,
      shooter: findItemById(shooters, entry.shooterId, "ShooterID"),
    }))
    .sort((a, b) => b.totalScore - a.totalScore);
}, [activeQualification?.results, shooters]);

const theme = darkMode
  ? {
      pageBg: "#0b0b0c",
      cardBg: "#141416",
      cardBgSoft: "#1b1b1f",
      text: "#f3efe6",
      subtext: "#b8aa8a",
      border: "#3a2f23",
      inputBg: "#101012",
      inputText: "#f3efe6",
      accent: "#c8a36a",
      accentSoft: "rgba(200,163,106,0.16)",
      successBg: "rgba(34,197,94,0.14)",
      successText: "#86efac",
      dangerBg: "rgba(248,113,113,0.14)",
      dangerText: "#fca5a5",
      tabBarBg: "rgba(12,12,14,0.92)",
      tabBorder: "rgba(58,47,35,0.95)",
      shadow: "0 12px 32px rgba(0,0,0,0.45)",
      rowBg: "#121215",
      rowAltBg: "#18181c",
      headerBg: "#211b15",
    }
  : {
      pageBg: "#f7f3eb",
      cardBg: "#ffffff",
      cardBgSoft: "#f3ede3",
      text: "#1f1710",
      subtext: "#7b6546",
      border: "#dbc5a3",
      inputBg: "#ffffff",
      inputText: "#1f1710",
      accent: "#a5783f",
      accentSoft: "rgba(165,120,63,0.14)",
      successBg: "#e6f4ea",
      successText: "#137333",
      dangerBg: "#ffeaea",
      dangerText: "#b42318",
      tabBarBg: "rgba(255,250,244,0.94)",
      tabBorder: "rgba(219,197,163,0.95)",
      shadow: "0 8px 24px rgba(59,39,18,0.12)",
      rowBg: "#ffffff",
      rowAltBg: "#faf6ef",
      headerBg: "#efe4d2",
    };

useEffect(() => {
  autoReconnectTimer();
}, []);

useEffect(() => {
  try {
    if (activeMatch) {
      localStorage.setItem(MATCH_STORAGE_KEY, JSON.stringify(activeMatch));
    } else {
      localStorage.removeItem(MATCH_STORAGE_KEY);
    }
  } catch {
    // ignore local match persistence issues
  }
}, [activeMatch]);

useEffect(() => {
  try {
    localStorage.setItem(MATCH_HISTORY_STORAGE_KEY, JSON.stringify(matchHistory));
  } catch {
    // ignore local history persistence issues
  }
}, [matchHistory]);

useEffect(() => {
  let cancelled = false;

  async function loadEventDisplayCourses() {
    if (!isEventDisplayMode || !isFirebaseConfigured()) {
      if (!cancelled) {
        setEventDisplayCourses([]);
      }
      return;
    }

    setEventDisplayCoursesLoading(true);

    try {
      const db = getFirebaseFirestoreInstance();
      if (!db) {
        if (!cancelled) {
          setEventDisplayCourses([]);
        }
        return;
      }

      const courseQuery = query(collection(db, COURSE_COLLECTION_NAME), orderBy("updatedAt", "desc"));
      const snapshot = await getDocs(courseQuery);
      const nextCourses = snapshot.docs.map((courseDoc) => normalizeCloudCourse(courseDoc.id, courseDoc.data()));

      if (!cancelled) {
        setEventDisplayCourses(nextCourses);
      }
    } catch (error) {
      console.error("Event display courses load error:", error);
      if (!cancelled) {
        setEventDisplayCourses([]);
      }
    } finally {
      if (!cancelled) {
        setEventDisplayCoursesLoading(false);
      }
    }
  }

  loadEventDisplayCourses();

  return () => {
    cancelled = true;
  };
}, [isEventDisplayMode, courseHomeToken]);

useEffect(() => {
  if (!Capacitor.isNativePlatform()) {
    return undefined;
  }

  let cancelled = false;

  async function bindNativeVideoEvents() {
    const handles = await Promise.all([
      NativeVideoRecorder.addListener("recordingStarted", async () => {
        videoCaptureSessionRef.current = {
          active: true,
          awaitingStop: false,
          pendingFinalize: false,
          discardPending: false,
          recordedMeta: null,
        };
        discardCurrentTimerRunRef.current = false;

        setNativeVideoModeOpen(true);
        setVideoStatus("Recording started. Sending timer start signal...");
        await pushNativeRecordingStats({ shots: 0, totalTime: 0 });

        try {
          await startTimer();
        } catch (error) {
          console.error("Timer start after video start failed:", error);
          setVideoStatus("Video started, but the timer start signal failed.");
        }
      }),
      NativeVideoRecorder.addListener("recordingStopRequested", async () => {
        videoCaptureSessionRef.current = {
          ...videoCaptureSessionRef.current,
          awaitingStop: true,
        };

        setVideoStatus("Stopping timer...");

        try {
          await stopTimer();
        } catch (error) {
          console.error("Timer stop before video stop failed:", error);
        }

        try {
          await NativeVideoRecorder.completeStop();
        } catch (error) {
          console.error("Native video stop failed:", error);
          setVideoStatus("Timer stopped, but video finalization failed.");
        }
      }),
      NativeVideoRecorder.addListener("recordingCancelRequested", async () => {
        discardCurrentTimerRunRef.current = true;
        videoCaptureSessionRef.current = {
          ...videoCaptureSessionRef.current,
          discardPending: true,
          pendingFinalize: false,
          awaitingStop: false,
        };

        currentShots = [];
        lastShotSnapshotRef.current = [];
        setLiveShotTimes([]);
        setVideoStatus("Cancelling run and stopping timer...");
        await pushNativeRecordingStats({ shots: 0, totalTime: 0 });

        if (timerRunning || videoCaptureSessionRef.current.active) {
          try {
            await stopTimer();
          } catch (error) {
            console.error("Timer stop on video cancel request failed:", error);
          }
        }
      }),
      NativeVideoRecorder.addListener("recordingFinished", async (event) => {
        console.log("NATIVE recordingFinished event:", event);
        const durationValue =
          event?.durationSeconds === null || event?.durationSeconds === undefined
            ? ""
            : String(Number(event.durationSeconds).toFixed(1));
        const localPreviewUrl = event?.filePath
          ? Capacitor.convertFileSrc(event.filePath)
          : "";

        videoCaptureSessionRef.current = {
          ...videoCaptureSessionRef.current,
          active: false,
          awaitingStop: false,
          discardPending: false,
          recordedMeta: event?.filePath
            ? {
                name: event.fileName || "recorded-run.mov",
                type: event.mimeType || "video/quicktime",
                size: Number(event.fileSize || 0),
                duration: parseNumber(durationValue),
                storage: "local-only",
                url: "",
                localFilePath: event.filePath,
                savedAt: new Date().toISOString(),
              }
            : null,
        };

        setNativeVideoModeOpen(false);
        setVideoFile(null);
        setVideoFilePath(event?.filePath || "");
        setVideoFileName(event?.fileName || "recorded-run.mov");
        setVideoUploadedUrl("");
        setVideoDuration(durationValue);
        setVideoStatus(event?.filePath ? "Video recorded and attached to this run." : "Video recording finished.");
        setVideoPreviewUrl((currentUrl) => {
          releasePreviewUrl(currentUrl);
          return localPreviewUrl;
        });
        await pushNativeRecordingStats({ shots: 0, totalTime: 0 });

        if (videoCaptureSessionRef.current.pendingFinalize) {
          console.log("recordingFinished: pending finalize detected, finalizing timer run now");
          videoCaptureSessionRef.current = {
            ...videoCaptureSessionRef.current,
            pendingFinalize: false,
          };
          await finalizeRun();
        }
      }),
      NativeVideoRecorder.addListener("recordingCancelled", async () => {
        const shouldStopTimer = videoCaptureSessionRef.current.active || videoCaptureSessionRef.current.awaitingStop || timerRunning;

        setNativeVideoModeOpen(false);
        currentShots = [];
        lastShotSnapshotRef.current = [];
        setLiveShotTimes([]);
        videoCaptureSessionRef.current = {
          active: false,
          awaitingStop: false,
          pendingFinalize: false,
          discardPending: false,
          recordedMeta: null,
        };
        discardCurrentTimerRunRef.current = false;
        await pushNativeRecordingStats({ shots: 0, totalTime: 0 });
        setVideoStatus(shouldStopTimer ? "Video mode cancelled and timer stopped." : "Video mode closed.");
      }),
    ]);

    if (cancelled) {
      handles.forEach((handle) => handle.remove());
      return;
    }

    nativeVideoListenerHandlesRef.current = handles;
  }

  bindNativeVideoEvents();

  return () => {
    cancelled = true;
    nativeVideoListenerHandlesRef.current.forEach((handle) => handle.remove());
    nativeVideoListenerHandlesRef.current = [];
  };
}, []);

useEffect(() => {
  return () => {
    try {
      if (eventCharRef.current) {
        eventCharRef.current.removeEventListener(
          "characteristicvaluechanged",
          handleTimerEvent
        );
      }

      if (timerDeviceRef.current?.gatt?.connected) {
        timerDeviceRef.current.gatt.disconnect();
      }
    } catch (err) {
      console.error("Cleanup disconnect error:", err);
    }
  };
}, []);

function handleNativeTimerBytes(bytes) {
  try {
    const event = {
      target: {
        value: new DataView(bytes.buffer.slice(0)),
      },
    };

    handleTimerEvent(event);
  } catch (err) {
    console.error("handleNativeTimerBytes error:", err);
  }
}

function clearRememberedNativeTimer() {
  try {
    localStorage.removeItem("lastDeviceId");
    localStorage.removeItem("lastDeviceName");
    localStorage.removeItem("preferredTimerDevice");
  } catch (error) {
    console.error("Clear remembered timer error:", error);
  }

  lastNativeDeviceIdRef.current = "";
  lastNativeDeviceNameRef.current = "";
}

async function forgetSavedTimer() {
  try {
    setShowTimerPicker(false);
    setAvailableTimers([]);

    if (reconnectAttemptTimeoutRef.current) {
      clearTimeout(reconnectAttemptTimeoutRef.current);
      reconnectAttemptTimeoutRef.current = null;
    }

    clearRememberedNativeTimer();

    if (Capacitor.isNativePlatform()) {
      if (nativeScanInProgressRef.current) {
        try {
          await BleClient.stopLEScan();
        } catch (error) {
          console.error("Stop scan during forget timer error:", error);
        }
        nativeScanInProgressRef.current = false;
      }

      if (nativeDeviceIdRef.current) {
        try {
          if (nativeNotifyActiveRef.current) {
            await BleClient.stopNotifications(
              nativeDeviceIdRef.current,
              "7520ffff-14d2-4cda-8b6b-697c554c9311",
              "75200001-14d2-4cda-8b6b-697c554c9311"
            );
          }
        } catch (error) {
          console.error("Stop notifications during forget timer error:", error);
        }

        try {
          await BleClient.disconnect(nativeDeviceIdRef.current);
        } catch (error) {
          console.error("Disconnect during forget timer error:", error);
        }
      }

      nativeDeviceIdRef.current = "";
      nativeNotifyActiveRef.current = false;
      nativeManualConnectInProgressRef.current = false;
      nativeDisconnectingRef.current = false;
    } else {
      if (eventCharRef.current) {
        try {
          eventCharRef.current.removeEventListener(
            "characteristicvaluechanged",
            handleTimerEvent
          );
        } catch {}
        eventCharRef.current = null;
      }

      if (timerDeviceRef.current?.gatt?.connected) {
        try {
          timerDeviceRef.current.gatt.disconnect();
        } catch (error) {
          console.error("Web disconnect during forget timer error:", error);
        }
      }

      timerDeviceRef.current = null;
      timerServerRef.current = null;
    }

    setScanningTimers(false);
    setTimerConnected(false);
    setTimerDeviceName("");
    setTimerRunning(false);
    setTimerStatusMessage(
      "Saved timer cleared. If pairing still fails, forget the timer in iPhone Bluetooth settings."
    );
  } catch (error) {
    console.error("Forget saved timer error:", error);
    setTimerStatusMessage("Could not clear saved timer");
  }
}

async function scanNativeBle() {
  try {
    if (!Capacitor.isNativePlatform()) {
      setTimerStatusMessage("Native BLE is only for the iPhone app");
      return;
    }

    if (nativeManualConnectInProgressRef.current) {
      console.log("Manual timer connect in progress — blocking scan");
      return;
    }

    if (nativeDeviceIdRef.current || timerConnected) {
      console.log("Already connected — blocking scan");
      return;
    }

    if (nativeDisconnectingRef.current) {
      setTimerStatusMessage("Finishing disconnect...");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (nativeScanInProgressRef.current) {
      setTimerStatusMessage("Already scanning...");
      return;
    }

    nativeScanInProgressRef.current = true;
    setScanningTimers(true);
    setAvailableTimers([]);
    setShowTimerPicker(false);
    setTimerStatusMessage("Scanning for timers...");

    const foundDevices = [];
    let scanFinished = false;
    let singleTimerTimeoutId = null;
    let fullScanTimeoutId = null;

    const clearPendingScanTimeouts = () => {
      if (singleTimerTimeoutId) {
        clearTimeout(singleTimerTimeoutId);
        singleTimerTimeoutId = null;
      }

      if (fullScanTimeoutId) {
        clearTimeout(fullScanTimeoutId);
        fullScanTimeoutId = null;
      }
    };

    const finishScan = async () => {
      if (scanFinished) return;
      scanFinished = true;
      clearPendingScanTimeouts();

      try {
        await BleClient.stopLEScan();
      } catch {}

      nativeScanInProgressRef.current = false;
      setScanningTimers(false);

      if (foundDevices.length === 0) {
        setTimerStatusMessage("No timers found");
        return;
      }

      if (foundDevices.length === 1) {
        const onlyTimer = foundDevices[0];
        setAvailableTimers(foundDevices);
        setShowTimerPicker(false);
        setTimerStatusMessage(`Connecting to ${onlyTimer.name || "timer"}...`);
        const connected = await connectToNativeTimer(onlyTimer);
        if (!connected) {
          setAvailableTimers(foundDevices);
          setShowTimerPicker(true);
          setTimerStatusMessage("Tap the timer to retry connection");
        }
        return;
      }

      setAvailableTimers(foundDevices);
      setShowTimerPicker(true);
      setTimerStatusMessage("Select a timer");
    };

    await new Promise((resolve) => setTimeout(resolve, 500));

    await BleClient.requestLEScan(
      {
        services: [],
        namePrefix: "SG-",
      },
      (result) => {
        console.log("Native BLE device found:", result);

        const device = result?.device;
        const name = device?.name || result?.localName || "";
        const deviceId =
          device?.deviceId || device?.deviceID || result?.deviceId || "";

        if (!name.startsWith("SG-") || !deviceId) return;

        const alreadyExists = foundDevices.some((d) => d.id === deviceId);

        if (!alreadyExists) {
          foundDevices.push({
            id: deviceId,
            name,
          });

          if (foundDevices.length === 1) {
            singleTimerTimeoutId = setTimeout(() => {
              finishScan();
            }, 1400);
          } else if (foundDevices.length > 1 && singleTimerTimeoutId) {
            clearTimeout(singleTimerTimeoutId);
            singleTimerTimeoutId = null;
          }
        }
      }
    );

    fullScanTimeoutId = setTimeout(() => {
      finishScan();
    }, 5000);
  } catch (err) {
    console.error("Native BLE scan/connect error:", err);
    nativeScanInProgressRef.current = false;
    setScanningTimers(false);
    setTimerStatusMessage("BLE scan failed");
  }
}

async function connectToNativeTimer(timer) {
  try {
    if (!timer?.id) {
      setTimerStatusMessage("Invalid timer");
      return false;
    }

    nativeManualConnectInProgressRef.current = true;

    if (reconnectAttemptTimeoutRef.current) {
      clearTimeout(reconnectAttemptTimeoutRef.current);
      reconnectAttemptTimeoutRef.current = null;
    }

    setTimerStatusMessage(`Connecting to ${timer.name}...`);

    if (nativeScanInProgressRef.current) {
      try {
        await BleClient.stopLEScan();
      } catch (error) {
        console.error("Stop scan before connect error:", error);
      }
      nativeScanInProgressRef.current = false;
      setScanningTimers(false);
    }

    const cleanupNativeTimer = async (deviceId) => {
      if (!deviceId) return;

      try {
        await BleClient.stopNotifications(
          deviceId,
          "7520ffff-14d2-4cda-8b6b-697c554c9311",
          "75200001-14d2-4cda-8b6b-697c554c9311"
        );
      } catch (error) {
        console.error("Stop notifications before connect error:", error);
      }

      try {
        await BleClient.disconnect(deviceId);
      } catch (error) {
        console.error("Disconnect before connect error:", error);
      }
    };

    if (nativeDeviceIdRef.current && nativeDeviceIdRef.current !== timer.id) {
      try {
        await cleanupNativeTimer(nativeDeviceIdRef.current);
      } catch (error) {
        console.error("Cleanup stale timer before connect error:", error);
      }

      nativeNotifyActiveRef.current = false;
      nativeDeviceIdRef.current = "";
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await cleanupNativeTimer(timer.id);
    await new Promise((resolve) => setTimeout(resolve, 350));

    const handleDisconnect = () => {
      console.log("Native BLE disconnected");

      nativeNotifyActiveRef.current = false;
      nativeDeviceIdRef.current = "";

      setTimerConnected(false);
      setTimerDeviceName("");
      setTimerStatusMessage("Disconnected");
    };

    let connected = false;

    try {
      await BleClient.connect(timer.id, handleDisconnect, { timeout: 20000 });
      connected = true;
    } catch (initialError) {
      console.warn("Initial native timer connect attempt failed:", initialError);

      await cleanupNativeTimer(timer.id);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await BleClient.connect(timer.id, handleDisconnect, { timeout: 20000 });
      connected = true;
    }

    if (!connected) {
      throw new Error("Unable to connect to timer");
    }

    nativeDeviceIdRef.current = timer.id;
    lastNativeDeviceIdRef.current = timer.id;
    lastNativeDeviceNameRef.current = timer.name || "SG Timer";

    localStorage.setItem("lastDeviceId", timer.id);
    localStorage.setItem("lastDeviceName", timer.name || "SG Timer");

    setTimerConnected(true);
    setTimerDeviceName(timer.name || "SG Timer");
    setTimerStatusMessage(`Connected to ${timer.name || "SG Timer"}`);
    setShowTimerPicker(false);

    await new Promise((resolve) => setTimeout(resolve, 250));
    await subscribeNativeTimerNotifications();
    return true;
  } catch (err) {
    console.error("Native timer connect error:", err);
    nativeDeviceIdRef.current = "";
    nativeNotifyActiveRef.current = false;
    setTimerConnected(false);
    setTimerDeviceName("");
    setTimerStatusMessage(`Failed to connect: ${describeError(err)}`);
    return false;
  } finally {
    nativeManualConnectInProgressRef.current = false;
  }
}

async function scanForTimers() {
  try {
    setScanningTimers(true);
    setTimerStatusMessage("Searching for timers...");

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        SERVICE_UUID, // keep your existing timer service UUID here
      ],
    });

    if (!device) {
      setScanningTimers(false);
      return;
    }

    const pickedDevice = {
      id: device.id,
      name: device.name || "Unknown Timer",
      rawDevice: device,
    };

    setAvailableTimers([pickedDevice]);
    setShowTimerPicker(true);
    setTimerStatusMessage("Select a timer");
  } catch (error) {
    console.error("Timer scan error:", error);
    setTimerStatusMessage("Timer search cancelled or failed");
  } finally {
    setScanningTimers(false);
  }
}

async function connectToChosenTimer(deviceWrapper) {
  try {
    if (!deviceWrapper?.rawDevice) return;

    const device = deviceWrapper.rawDevice;
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const eventChar = await service.getCharacteristic(EVENT_CHARACTERISTIC_UUID);

    await eventChar.startNotifications();
    eventChar.removeEventListener("characteristicvaluechanged", handleTimerEvent);
    eventChar.addEventListener("characteristicvaluechanged", handleTimerEvent);

    setTimerConnected(true);
    setTimerDeviceName(device.name || "SG Timer");
    setTimerStatusMessage(`Connected to ${device.name || "timer"}`);
    setShowTimerPicker(false);

    localStorage.setItem(
      "preferredTimerDevice",
      JSON.stringify({
        id: device.id,
        name: device.name || "SG Timer",
      })
    );
  } catch (error) {
    console.error("Connect chosen timer error:", error);
    setTimerStatusMessage("Failed to connect to selected timer");
  }
}

async function startTimer() {
  try {
    const service = "7520ffff-14d2-4cda-8b6b-697c554c9311";
    const writeCharacteristic = "75200000-14d2-4cda-8b6b-697c554c9311";
    const startCommand = new Uint8Array([0x01, 0x00]);

    if (Capacitor.isNativePlatform()) {
      const deviceId = nativeDeviceIdRef.current;

      if (!deviceId) {
        setTimerStatusMessage("No timer connected");
        return;
      }

      console.log("START CHAR:", writeCharacteristic);
      console.log("START PAYLOAD:", Array.from(startCommand));

      await BleClient.write(
        deviceId,
        service,
        writeCharacteristic,
        startCommand
      );

      setTimerStatusMessage("Start command sent");
      return;
    }

    setTimerStatusMessage("Start is only set up for native right now");
  } catch (err) {
    console.error("Start timer error:", JSON.stringify(err), err);
    setTimerStatusMessage("Start failed");
  }
}

async function stopTimer() {
  try {
    const service = "7520ffff-14d2-4cda-8b6b-697c554c9311";
    const writeCharacteristic = "75200000-14d2-4cda-8b6b-697c554c9311";
    const stopCommand = new Uint8Array([0x01, 0x03]);

    if (Capacitor.isNativePlatform()) {
      const deviceId = nativeDeviceIdRef.current;

      if (!deviceId) {
        setTimerStatusMessage("No timer connected");
        return;
      }

      await BleClient.write(
        deviceId,
        service,
        writeCharacteristic,
        stopCommand
      );

      setTimerStatusMessage("Stop command sent");
      return;
    }

    setTimerStatusMessage("Stop is only set up for native right now");
  } catch (err) {
    console.error("Stop timer error:", JSON.stringify(err), err);
    setTimerStatusMessage("Stop failed");
  }
}

const normalizedShooterSearch = shooterSearch.trim().toLowerCase();

const uniqueShooters = Array.from(
  new Map(
    shooters.map((item) => [
      String(item.ShooterID),
      {
        ...item,
        Name: String(item.Name || "").trim(),
        Level: String(item.Level || "").trim(),
      },
    ])
  ).values()
).sort((a, b) => a.Name.localeCompare(b.Name));

const filteredShooterList = uniqueShooters.filter((item) => {
  if (!normalizedShooterSearch) return true;

  const name = String(item.Name || "").trim().toLowerCase();
  const level = String(item.Level || "").trim().toLowerCase();
  const combined = `${name} ${level}`;

  return (
    name.includes(normalizedShooterSearch) ||
    level.includes(normalizedShooterSearch) ||
    combined.includes(normalizedShooterSearch)
  );
});
  
async function load() {
    try {
      setLoading(true);
      const [s, d, sess, r] = await Promise.all([
        apiGet("shooters"),
        apiGet("drills"),
        apiGet("sessions"),
        apiGet("runs"),
      ]);

      setShooters(s);
      setDrills(d);
      setSessions(sess);
      setRuns(r);
      shootersRef.current = Array.isArray(s) ? s : [];
      drillsRef.current = Array.isArray(d) ? d : [];
      sessionsRef.current = Array.isArray(sess) ? sess : [];
      runsRef.current = Array.isArray(r) ? r : [];

      if (s.length && !selectedShooterRef.current) {
        const nextShooterId = String(s[0].ShooterID);
        setSelectedShooter(nextShooterId);
        selectedShooterRef.current = nextShooterId;
      }

      if (d.length && !selectedDrillRef.current) {
        const nextDrillId = String(d[0].DrillID);
        setSelectedDrill(nextDrillId);
        selectedDrillRef.current = nextDrillId;
      }

      if (sess.length && !selectedSessionRef.current) {
        const nextSessionId = String(sess[0].SessionID);
        setSelectedSession(nextSessionId);
        selectedSessionRef.current = nextSessionId;
      }
    } catch (error) {
      setMessage(`Error loading data: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

useEffect(() => {
  load();
}, []);

async function handleAuthSubmit(event) {
  event?.preventDefault?.();

  if (!isFirebaseConfigured()) {
    setAuthError("Firebase login is not configured yet.");
    return;
  }

  setAuthSubmitting(true);
  setAuthError("");

  try {
    if (authMode === "register") {
      const autoLinkedShooter = findExactShooterMatchByName(shooters, authDisplayName);
      const autoLinkedShooterId = autoLinkedShooter?.ShooterID
        ? String(autoLinkedShooter.ShooterID)
        : "";

      try {
        localStorage.setItem(AUTH_PENDING_ROLE_KEY, "student");
      } catch {
        // ignore local role cache issues
      }

      const credentials = await registerWithEmailPassword({
        email: authEmail,
        password: authPassword,
        displayName: authDisplayName,
        role: "student",
        shooterId: autoLinkedShooterId,
      });

      if (credentials?.user?.uid) {
        const nextProfile = {
          id: credentials.user.uid,
          email: credentials.user.email || authEmail,
          displayName: authDisplayName || credentials.user.displayName || "",
          role: "student",
          shooterId: autoLinkedShooterId,
        };

        setAuthProfile(nextProfile);
        if (autoLinkedShooter) {
          setStudentProfileMessage(`Automatically linked to shooter profile: ${autoLinkedShooter.Name}.`);
        } else {
          setStudentProfileMessage("");
        }

        try {
          localStorage.setItem(`jmt-auth-profile-${credentials.user.uid}`, JSON.stringify(nextProfile));
        } catch {
          // ignore local profile cache issues
        }
      }
    } else {
      await signInWithEmailPassword(authEmail, authPassword);
    }

    setAuthPassword("");
  } catch (error) {
    console.error("Auth submit error:", {
      code: error?.code || "",
      message: error?.message || "",
      name: error?.name || "",
      stack: error?.stack || "",
      raw: error,
    });
    setAuthError(formatErrorMessage(error));
  } finally {
    setAuthSubmitting(false);
  }
}

async function handleSignOut() {
  try {
    await signOutCurrentUser();
    setAuthUser(null);
    setAuthProfile(null);
    setAuthError("");
    try {
      localStorage.removeItem(AUTH_PENDING_ROLE_KEY);
    } catch {
      // ignore local role cache issues
    }
  } catch (error) {
    console.error("Sign out error:", error);
    setAuthError("We could not sign you out right now.");
  }
}

async function handleStudentLinkSave(userId, shooterId) {
  const normalizedUserId = String(userId || "").trim();

  if (!normalizedUserId) return;

  setStudentAccountSavingUid(normalizedUserId);
  setStudentAccountMessage("");

  try {
    const updatedProfile = await withClientTimeout(
      updateUserProfileRecord(normalizedUserId, {
        shooterId,
      }),
      8000,
      "Student link save timed out."
    );

    setStudentAccounts((current) =>
      current.map((profile) =>
        String(profile.id || "") === normalizedUserId
          ? { ...profile, ...(updatedProfile || {}), shooterId: String(shooterId || "").trim() }
          : profile
      )
    );

    setStudentAccountMessage(
      shooterId
        ? "Student account linked to shooter profile."
        : "Student shooter link removed."
    );
  } catch (error) {
    console.error("Student link save error:", error);
    setStudentAccountMessage("We could not save that student link right now.");
  } finally {
    setStudentAccountSavingUid("");
  }
}

async function handleAccountRoleSave(userId, role) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedRole = String(role || "student").trim().toLowerCase() || "student";

  if (!normalizedUserId) return;

  setStudentAccountSavingUid(normalizedUserId);
  setStudentAccountMessage("");

  try {
    const updatedProfile = await withClientTimeout(
      updateUserProfileRecord(normalizedUserId, {
        role: normalizedRole,
      }),
      8000,
      "Account role save timed out."
    );

    setStudentAccounts((current) =>
      current.map((profile) =>
        String(profile.id || "") === normalizedUserId
          ? { ...profile, ...(updatedProfile || {}), role: normalizedRole }
          : profile
      )
    );

    setStudentAccountMessage(
      normalizedRole === "student"
        ? "Account saved as student."
        : "Account saved as instructor."
    );
  } catch (error) {
    console.error("Account role save error:", error);
    setStudentAccountMessage("We could not save that account role right now.");
  } finally {
    setStudentAccountSavingUid("");
  }
}

async function handleAdminCreateAccount() {
  if (!hasAdminAccess) return;

  const normalizedName = String(adminCreateAccountName || "").trim();
  const normalizedEmail = String(adminCreateAccountEmail || "").trim();
  const normalizedPassword = String(adminCreateAccountPassword || "");
  const normalizedRole =
    String(adminCreateAccountRole || "student").trim().toLowerCase() || "student";
  const normalizedShooterId =
    normalizedRole === "student" ? String(adminCreateAccountShooterId || "").trim() : "";

  if (!normalizedName || !normalizedEmail || !normalizedPassword) {
    setStudentAccountMessage("Enter a name, email, and password to create the account.");
    return;
  }

  setAdminCreateAccountSaving(true);
  setStudentAccountMessage("");

  try {
    const result = await withClientTimeout(
      createManagedUserAccount({
        email: normalizedEmail,
        password: normalizedPassword,
        displayName: normalizedName,
        role: normalizedRole,
        shooterId: normalizedShooterId,
      }),
      15000,
      "Managed account creation timed out."
    );

    const createdProfile = result?.profile || null;

    if (createdProfile?.id) {
      setStudentAccounts((current) => {
        const nextAccounts = [...current.filter((profile) => String(profile.id || "") !== String(createdProfile.id || "")), createdProfile];
        return nextAccounts.sort((a, b) => {
          const aName = String(a.displayName || a.email || a.id || "").trim().toLowerCase();
          const bName = String(b.displayName || b.email || b.id || "").trim().toLowerCase();
          return aName.localeCompare(bName);
        });
      });
    }

    setStudentAccountMessage(
      normalizedRole === "student"
        ? "Student account created."
        : "Instructor account created."
    );
    setAdminCreateAccountName("");
    setAdminCreateAccountEmail("");
    setAdminCreateAccountPassword("");
    setAdminCreateAccountRole("student");
    setAdminCreateAccountShooterId("");
    setAdminCreateAccountOpen(false);

    loadStudentAccounts();
  } catch (error) {
    console.error("Managed account creation error:", error);
    setStudentAccountMessage(formatErrorMessage(error));
  } finally {
    setAdminCreateAccountSaving(false);
  }
}

async function handleMakeCurrentAccountStudent() {
  if (!authUser?.uid) return;

  const nextProfile = {
    ...(authProfile || {}),
    id: authUser.uid,
    role: "student",
    email: authUser.email || authProfile?.email || "",
    displayName: authProfile?.displayName || authUser.displayName || "",
    shooterId: authProfile?.shooterId || "",
  };

  setAuthProfile(nextProfile);
  setStudentAccountMessage("This account is now set to Student on this device. Saving to Firebase...");

  try {
    localStorage.setItem(`jmt-auth-profile-${authUser.uid}`, JSON.stringify(nextProfile));
  } catch {
    // ignore local profile cache issues
  }

  try {
    const updatedProfile = await withClientTimeout(
      updateUserProfileRecord(authUser.uid, {
        role: "student",
        email: nextProfile.email,
        displayName: nextProfile.displayName,
        shooterId: nextProfile.shooterId,
      }),
      8000,
      "Current account role save timed out."
    );

    const savedProfile = {
      ...nextProfile,
      ...(updatedProfile || {}),
      id: authUser.uid,
      role: "student",
    };

    setAuthProfile(savedProfile);
    setStudentAccountMessage("This account is now saved as a student account.");

    try {
      localStorage.setItem(`jmt-auth-profile-${authUser.uid}`, JSON.stringify(savedProfile));
    } catch {
      // ignore local profile cache issues
    }
  } catch (error) {
    console.error("Current account role update error:", error);
    setStudentAccountMessage(
      "This device is using Student mode, but Firebase did not save the role yet. Check Firestore rules if it changes back after signing out."
    );
  }
}

async function handleSyncStudentProfile() {
  if (!authUser?.uid) return;

  setStudentProfileSyncing(true);
  setStudentProfileMessage("Saving student profile to Firebase...");

  const nextProfile = {
    ...(authProfile || {}),
    id: authUser.uid,
    email: authUser.email || authProfile?.email || "",
    displayName: authProfile?.displayName || authUser.displayName || "",
    role: "student",
    shooterId: authProfile?.shooterId || "",
  };

  setAuthProfile(nextProfile);

  try {
    const savedProfile = await withClientTimeout(
      updateUserProfileRecord(authUser.uid, {
        email: nextProfile.email,
        displayName: nextProfile.displayName,
        role: "student",
        shooterId: nextProfile.shooterId,
      }),
      8000,
      "Student profile sync timed out."
    );

    const mergedProfile = {
      ...nextProfile,
      ...(savedProfile || {}),
      id: authUser.uid,
      role: "student",
    };

    setAuthProfile(mergedProfile);

    try {
      localStorage.setItem(`jmt-auth-profile-${authUser.uid}`, JSON.stringify(mergedProfile));
    } catch {
      // ignore local profile cache issues
    }

    setStudentProfileMessage("Student profile synced. Sign into the instructor account and press Refresh Students.");
  } catch (error) {
    console.error("Student profile sync error:", error);
    setStudentProfileMessage(
      "Could not sync profile to Firebase. Firestore rules may be blocking profile writes."
    );
  } finally {
    setStudentProfileSyncing(false);
  }
}

useEffect(() => {
  const handleResize = () => {
    setViewportWidth(window.innerWidth);
  };

  window.addEventListener("resize", handleResize);
  return () => window.removeEventListener("resize", handleResize);
}, []);

useEffect(() => {
  try {
    const savedCourseBuilder = localStorage.getItem(COURSE_BUILDER_STORAGE_KEY);

    if (!savedCourseBuilder) return;

    const parsedCourseBuilder = JSON.parse(savedCourseBuilder);
    setCourseBuilderName(parsedCourseBuilder?.name || "New Course");
    setCourseBuilderNotes(parsedCourseBuilder?.notes || "");
    setCourseBuilderStageWidth(Number(parsedCourseBuilder?.stageWidth) || 32);
    setCourseBuilderStageDepth(Number(parsedCourseBuilder?.stageDepth) || 18);
    setCourseBuilderStageTitle(String(parsedCourseBuilder?.stageTitle || "Field Course"));
    setCourseBuilderItems(Array.isArray(parsedCourseBuilder?.items) ? parsedCourseBuilder.items : []);
  } catch (error) {
    console.error("Course builder load error:", error);
  }
}, []);

useEffect(() => {
  try {
    localStorage.setItem(
      COURSE_BUILDER_STORAGE_KEY,
      JSON.stringify({
        name: courseBuilderName,
        notes: courseBuilderNotes,
        stageWidth: courseBuilderStageWidth,
        stageDepth: courseBuilderStageDepth,
        stageTitle: courseBuilderStageTitle,
        items: courseBuilderItems,
      })
    );
  } catch (error) {
    console.error("Course builder save error:", error);
  }
}, [
  courseBuilderItems,
  courseBuilderName,
  courseBuilderNotes,
  courseBuilderStageDepth,
  courseBuilderStageTitle,
  courseBuilderStageWidth,
]);

useEffect(() => {
  if (!isEventDisplayMode) {
    return undefined;
  }

  document.body.classList.add("event-display-mode");
  document.documentElement.classList.add("event-display-mode");

  const rootElement = document.getElementById("root");
  rootElement?.classList.add("event-display-root");

  const refreshIntervalId = window.setInterval(() => {
    load();
  }, 10000);

  const rotationIntervalId = window.setInterval(() => {
    setEventDisplaySlide((current) => (current + 1) % 2);
  }, 7000);

  const clockIntervalId = window.setInterval(() => {
    setEventDisplayNow(new Date());
  }, 1000);

  return () => {
    document.body.classList.remove("event-display-mode");
    document.documentElement.classList.remove("event-display-mode");
    rootElement?.classList.remove("event-display-root");
    window.clearInterval(refreshIntervalId);
    window.clearInterval(rotationIntervalId);
    window.clearInterval(clockIntervalId);
  };
}, [isEventDisplayMode]);

  function toggleSelector(type) {
  setSelectorOpen((current) => (current === type ? null : type));
}
  
function clearRunForm() {
    setTotalTime("");
    setShotCount("");
    setFirstShot("");
    setAvgSplit("");
    setBestSplit("");
    setWorstSplit("");
    setSplitsRaw("");
    setScore("");
    setPassFail("");
    setNotes("");
    setQualificationLevel("");
    setPowerFactor("minor");
    setAHits("");
    setCHits("");
    setDHits("");
    setMisses("");
    setNoShoots("");
    setSteelHits("");
    setSteelMisses("");
    clearVideoSelection();
  }

  function syncMatchSelection(match) {
    if (!match) return;

    const currentShooterId = String(match.shooterIds?.[match.currentIndex || 0] || "");
    const nextDrillId = String(match.drillId || "").trim();
    const nextSessionId = String(match.sessionId || "").trim();

    if (currentShooterId) {
      setSelectedShooter(currentShooterId);
      selectedShooterRef.current = currentShooterId;
    }

    if (nextDrillId) {
      setSelectedDrill(nextDrillId);
      selectedDrillRef.current = nextDrillId;
    }

    if (nextSessionId) {
      setSelectedSession(nextSessionId);
      selectedSessionRef.current = nextSessionId;
    }
  }

  function addShooterToMatchRoster(shooterId) {
    const normalizedId = String(shooterId || "").trim();
    if (!normalizedId) return;

    setMatchRosterIds((current) =>
      current.includes(normalizedId) ? current : [...current, normalizedId]
    );
    setMatchShooterSearch("");
  }

  function removeShooterFromMatchRoster(shooterId) {
    setMatchRosterIds((current) =>
      current.filter((item) => String(item) !== String(shooterId))
    );
  }

  function moveMatchRosterShooter(shooterId, direction) {
    setMatchRosterIds((current) => {
      const currentIndex = current.findIndex((item) => String(item) === String(shooterId));
      if (currentIndex === -1) return current;

      const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const nextRoster = [...current];
      [nextRoster[currentIndex], nextRoster[nextIndex]] = [
        nextRoster[nextIndex],
        nextRoster[currentIndex],
      ];
      return nextRoster;
    });
  }

  function startMatch() {
    if (!matchDrillId || !matchSessionId || matchRosterIds.length === 0) {
      setMessage("Choose a drill, session, and at least one shooter to start a match.");
      return;
    }

    const nextMatch = {
      id: `match-${Date.now()}`,
      name: String(matchNameInput || "").trim() || `Match ${new Date().toLocaleString()}`,
      drillId: String(matchDrillId),
      sessionId: String(matchSessionId),
      shooterIds: [...matchRosterIds],
      currentIndex: 0,
      status: "active",
      createdAt: new Date().toISOString(),
      results: [],
    };

    setActiveMatch(nextMatch);
    syncMatchSelection(nextMatch);
    resetMatchBuilder();
    setSelectorOpen(null);
    clearRunForm();
    setMessage(`Match started. ${findItemById(shooters, nextMatch.shooterIds[0], "ShooterID")?.Name || "First shooter"} is up.`);
    window.requestAnimationFrame(() => {
      setActiveTab("timer");
    });
  }

  function addShooterToQualificationRoster(shooterId) {
    const normalizedShooterId = String(shooterId || "").trim();
    if (!normalizedShooterId) return;

    setQualificationRosterIds((current) =>
      current.includes(normalizedShooterId)
        ? current
        : [...current, normalizedShooterId]
    );
    setQualificationShooterSearch("");
  }

  function removeShooterFromQualificationRoster(shooterId) {
    const normalizedShooterId = String(shooterId || "").trim();
    setQualificationRosterIds((current) =>
      current.filter((id) => String(id) !== normalizedShooterId)
    );
  }

  function startQualification() {
    if (!selectedQualificationConfig || !selectedDrill || !selectedSession || qualificationRosterIds.length === 0) {
      setMessage("Choose a qualification drill, session, and at least one shooter to start.");
      return;
    }

    const nextQualification = {
      id: `qualification-${Date.now()}`,
      name:
        String(selectedDrillData?.DrillName || "").trim() ||
        `Qualification ${new Date().toLocaleString()}`,
      drillId: String(selectedDrill),
      sessionId: String(selectedSession),
      shooterIds: [...qualificationRosterIds],
      distanceIndex: 0,
      distances: qualificationDistances,
      passScore: Number(selectedQualificationConfig.passScore || 0) || 0,
      createdAt: new Date().toISOString(),
      results: [],
      status: "active",
    };

    setActiveQualification(nextQualification);
    setQualificationShooterSearch("");
    setQualificationStageEntries({});
    setMessage(
      `${nextQualification.name} started. Score ${nextQualification.distances?.[0]?.label || "Distance 1"} for all shooters.`
    );
    window.requestAnimationFrame(() => {
      setActiveTab("timer");
    });
  }

  function finishQualification({ silent = false } = {}) {
    if (!activeQualification) return;

    const finishedQualification = {
      ...activeQualification,
      status: "completed",
      completedAt: new Date().toISOString(),
    };

    setActiveQualification(null);
    setQualificationStageEntries({});
    setQualificationRosterIds([]);
    setQualificationShooterSearch("");

    if (!silent) {
      setMessage(`Finished ${finishedQualification.name}.`);
    }
  }

  async function saveQualificationDistance() {
    if (!activeQualification || !activeQualificationDistance) return;

    const incompleteShooter = activeQualification.shooterIds.find((shooterId) => {
      const entry = qualificationStageEntries[String(shooterId)] || {};
      return String(entry.score || "").trim() === "";
    });

    if (incompleteShooter) {
      setMessage("Enter a score for every shooter before advancing.");
      return;
    }

    setQualificationSaving(true);
    setMessage("");

    try {
      const nextDistanceIndex = Number(activeQualification.distanceIndex || 0) + 1;
      const nextResults = [...(activeQualification.results || [])];
      const isFinalDistance =
        nextDistanceIndex >= (activeQualification.distances?.length || 0);

      for (const shooterId of activeQualification.shooterIds) {
        const stageEntry = qualificationStageEntries[String(shooterId)] || {};
        nextResults.push({
          shooterId: String(shooterId),
          distanceIndex: Number(activeQualification.distanceIndex || 0),
          distanceLabel: activeQualificationDistance.label,
          score: Number(stageEntry.score || 0),
          notes: String(stageEntry.notes || "").trim(),
          savedAt: new Date().toISOString(),
        });
      }

      if (isFinalDistance) {
        const groupedResults = new Map();

        nextResults.forEach((entry) => {
          const shooterId = String(entry?.shooterId || "").trim();
          if (!shooterId) return;
          const current =
            groupedResults.get(shooterId) || {
              shooterId,
              totalScore: 0,
              notes: [],
              stages: {},
              allStagesPassed: true,
            };

          const stageNumber = Number(entry?.distanceIndex || 0) + 1;
          const distanceConfig =
            activeQualification.distances?.[Number(entry?.distanceIndex || 0)] || null;
          const stageTarget = getQualificationStageTarget(distanceConfig);
          const stagePassPercent = getQualificationStagePassPercent(distanceConfig);
          const stageThreshold = stageTarget > 0 ? stageTarget * (stagePassPercent / 100) : 0;
          const stagePassed = stageTarget > 0 ? (Number(entry?.score || 0) || 0) >= stageThreshold : true;

          current.totalScore += Number(entry?.score || 0) || 0;
          current.stages[`Stage${stageNumber}Name`] = entry?.distanceLabel || `Stage ${stageNumber}`;
          current.stages[`Stage${stageNumber}Score`] = Number(entry?.score || 0) || 0;
          current.stages[`Stage${stageNumber}Notes`] = String(entry?.notes || "").trim();
          current.allStagesPassed = current.allStagesPassed && stagePassed;
          if (String(entry?.notes || "").trim()) {
            current.notes.push(`${entry.distanceLabel}: ${String(entry.notes).trim()}`);
          }

          groupedResults.set(shooterId, current);
        });

        for (const shooterId of activeQualification.shooterIds) {
          const shooterSummary = groupedResults.get(String(shooterId));
          const shooterName =
            findItemById(shooters, shooterId, "ShooterID")?.Name || String(shooterId);

          if (!shooterSummary) {
            throw new Error(`${shooterName}: Missing final qualification summary.`);
          }

          const savedRun = {
            timestamp: new Date().toISOString(),
            sessionId: activeQualification.sessionId,
            shooterId,
            drillId: activeQualification.drillId,
            totalTime: "",
            shotCount: "",
            totalRounds: "",
            firstShot: "",
            avgSplit: "",
            bestSplit: "",
            worstSplit: "",
            splitsRaw: "",
            source: "qualification",
            score: shooterSummary.totalScore,
            passFail: shooterSummary.allStagesPassed ? "Pass" : "Fail",
            notes: shooterSummary.notes.join(" | "),
            qualificationLevel: "",
            scoringType: "MARKSMANSHIP_QUALIFICATION",
            powerFactor: "",
            aHits: "",
            cHits: "",
            dHits: "",
            misses: "",
            noShoots: "",
            steelHits: "",
            steelMisses: "",
            totalPoints: "",
            hitFactor: "",
            totalTimeRaw: "",
            stageName: activeQualification.name,
            destinationSheet: "Qualifications",
            qualificationName: activeQualification.name,
            totalScore: shooterSummary.totalScore,
            ...shooterSummary.stages,
          };

          const result = await apiSaveRun(savedRun);
          if (!result || result.success !== true) {
            const saveError =
              String(result?.error || result?.message || result?.raw || "").trim() ||
              "Qualification row failed to save.";
            throw new Error(`${shooterName}: ${saveError}`);
          }
        }

        setActiveQualification({
          ...activeQualification,
          results: nextResults,
        });
        finishQualification({ silent: true });
        setMessage(`${activeQualification.name} complete. Qualification rows saved.`);
        await load();
        return;
      }

      setActiveQualification({
        ...activeQualification,
        distanceIndex: nextDistanceIndex,
        results: nextResults,
        updatedAt: new Date().toISOString(),
      });
      setMessage(
        `${activeQualificationDistance.label} saved. Next up: ${
          activeQualification.distances?.[nextDistanceIndex]?.label || "next distance"
        }.`
      );
      await load();
    } catch (error) {
      console.error("Qualification save error:", error);
      setMessage(`Qualification save failed: ${error.message}`);
    } finally {
      setQualificationSaving(false);
    }
  }

  function finishMatch({ silent = false } = {}) {
    if (!activeMatch) return;

    const completedMatch = {
      ...activeMatch,
      status: "completed",
      completedAt: new Date().toISOString(),
    };

    setMatchHistory((current) => [completedMatch, ...current].slice(0, 30));
    setActiveMatch(null);

    if (!silent) {
      setMessage(`Finished ${completedMatch.name}.`);
    }
  }

  function resetMatchBuilder() {
    setMatchNameInput("");
    setMatchDrillId(defaultMatchDrillId);
    setMatchSessionId(defaultMatchSessionId);
    setMatchShooterSearch("");
    setMatchRosterIds([]);
  }

  function handleMatchRunSaved(savedRun) {
    if (!activeMatch) return;

    const currentIndex = Number(activeMatch.currentIndex || 0);
    const currentShooterId = String(activeMatch.shooterIds?.[currentIndex] || "");
    const nextIndex = currentIndex + 1;
    const nextShooterId = String(activeMatch.shooterIds?.[nextIndex] || "");
    const nextResults = [
      ...(activeMatch.results || []).filter(
        (entry) => String(entry.shooterId) !== currentShooterId
      ),
      {
        shooterId: currentShooterId,
        savedAt: new Date().toISOString(),
        totalTime: savedRun?.totalTime ?? savedRun?.TotalTime ?? "",
        score: savedRun?.score ?? savedRun?.Score ?? "",
        passFail: savedRun?.passFail ?? savedRun?.PassFail ?? "",
      },
    ];

    if (!nextShooterId) {
      finishMatch({ silent: true });
      setMessage(`Match complete. ${activeMatch.name} is finished.`);
      clearRunForm();
      return;
    }

    const nextMatch = {
      ...activeMatch,
      currentIndex: nextIndex,
      results: nextResults,
      updatedAt: new Date().toISOString(),
    };

    setActiveMatch(nextMatch);
    syncMatchSelection(nextMatch);
    clearRunForm();
    setMessage(
      `Saved ${findItemById(shooters, currentShooterId, "ShooterID")?.Name || "shooter"}. Next up: ${findItemById(
        shooters,
        nextShooterId,
        "ShooterID"
      )?.Name || "next shooter"}.`
    );
  }

  function skipCurrentMatchShooter() {
    if (!activeMatch) return;

    const nextIndex = Number(activeMatch.currentIndex || 0) + 1;
    const nextShooterId = String(activeMatch.shooterIds?.[nextIndex] || "");

    if (!nextShooterId) {
      finishMatch({ silent: true });
      setMessage(`Match complete. ${activeMatch.name} is finished.`);
      return;
    }

    const nextMatch = {
      ...activeMatch,
      currentIndex: nextIndex,
      updatedAt: new Date().toISOString(),
    };

    setActiveMatch(nextMatch);
    syncMatchSelection(nextMatch);
    clearRunForm();
    setMessage(
      `Skipped ${activeMatchCurrentShooter?.Name || "current shooter"}. Next up: ${
        findItemById(shooters, nextShooterId, "ShooterID")?.Name || "next shooter"
      }.`
    );
  }

  async function saveRun() {
    if (!selectedShooter || !selectedDrill || !selectedSession || !totalTime || !shotCount) {
      setMessage("Please choose shooter, drill, session, time, and shots.");
      return;
    }

    try {
      setSaving(true);
      setMessage("");
// Get selected drill details
const drill = findItemById(drills, selectedDrill, "DrillID");
const qualificationDrill = isQualificationDrill(drill);
const destinationSheet = qualificationDrill ? "Qualifications" : "Runs";

const time = Number(totalTime);
const scoreNum = Number(score);

let computedPassFail = "";
let computedLevel = qualificationLevel;
let uploadResult = { uploaded: false, url: "", mode: "local-only" };
const existingVideoMeta = videoCaptureSessionRef.current.recordedMeta;
const hasVideoAttachment = Boolean(videoFile || videoFilePath || existingVideoMeta);

if (drill) {
  const passTime = Number(drill.PassTime || 0);
  const minScore = Number(drill.MinScore || 0);

  const timePass = passTime ? time <= passTime : true;
  const scorePass = minScore ? scoreNum >= minScore : true;

  computedPassFail = timePass && scorePass ? "Pass" : "Fail";

  if (scoreNum >= 95) computedLevel = "5";
  else if (scoreNum >= 90) computedLevel = "4";
  else if (scoreNum >= 80) computedLevel = "3";
  else if (scoreNum >= 70) computedLevel = "2";
  else if (scoreNum > 0) computedLevel = "1";
}

if (hasVideoAttachment) {
  setVideoStatus(
    isFirebaseConfigured()
      ? "Uploading video to cloud storage..."
      : "Saving run with local-only video data. Add Firebase config to enable permanent cloud upload."
  );

  try {
    const uploadFile = await buildUploadFile({
      file: videoFile,
      filePath: videoFilePath || existingVideoMeta?.localFilePath || "",
      fileName: videoFileName || existingVideoMeta?.name || "",
    });

    uploadResult = await uploadVideoAttachment(uploadFile, {
      shooterId: selectedShooter,
      drillId: selectedDrill,
      sessionId: selectedSession,
      source: "manual",
    });
    if (uploadResult.uploaded) {
      setVideoUploadedUrl(uploadResult.url);
      setVideoStatus("Video uploaded successfully.");
    }
    } catch (error) {
      console.error("Video upload error:", error);
      setVideoStatus(`Video upload failed. ${describeError(error)}`);
    }
  }
      console.log("Selected values:", {
  sessionId: selectedSession,
  shooterId: selectedShooter,
  drillId: selectedDrill,
});
const uspsaPoints = usesStageScoring ? uspsaScore.points : "";
const uspsaHitFactor = usesStageScoring ? uspsaScore.hitFactor : "";
const shooterTotalRounds = calculateShooterTotalRounds(
  runs,
  selectedShooter,
  Number(shotCount || 0)
);
const videoMeta = hasVideoAttachment
  ? {
      name: videoFile?.name || videoFileName || existingVideoMeta?.name || "recorded-run.mov",
      type: videoFile?.type || existingVideoMeta?.type || "video/quicktime",
      size: videoFile?.size || existingVideoMeta?.size || "",
      duration: parseNumber(videoDuration) || existingVideoMeta?.duration || "",
      storage: uploadResult.uploaded ? "cloud" : "local-only",
      url: uploadResult.url,
      rawUrl: uploadResult.rawUrl || existingVideoMeta?.rawUrl || "",
      localFilePath: existingVideoMeta?.localFilePath || videoFilePath || "",
      uploadedAt: uploadResult.uploaded ? new Date().toISOString() : "",
      status: uploadResult.uploaded ? "Uploaded" : "Local only",
      savedAt: new Date().toISOString(),
    }
  : null;
const run = {
  timestamp: new Date().toISOString(),
  sessionId: selectedSession,
  shooterId: selectedShooter,
  drillId: selectedDrill,
  totalTime: Number(totalTime),
  shotCount: Number(shotCount),
  firstShot: parseNumber(firstShot),
  avgSplit: formatSplitCellValue(avgSplit),
  bestSplit: formatSplitCellValue(bestSplit),
  worstSplit: formatSplitCellValue(worstSplit),
  splitsRaw: splitsRaw
    .split(",")
    .map((part) => formatSplitForExport(part.trim()))
    .filter(Boolean)
    .join(", "),
  source: "manual",
  score: usesStageScoring ? uspsaPoints : parseNumber(score),
  passFail: computedPassFail,
  notes: notes.trim(),
  qualificationLevel: computedLevel,
  videoUrl: videoMeta?.url || "",
  videoRawUrl: videoMeta?.rawUrl || "",
  videoFileName: videoMeta?.name || "",
  scoringType: stageScoringSessionType,
powerFactor: usesStageScoring ? powerFactor : "",
aHits: usesStageScoring ? Number(aHits || 0) : "",
cHits: usesStageScoring ? Number(cHits || 0) : "",
dHits: usesStageScoring ? Number(dHits || 0) : "",
misses: usesStageScoring ? Number(misses || 0) : "",
noShoots: usesStageScoring ? Number(noShoots || 0) : "",
steelHits: usesStageScoring ? Number(steelHits || 0) : "",
steelMisses: usesStageScoring ? Number(steelMisses || 0) : "",
totalPoints: uspsaPoints,
hitFactor: uspsaHitFactor,
totalRounds: shooterTotalRounds,
destinationSheet,
};

console.log("RUN BEING SENT:", run);

let result = null;

if (!isSavingRef.current) {
  isSavingRef.current = true;

  try {
    result = await apiSaveRun(run);
  } catch (e) {
    console.error("Save error:", e);
  }

  isSavingRef.current = false;
}

console.log("SAVE RESPONSE:", result);

if (result && result.success === true) {
        setMessage(
          qualificationDrill
            ? "Qualification entry saved to Google Sheets."
            : "Run saved to Google Sheets."
        );
        handleMatchRunSaved(run);
        clearRunForm();
        await load();
      } else {
        console.log("Save response:", result);
        setMessage("Run did not save. Check browser console.");
      }
    } catch (error) {
      console.error("Save error:", error);
      setMessage(`Error saving run: ${error.message}`);
    } finally {
      setSaving(false);
    }
  }

  const stageScoringSessionType = getStageScoringSessionType(selectedSessionData, selectedSession);
  const isUspsaSession = stageScoringSessionType === "USPSA";
  const usesStageScoring = Boolean(stageScoringSessionType);

  useEffect(() => {
  const sessionName = String(selectedSessionData?.SessionName || "").trim().toLowerCase();

  if (!isUspsaSessionName(sessionName)) return;

  const uspsaCourseDrill = drills.find(
    (d) => String(d.DrillName || "").trim().toLowerCase() === "course"
  );

  if (!uspsaCourseDrill) return;

  
}, [selectedSessionData, drills, selectedDrill]);

  const leaderboardRunMeta = useMemo(() => {
    return runs.map((run) => {
      const session = findItemById(sessions, run.SessionID, "SessionID");
      const sessionName = String(
        session?.SessionName || session?.Name || run.SessionID || ""
      ).trim();
      const explicitScoringType = String(run.ScoringType || run.scoringType || "")
        .trim()
        .toUpperCase();
      const isUspsaRun =
        explicitScoringType === "USPSA" || isUspsaSessionName(sessionName);
      const stageName = String(run.StageName || run.stageName || "").trim();

      return {
        ...run,
        _dateKey: formatRunDateKey(run.Timestamp),
        _sessionName: sessionName,
        _isTraining: isTrainingSessionName(sessionName),
        _isUspsa: isUspsaRun,
        _stageName: stageName,
      };
    });
  }, [runs, sessions]);

  const getRunBoardInfo = useCallback(
    (run) => {
      const drill = findItemById(drills, run.DrillID, "DrillID");
      const drillId = String(run.DrillID || run._stageName || "").trim();
      const drillName =
        String(drill?.DrillName || run._stageName || run.DrillID || "Unknown Drill").trim();

      if (!run._dateKey || !drillId || !drillName) {
        return null;
      }

      return {
        value: `${run._dateKey}__${drillId}`,
        dateKey: run._dateKey,
        drillId,
        drillName,
        label: `${formatRunDateLabel(run._dateKey)} / ${drillName}`,
      };
    },
    [drills]
  );

  const trainingLeaderboardBoardOptions = useMemo(() => {
    const optionMap = new Map();

    leaderboardRunMeta
      .filter((run) => run._isTraining)
      .forEach((run) => {
        const board = getRunBoardInfo(run);
        if (!board || optionMap.has(board.value)) return;
        optionMap.set(board.value, board);
      });

    return [...optionMap.values()].sort(
      (a, b) => b.dateKey.localeCompare(a.dateKey) || a.drillName.localeCompare(b.drillName)
    );
  }, [getRunBoardInfo, leaderboardRunMeta]);

  const uspsaLeaderboardBoardOptions = useMemo(() => {
    const optionMap = new Map();

    leaderboardRunMeta
      .filter((run) => run._isUspsa)
      .forEach((run) => {
        const board = getRunBoardInfo(run);
        if (!board || optionMap.has(board.value)) return;
        optionMap.set(board.value, board);
      });

    return [...optionMap.values()].sort(
      (a, b) => b.dateKey.localeCompare(a.dateKey) || a.drillName.localeCompare(b.drillName)
    );
  }, [getRunBoardInfo, leaderboardRunMeta]);

  const selectedTrainingLeaderboardBoard = useMemo(
    () =>
      trainingLeaderboardBoardOptions.find((option) => option.value === trainingLeaderboardBoard) ||
      null,
    [trainingLeaderboardBoard, trainingLeaderboardBoardOptions]
  );

  const selectedUspsaLeaderboardBoard = useMemo(
    () =>
      uspsaLeaderboardBoardOptions.find((option) => option.value === uspsaLeaderboardBoard) || null,
    [uspsaLeaderboardBoard, uspsaLeaderboardBoardOptions]
  );

  useEffect(() => {
    if (!trainingLeaderboardBoardOptions.length) {
      if (trainingLeaderboardBoard) setTrainingLeaderboardBoard("");
      return;
    }

    if (!trainingLeaderboardBoardOptions.some((option) => option.value === trainingLeaderboardBoard)) {
      setTrainingLeaderboardBoard(trainingLeaderboardBoardOptions[0].value);
    }
  }, [trainingLeaderboardBoard, trainingLeaderboardBoardOptions]);

  useEffect(() => {
    if (!uspsaLeaderboardBoardOptions.length) {
      if (uspsaLeaderboardBoard) setUspsaLeaderboardBoard("");
      return;
    }

    if (!uspsaLeaderboardBoardOptions.some((option) => option.value === uspsaLeaderboardBoard)) {
      setUspsaLeaderboardBoard(uspsaLeaderboardBoardOptions[0].value);
    }
  }, [uspsaLeaderboardBoard, uspsaLeaderboardBoardOptions]);

  const trainingLeaderboard = useMemo(() => {
    return shooters
      .map((shooter) => {
        const shooterRuns = leaderboardRunMeta.filter(
          (run) =>
            run._isTraining &&
            String(run.ShooterID) === String(shooter.ShooterID) &&
            (!selectedTrainingLeaderboardBoard ||
              (run._dateKey === selectedTrainingLeaderboardBoard.dateKey &&
                String(run.DrillID) === String(selectedTrainingLeaderboardBoard.drillId)))
        );

        if (!shooterRuns.length) return null;

        const times = shooterRuns
          .map((run) => Number(run.TotalTime))
          .filter((value) => !Number.isNaN(value) && value > 0);

        if (!times.length) return null;

        const best = Math.min(...times);
        const average = times.reduce((sum, value) => sum + value, 0) / times.length;
        const latest = Number(shooterRuns[shooterRuns.length - 1]?.TotalTime || 0);
        const detailRun =
          [...shooterRuns]
            .filter((run) => {
              const total = Number(run.TotalTime);
              return !Number.isNaN(total) && total > 0;
            })
            .sort((a, b) => Number(a.TotalTime) - Number(b.TotalTime))[0] || shooterRuns[0];
        const passCount = shooterRuns.filter(
          (run) => String(run.PassFail || "").trim().toLowerCase() === "pass"
        ).length;

        return {
          shooterId: shooter.ShooterID,
          name: shooter.Name,
          level: shooter.Level,
          best: best.toFixed(2),
          avg: average.toFixed(2),
          latest: latest ? latest.toFixed(2) : "-",
          attempts: times.length,
          passCount,
          detailRun,
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.best) - Number(b.best));
  }, [leaderboardRunMeta, selectedTrainingLeaderboardBoard, shooters]);

  const selectedProgress = useMemo(() => {
    return runs
      .filter(
        (r) =>
          String(r.ShooterID) === String(selectedShooter) &&
          String(r.DrillID) === String(selectedDrill)
      )
      .slice()
      .sort((a, b) => String(getRunTimestamp(a)).localeCompare(String(getRunTimestamp(b))));
  }, [runs, selectedShooter, selectedDrill]);

  const recentRunsSorted = useMemo(() => {
    return [...runs].sort(
      (a, b) =>
        (parseTimestampValue(getRunTimestamp(b))?.getTime() || 0) -
        (parseTimestampValue(getRunTimestamp(a))?.getTime() || 0)
    );
  }, [runs]);

  const filteredRecentRuns = useMemo(() => {
    const results = recentRunsSorted
      .filter((run) => (filterShooter === "all" ? true : String(run.ShooterID) === String(filterShooter)))
      .filter((run) => (filterDrill === "all" ? true : String(run.DrillID) === String(filterDrill)))
      .filter((run) => (filterSession === "all" ? true : String(run.SessionID) === String(filterSession)))
      .filter((run) => {
        if (filterPassFail === "all") return true;
        return String(run.PassFail || "").toLowerCase() === String(filterPassFail).toLowerCase();
      })
      .slice(0, 20);

    if (
      results.length === 0 &&
      recentRunsSorted.length > 0 &&
      filterShooter === "all" &&
      filterDrill === "all" &&
      filterSession === "all" &&
      filterPassFail === "all"
    ) {
      return recentRunsSorted.slice(0, 20);
    }

    return results;
  }, [recentRunsSorted, filterShooter, filterDrill, filterSession, filterPassFail]);

  useEffect(() => {
    if (filterShooter !== "all" && !shooters.some((shooter) => String(shooter.ShooterID) === String(filterShooter))) {
      setFilterShooter("all");
    }
  }, [filterShooter, shooters]);

  useEffect(() => {
    if (filterDrill !== "all" && !drills.some((drill) => String(drill.DrillID) === String(filterDrill))) {
      setFilterDrill("all");
    }
  }, [drills, filterDrill]);

  useEffect(() => {
    if (
      filterSession !== "all" &&
      !sessions.some((session) => String(session.SessionID) === String(filterSession))
    ) {
      setFilterSession("all");
    }
  }, [filterSession, sessions]);

  useEffect(() => {
    if (!["all", "Pass", "Fail"].includes(String(filterPassFail))) {
      setFilterPassFail("all");
    }
  }, [filterPassFail]);

  const qualificationSummary = useMemo(() => {
    const currentRuns = runs.filter(
      (r) =>
        String(r.ShooterID) === String(selectedShooter) &&
        String(r.DrillID) === String(selectedDrill)
    );

    const passRuns = currentRuns.filter((r) => String(r.PassFail || "").toLowerCase() === "pass");
    const failRuns = currentRuns.filter((r) => String(r.PassFail || "").toLowerCase() === "fail");

    return {
      total: currentRuns.length,
      passed: passRuns.length,
      failed: failRuns.length,
      lastQualification: currentRuns[currentRuns.length - 1]?.QualificationLevel || "-",
    };
  }, [runs, selectedShooter, selectedDrill]);

  const statCards = useMemo(() => {
    const drillSpecificRuns = runs.filter(
      (r) =>
        String(r.ShooterID) === String(selectedShooter) &&
        String(r.DrillID) === String(selectedDrill)
    );

    const shooterWideRuns = runs.filter(
      (r) => String(r.ShooterID) === String(selectedShooter)
    );

    const times = drillSpecificRuns
      .map((r) => Number(r.TotalTime))
      .filter((n) => !Number.isNaN(n) && n > 0);

    const bestSplits = shooterWideRuns
      .map((r) => parseSplitNumber(r.BestSplit))
      .filter((n) => !Number.isNaN(n) && n > 0);

    const bestFirstShots = shooterWideRuns
      .map((r) => Number(r.FirstShot))
      .filter((n) => !Number.isNaN(n) && n > 0);

    const totalRounds = shooterWideRuns.reduce((sum, run) => {
      const shotValue = Number(run.ShotCount || run.shotCount || 0);
      return sum + (Number.isNaN(shotValue) ? 0 : shotValue);
    }, 0);

    return {
      attempts: drillSpecificRuns.length,
      best: times.length ? Math.min(...times).toFixed(2) : "-",
      average: times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(2) : "-",
      bestFirstShot: bestFirstShots.length ? Math.min(...bestFirstShots).toFixed(2) : "-",
      bestSplit: bestSplits.length ? Math.min(...bestSplits).toFixed(2) : "-",
      totalRounds,
    };
  }, [runs, selectedShooter, selectedDrill]);

  const BUILDER_STAGE_WIDTH_PX = 980;
  const BUILDER_STAGE_HEIGHT_PX = 620;
  const builderTools = [
    { key: "target", label: "USPSA Target", shortLabel: "Target", accent: "#c8a36a" },
    { key: "no-shoot", label: "No Shoot", shortLabel: "No Shoot", accent: "#f59e9e" },
    { key: "steel", label: "Steel Popper", shortLabel: "Steel", accent: "#89c2ff" },
    { key: "position", label: "Start Box", shortLabel: "Position", accent: "#9be4b1" },
    { key: "fault-line", label: "Fault Line", shortLabel: "Fault", accent: "#ffd68a" },
    { key: "wall", label: "Wall", shortLabel: "Wall", accent: "#c7b6ff" },
    { key: "mesh-wall", label: "Mesh Wall", shortLabel: "Mesh", accent: "#f0b77e" },
    { key: "port", label: "Port / Opening", shortLabel: "Port", accent: "#9dd8c5" },
    { key: "barricade", label: "Barricade", shortLabel: "Barricade", accent: "#f3c17c" },
    { key: "barrel-stack", label: "Barrels", shortLabel: "Barrels", accent: "#d7ddd2" },
  ];

  const builderTypeConfig = {
    target: { width: 54, height: 72, depth: 20, color: "#c8a36a", previewHeight: 96, group: "targets" },
    "no-shoot": { width: 56, height: 74, depth: 20, color: "#f59e9e", previewHeight: 98, group: "noShoots" },
    steel: { width: 42, height: 68, depth: 18, color: "#89c2ff", previewHeight: 78, group: "steel" },
    position: { width: 96, height: 58, depth: 12, color: "#9be4b1", previewHeight: 16, group: "positions" },
    "fault-line": { width: 108, height: 16, depth: 8, color: "#ffd68a", previewHeight: 8, group: "faultLines" },
    wall: { width: 132, height: 16, depth: 14, color: "#c7b6ff", previewHeight: 84, group: "walls" },
    "mesh-wall": { width: 132, height: 18, depth: 14, color: "#f0b77e", previewHeight: 84, group: "meshWalls" },
    port: { width: 124, height: 88, depth: 14, color: "#9dd8c5", previewHeight: 96, group: "ports" },
    barricade: { width: 108, height: 92, depth: 16, color: "#f3c17c", previewHeight: 110, group: "barricades" },
    "barrel-stack": { width: 68, height: 68, depth: 20, color: "#d7ddd2", previewHeight: 70, group: "barrels" },
  };

  const courseBuilderSummary = useMemo(() => {
    return courseBuilderItems.reduce(
      (summary, item) => {
        const key = builderTypeConfig[item.type]?.group;
        if (key) {
          summary[key] += 1;
        }
        summary.total += 1;
        return summary;
      },
      {
        targets: 0,
        noShoots: 0,
        steel: 0,
        positions: 0,
        faultLines: 0,
        walls: 0,
        meshWalls: 0,
        ports: 0,
        barricades: 0,
        barrels: 0,
        total: 0,
      }
    );
  }, [courseBuilderItems]);

  const selectedCourseBuilderItem = useMemo(
    () => courseBuilderItems.find((item) => item.id === courseBuilderSelectedId) || null,
    [courseBuilderItems, courseBuilderSelectedId]
  );

  const isCompactBuilderLayout = viewportWidth < 960;
  const isDesktopBuilderLayout = viewportWidth >= 1280;

  const courseBuilderPayload = useMemo(
    () => ({
      version: 2,
      name: courseBuilderName,
      notes: courseBuilderNotes,
      stageTitle: courseBuilderStageTitle,
      stageWidth: courseBuilderStageWidth,
      stageDepth: courseBuilderStageDepth,
      items: courseBuilderItems,
    }),
    [
      courseBuilderItems,
      courseBuilderName,
      courseBuilderNotes,
      courseBuilderStageDepth,
      courseBuilderStageTitle,
      courseBuilderStageWidth,
    ]
  );

  const courseBuilderExportCode = useMemo(() => {
    try {
      return JSON.stringify(courseBuilderPayload);
    } catch {
      return "";
    }
  }, [courseBuilderPayload]);

  function getCourseItemCount(type) {
    return courseBuilderItems.filter((item) => item.type === type).length;
  }

  function createCourseBuilderItem(type, x, y) {
    const normalizedType = String(type || "target");
    const config = builderTypeConfig[normalizedType] || builderTypeConfig.target;
    const safeX = Math.max(config.width / 2, Math.min(BUILDER_STAGE_WIDTH_PX - config.width / 2, x));
    const safeY = Math.max(config.height / 2, Math.min(BUILDER_STAGE_HEIGHT_PX - config.height / 2, y));

    return {
      id: `${normalizedType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: normalizedType,
      x: safeX,
      y: safeY,
      rotation: 0,
      width: config.width,
      height: config.height,
      depth: config.depth,
      previewHeight: config.previewHeight,
      label:
        normalizedType === "target"
          ? `T${getCourseItemCount("target") + 1}`
        : normalizedType === "steel"
          ? `S${getCourseItemCount("steel") + 1}`
          : normalizedType === "no-shoot"
          ? `NS${getCourseItemCount("no-shoot") + 1}`
          : normalizedType === "position"
          ? `P${getCourseItemCount("position") + 1}`
        : normalizedType === "fault-line"
          ? `FL${getCourseItemCount("fault-line") + 1}`
        : normalizedType === "mesh-wall"
          ? `MW${getCourseItemCount("mesh-wall") + 1}`
        : normalizedType === "port"
          ? `PT${getCourseItemCount("port") + 1}`
        : normalizedType === "barricade"
          ? `B${getCourseItemCount("barricade") + 1}`
        : normalizedType === "barrel-stack"
          ? `BR${getCourseItemCount("barrel-stack") + 1}`
          : `W${getCourseItemCount("wall") + 1}`,
      assignedTargetIds: normalizedType === "position" ? [] : undefined,
    };
  }

  function updateCourseBuilderItem(itemId, changes) {
    setCourseBuilderItems((current) =>
      current.map((item) =>
        item.id === itemId
          ? {
              ...item,
              ...changes,
            }
          : item
      )
    );
  }

  function addCourseBuilderItemAt(type, x, y) {
    const nextItem = createCourseBuilderItem(type, x, y);
    setCourseBuilderItems((current) => [...current, nextItem]);
    setCourseBuilderSelectedId(nextItem.id);
  }

  function moveCourseBuilderItem(itemId, x, y) {
    const targetItem = courseBuilderItems.find((item) => item.id === itemId);
    const targetConfig = targetItem
      ? builderTypeConfig[targetItem.type] || builderTypeConfig.target
      : builderTypeConfig.target;
    const halfWidth = (targetItem?.width || targetConfig.width) / 2;
    const halfHeight = (targetItem?.height || targetConfig.height) / 2;

    updateCourseBuilderItem(itemId, {
      x: Math.max(halfWidth, Math.min(BUILDER_STAGE_WIDTH_PX - halfWidth, x)),
      y: Math.max(halfHeight, Math.min(BUILDER_STAGE_HEIGHT_PX - halfHeight, y)),
    });
  }

  function clearCourseBuilderLayout() {
    setCourseBuilderItems([]);
    setCourseBuilderSelectedId(null);
    setCourseBuilderNotes("");
    setCourseBuilderName("New Course");
    setCourseBuilderStageTitle("Field Course");
    setCourseBuilderStageWidth(32);
    setCourseBuilderStageDepth(18);
    setCourseBuilderTransferCode("");
  }

  function duplicateSelectedCourseItem() {
    if (!selectedCourseBuilderItem) return;

    const duplicated = {
      ...selectedCourseBuilderItem,
      id: `${selectedCourseBuilderItem.type}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      x: Math.min(BUILDER_STAGE_WIDTH_PX - 40, selectedCourseBuilderItem.x + 28),
      y: Math.min(BUILDER_STAGE_HEIGHT_PX - 40, selectedCourseBuilderItem.y + 28),
      label: `${selectedCourseBuilderItem.label} Copy`,
    };

    setCourseBuilderItems((current) => [...current, duplicated]);
    setCourseBuilderSelectedId(duplicated.id);
  }

  function removeSelectedCourseItem() {
    if (!courseBuilderSelectedId) return;

    setCourseBuilderItems((current) =>
      current.filter((item) => item.id !== courseBuilderSelectedId)
    );
    setCourseBuilderSelectedId(null);
  }

  async function copyCourseBuilderCode() {
    if (!courseBuilderExportCode) {
      setMessage("No course code available to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(courseBuilderExportCode);
      setMessage("Course code copied. Paste it into the app on another device to load the same stage.");
    } catch (error) {
      setCourseBuilderTransferCode(courseBuilderExportCode);
      setMessage("Copy was blocked. The course code is shown below so you can copy it manually.");
    }
  }

  function loadCourseBuilderCode() {
    try {
      const parsedCourse = JSON.parse(courseBuilderTransferCode);

      if (!Array.isArray(parsedCourse?.items)) {
        throw new Error("Missing course items");
      }

      setCourseBuilderName(parsedCourse.name || "Imported Course");
      setCourseBuilderNotes(parsedCourse.notes || "");
      setCourseBuilderStageTitle(parsedCourse.stageTitle || "Imported Stage");
      setCourseBuilderStageWidth(Number(parsedCourse.stageWidth) || 32);
      setCourseBuilderStageDepth(Number(parsedCourse.stageDepth) || 18);
      setCourseBuilderItems(
        parsedCourse.items.map((item) => {
          const config = builderTypeConfig[item.type] || builderTypeConfig.target;
          return {
            ...item,
            width: Number(item.width) || config.width,
            height: Number(item.height) || config.height,
            depth: Number(item.depth) || config.depth,
            previewHeight: Number(item.previewHeight) || config.previewHeight,
            assignedTargetIds:
              item.type === "position" && Array.isArray(item.assignedTargetIds)
                ? item.assignedTargetIds
                : item.type === "position"
                  ? []
                  : undefined,
          };
        })
      );
      setCourseBuilderSelectedId(null);
      setMessage("Course code loaded.");
    } catch (error) {
      setMessage("Could not load that course code.");
    }
  }

  function handleUseCourse(course) {
    if (!course) return;

    const nextDrillId = String(course.drillId || "").trim();
    const matchingDrill = drills.find((item) => String(item.DrillID) === nextDrillId);
    const nextSessionId = String(course.sessionId || "").trim();
    const matchingSession =
      sessions.find((session) => String(session.SessionID) === nextSessionId) ||
      sessions.find((session) =>
        String(session?.SessionName || session?.Name || session?.SessionID)
          .trim()
          .toLowerCase() === String(course.sessionType || "").trim().toLowerCase()
      ) ||
      null;

    if (matchingDrill) {
      setSelectedDrill(nextDrillId);
      selectedDrillRef.current = nextDrillId;
    }

    if (matchingSession) {
      const resolvedSessionId = String(matchingSession.SessionID);
      setSelectedSession(resolvedSessionId);
      selectedSessionRef.current = resolvedSessionId;
    }

    setActiveCourseId(String(course.id || ""));
    setActiveTab("timer");

    if (matchingDrill && matchingSession) {
      setMessage(
        `Loaded ${course.title || "course"} with ${matchingDrill.DrillName} and ${matchingSession.SessionName}.`
      );
    } else if (matchingDrill) {
      setMessage(`Loaded ${course.title || "course"} and set drill to ${matchingDrill.DrillName}.`);
    } else if (matchingSession) {
      setMessage(`Loaded ${course.title || "course"} and set session to ${matchingSession.SessionName}.`);
    } else {
      setMessage(`Loaded ${course.title || "course"}. Assign a drill and session before starting.`);
    }
  }

  const uspsaRuns = leaderboardRunMeta.filter((run) => run._isUspsa);

const filteredUspsaRuns = uspsaRuns.filter((run) => {
  if (!selectedUspsaLeaderboardBoard) return true;

  return (
    run._dateKey === selectedUspsaLeaderboardBoard.dateKey &&
    String(run.DrillID || run._stageName || "") === String(selectedUspsaLeaderboardBoard.drillId)
  );
});

const uspsaStageLeaderboardRaw = Object.values(
  filteredUspsaRuns.reduce((acc, run) => {
    const shooterId = String(run.ShooterID || run.shooterId || "");
    if (!shooterId) return acc;

    const shooter = findItemById(shooters, shooterId, "ShooterID");

    const totalTime = Number(run.TotalTime || run.totalTime || 0);
    const totalPoints = Number(
      run.TotalPoints || run.totalPoints || run.Score || run.score || 0
    );
    const hitFactor = Number(run.HitFactor || run.hitFactor || 0);

    if (!acc[shooterId]) {
      acc[shooterId] = {
        shooterId,
        shooterName: shooter?.Name || shooterId || "-",
        runs: 0,
        fastestTime: 0,
        totalPoints: 0,
        bestHitFactor: 0,
        detailRun: null,
      };
    }

    acc[shooterId].runs += 1;
    acc[shooterId].totalPoints += totalPoints;

    if (totalTime > 0) {
      if (acc[shooterId].fastestTime === 0 || totalTime < acc[shooterId].fastestTime) {
        acc[shooterId].fastestTime = totalTime;
      }
    }

    if (hitFactor > acc[shooterId].bestHitFactor) {
      acc[shooterId].bestHitFactor = hitFactor;
      acc[shooterId].detailRun = run;
    }

    return acc;
  }, {})
);

const bestStageHF =
  uspsaStageLeaderboardRaw.length > 0
    ? Math.max(...uspsaStageLeaderboardRaw.map((row) => row.bestHitFactor || 0))
    : 0;

const uspsaStageRankings = uspsaStageLeaderboardRaw
  .map((row) => ({
    ...row,
    stagePercent:
      bestStageHF > 0
        ? Number(((row.bestHitFactor / bestStageHF) * 100).toFixed(2))
        : 0,
  }))
  .sort((a, b) => b.stagePercent - a.stagePercent);

  const eventDisplayRuns = useMemo(() => leaderboardRunMeta, [leaderboardRunMeta]);
  const eventDisplayTrainingBoardOptions = trainingLeaderboardBoardOptions;
  const eventDisplayUspsaBoardOptions = uspsaLeaderboardBoardOptions;
  const eventDisplayBoardOptions = useMemo(
    () => [
      ...eventDisplayTrainingBoardOptions.map((option) => ({
        ...option,
        mode: "training",
        combinedValue: `training::${option.value}`,
      })),
      ...eventDisplayUspsaBoardOptions.map((option) => ({
        ...option,
        mode: "uspsa",
        combinedValue: `uspsa::${option.value}`,
      })),
    ],
    [eventDisplayTrainingBoardOptions, eventDisplayUspsaBoardOptions]
  );
  const eventDisplayBoardDropdownOptions = useMemo(
    () => [
      {
        combinedValue: "__all__",
        mode: "all",
        label: "All Leaderboards",
      },
      ...eventDisplayBoardOptions,
    ],
    [eventDisplayBoardOptions]
  );

  const selectedEventDisplayTrainingBoard = useMemo(
    () =>
      eventDisplayTrainingBoardOptions.find((option) => option.value === eventDisplayTrainingBoard) ||
      null,
    [eventDisplayTrainingBoard, eventDisplayTrainingBoardOptions]
  );

  const selectedEventDisplayUspsaBoard = useMemo(
    () =>
      eventDisplayUspsaBoardOptions.find((option) => option.value === eventDisplayUspsaBoard) || null,
    [eventDisplayUspsaBoard, eventDisplayUspsaBoardOptions]
  );
  const activeEventDisplayBoardKey =
    eventDisplayLeaderboardMode === "training"
      ? `training::${eventDisplayTrainingBoard || ""}`
      : `uspsa::${eventDisplayUspsaBoard || ""}`;
  const selectedEventDisplayBoard = useMemo(
    () =>
      eventDisplayBoardOptions.find((option) => option.combinedValue === activeEventDisplayBoardKey) ||
      null,
    [activeEventDisplayBoardKey, eventDisplayBoardOptions]
  );
  const isEventDisplayRotatingAll = eventDisplayBoardSelection === "__all__";
  const selectedEventDisplayBoardOption = useMemo(
    () =>
      eventDisplayBoardDropdownOptions.find(
        (option) => option.combinedValue === eventDisplayBoardSelection
      ) || null,
    [eventDisplayBoardDropdownOptions, eventDisplayBoardSelection]
  );

  useEffect(() => {
    eventDisplayBoardOptionsRef.current = eventDisplayBoardOptions;
  }, [eventDisplayBoardOptions]);

  useEffect(() => {
    activeEventDisplayBoardKeyRef.current = activeEventDisplayBoardKey;
  }, [activeEventDisplayBoardKey]);

  useEffect(() => {
    if (!eventDisplayTrainingBoardOptions.length) {
      if (eventDisplayTrainingBoard) setEventDisplayTrainingBoard("");
      return;
    }

    if (!eventDisplayTrainingBoardOptions.some((option) => option.value === eventDisplayTrainingBoard)) {
      setEventDisplayTrainingBoard(eventDisplayTrainingBoardOptions[0].value);
    }
  }, [eventDisplayTrainingBoard, eventDisplayTrainingBoardOptions]);

  useEffect(() => {
    if (!eventDisplayUspsaBoardOptions.length) {
      if (eventDisplayUspsaBoard) setEventDisplayUspsaBoard("");
      return;
    }

    if (!eventDisplayUspsaBoardOptions.some((option) => option.value === eventDisplayUspsaBoard)) {
      setEventDisplayUspsaBoard(eventDisplayUspsaBoardOptions[0].value);
    }
  }, [eventDisplayUspsaBoard, eventDisplayUspsaBoardOptions]);

  useEffect(() => {
    if (!eventDisplayBoardOptions.length) return;

    const currentBoardExists = eventDisplayBoardOptions.some(
      (option) => option.combinedValue === activeEventDisplayBoardKey
    );

    if (!currentBoardExists) {
      const firstBoard = eventDisplayBoardOptions[0];

      if (firstBoard.mode === "training") {
        setEventDisplayLeaderboardMode("training");
        setEventDisplayTrainingBoard(firstBoard.value);
      } else {
        setEventDisplayLeaderboardMode("uspsa");
        setEventDisplayUspsaBoard(firstBoard.value);
      }
    }
  }, [activeEventDisplayBoardKey, eventDisplayBoardOptions]);

  useEffect(() => {
    if (eventDisplayBoardSelection === "__all__") return;

    const selectedBoard = eventDisplayBoardOptions.find(
      (option) => option.combinedValue === eventDisplayBoardSelection
    );

    if (!selectedBoard) {
      setEventDisplayBoardSelection("__all__");
      return;
    }

    if (selectedBoard.mode === "training") {
      setEventDisplayLeaderboardMode("training");
      setEventDisplayTrainingBoard(selectedBoard.value);
    } else {
      setEventDisplayLeaderboardMode("uspsa");
      setEventDisplayUspsaBoard(selectedBoard.value);
    }
  }, [eventDisplayBoardOptions, eventDisplayBoardSelection]);

  useEffect(() => {
    if (!isEventDisplayMode) return;
    if (eventDisplayBoardOptions.length <= 1) return;
    if (!isEventDisplayRotatingAll) return;
    if (
      eventDisplayRecentOpen ||
      eventDisplayStagesOpen ||
      eventDisplayStageViewerOpen ||
      selectedRecentRun ||
      activeRunVideo
    ) {
      return;
    }

    const rotateToNextBoard = () => {
      const availableBoards = eventDisplayBoardOptionsRef.current;
      const currentBoardKey = activeEventDisplayBoardKeyRef.current;

      if (!availableBoards.length) return;

      const currentIndex = availableBoards.findIndex(
        (option) => option.combinedValue === currentBoardKey
      );
      const nextOption =
        availableBoards[
          currentIndex >= 0
            ? (currentIndex + 1) % availableBoards.length
            : 0
        ];

      if (!nextOption) return;

      if (nextOption.mode === "training") {
        setEventDisplayLeaderboardMode("training");
        setEventDisplayTrainingBoard(nextOption.value);
      } else {
        setEventDisplayLeaderboardMode("uspsa");
        setEventDisplayUspsaBoard(nextOption.value);
      }
    };

    const rotationIntervalId = window.setInterval(rotateToNextBoard, 12000);

    return () => window.clearInterval(rotationIntervalId);
  }, [
    activeRunVideo,
    isEventDisplayRotatingAll,
    eventDisplayBoardOptions.length,
    eventDisplayRotationToken,
    eventDisplayRecentOpen,
    eventDisplayStageViewerOpen,
    eventDisplayStagesOpen,
    isEventDisplayMode,
    selectedRecentRun,
  ]);

  const eventDisplayTrainingRuns = useMemo(() => {
    return eventDisplayRuns.filter((run) => {
      if (!run._isTraining) return false;
      if (!selectedEventDisplayTrainingBoard) return true;

      return (
        run._dateKey === selectedEventDisplayTrainingBoard.dateKey &&
        String(run.DrillID) === String(selectedEventDisplayTrainingBoard.drillId)
      );
    });
  }, [eventDisplayRuns, selectedEventDisplayTrainingBoard]);

  const eventDisplayTrainingLeaderboard = useMemo(() => {
    return shooters
      .map((shooter) => {
        const shooterRuns = eventDisplayTrainingRuns.filter(
          (run) => String(run.ShooterID) === String(shooter.ShooterID)
        );

        if (!shooterRuns.length) return null;

        const times = shooterRuns
          .map((run) => Number(run.TotalTime))
          .filter((value) => !Number.isNaN(value) && value > 0);

        if (!times.length) return null;

        const best = Math.min(...times);
        const average = times.reduce((sum, value) => sum + value, 0) / times.length;
        const latest = Number(shooterRuns[shooterRuns.length - 1]?.TotalTime || 0);
        const detailRun =
          [...shooterRuns]
            .filter((run) => {
              const total = Number(run.TotalTime);
              return !Number.isNaN(total) && total > 0;
            })
            .sort((a, b) => Number(a.TotalTime) - Number(b.TotalTime))[0] || shooterRuns[0];

        return {
          shooterId: shooter.ShooterID,
          name: shooter.Name,
          level: shooter.Level,
          best,
          average,
          latest,
          attempts: times.length,
          passCount: shooterRuns.filter(
            (run) => String(run.PassFail || "").trim().toLowerCase() === "pass"
          ).length,
          detailRun,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.best - b.best);
  }, [eventDisplayTrainingRuns, shooters]);

  const eventDisplayUspsaRuns = useMemo(() => {
    return uspsaRuns.filter((run) => {
      if (!selectedEventDisplayUspsaBoard) return true;

      return (
        run._dateKey === selectedEventDisplayUspsaBoard.dateKey &&
        String(run.DrillID || run._stageName || "") === String(selectedEventDisplayUspsaBoard.drillId)
      );
    });
  }, [selectedEventDisplayUspsaBoard, uspsaRuns]);

  const eventDisplayUspsaLeaderboard = useMemo(() => {
    const rows = Object.values(
      eventDisplayUspsaRuns.reduce((acc, run) => {
        const shooterId = String(run.ShooterID || "");
        if (!shooterId) return acc;

        const shooter = findItemById(shooters, shooterId, "ShooterID");
        const totalTime = Number(run.TotalTime || 0);
        const totalPoints = Number(run.TotalPoints || run.Score || 0);
        const hitFactor = Number(run.HitFactor || 0);

        if (!acc[shooterId]) {
          acc[shooterId] = {
            shooterId,
            name: shooter?.Name || shooterId,
            level: shooter?.Level || "",
            runs: 0,
            fastestTime: 0,
            totalPoints: 0,
            bestHitFactor: 0,
            detailRun: null,
          };
        }

        acc[shooterId].runs += 1;
        acc[shooterId].totalPoints += totalPoints;

        if (totalTime > 0 && (!acc[shooterId].fastestTime || totalTime < acc[shooterId].fastestTime)) {
          acc[shooterId].fastestTime = totalTime;
        }

        if (hitFactor > acc[shooterId].bestHitFactor) {
          acc[shooterId].bestHitFactor = hitFactor;
          acc[shooterId].detailRun = run;
        }

        return acc;
      }, {})
    );

    const bestHF = rows.length ? Math.max(...rows.map((row) => row.bestHitFactor || 0)) : 0;

    return rows
      .map((row) => ({
        ...row,
        stagePercent:
          bestHF > 0 ? Number(((row.bestHitFactor / bestHF) * 100).toFixed(2)) : 0,
      }))
      .sort((a, b) => b.stagePercent - a.stagePercent);
  }, [eventDisplayUspsaRuns, shooters]);

  const eventDisplaySpotlightRuns = useMemo(() => {
    return eventDisplayRuns.filter((run) => {
      const totalTime = Number(run.TotalTime || 0);
      return !Number.isNaN(totalTime) && totalTime > 0;
    });
  }, [eventDisplayRuns]);

  const eventDisplayBestSplitRankings = useMemo(() => {
    return shooters
      .map((shooter) => {
        const shooterRuns = eventDisplaySpotlightRuns.filter(
          (run) => String(run.ShooterID) === String(shooter.ShooterID)
        );

        const splitValues = shooterRuns
          .map((run) => parseSplitNumber(run.BestSplit))
          .filter((value) => !Number.isNaN(value) && value > 0);

        if (!splitValues.length) return null;

        return {
          shooterId: shooter.ShooterID,
          name: shooter.Name,
          level: shooter.Level,
          value: Math.min(...splitValues),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.value - b.value);
  }, [eventDisplaySpotlightRuns, shooters]);

  const eventDisplayBestFirstShotRankings = useMemo(() => {
    return shooters
      .map((shooter) => {
        const shooterRuns = eventDisplaySpotlightRuns.filter(
          (run) => String(run.ShooterID) === String(shooter.ShooterID)
        );

        const firstShotValues = shooterRuns
          .map((run) => Number(run.FirstShot))
          .filter((value) => !Number.isNaN(value) && value > 0);

        if (!firstShotValues.length) return null;

        return {
          shooterId: shooter.ShooterID,
          name: shooter.Name,
          level: shooter.Level,
          value: Math.min(...firstShotValues),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.value - b.value);
  }, [eventDisplaySpotlightRuns, shooters]);

  const eventDisplayBestSplit = eventDisplayBestSplitRankings[0] || null;
  const eventDisplayBestFirstShot = eventDisplayBestFirstShotRankings[0] || null;
  const eventDisplayRecentRuns = useMemo(() => {
    const twentyFourHoursAgo = eventDisplayNow.getTime() - 24 * 60 * 60 * 1000;

    const lastTwentyFourHours = recentRunsSorted
      .filter((run) => {
        const timestamp = parseTimestampValue(getRunTimestamp(run))?.getTime() || Number.NaN;
        return !Number.isNaN(timestamp) && timestamp >= twentyFourHoursAgo;
      })
      .map((run, index) => {
        const shooter = findItemById(shooters, run.ShooterID, "ShooterID");
        const drill = findItemById(drills, run.DrillID, "DrillID");
        const session = findItemById(sessions, run.SessionID, "SessionID");
        const { displayNotes, videoMeta } = getRunVideoMeta(run);

        return {
          id: `${run.Timestamp || "run"}-${run.ShooterID || "shooter"}-${index}`,
          run,
          shooter,
          drill,
          session,
          displayNotes,
          videoMeta,
        };
      });

    if (lastTwentyFourHours.length > 0) {
      return lastTwentyFourHours;
    }

    return recentRunsSorted
      .slice(0, 40)
      .map((run, index) => {
        const shooter = findItemById(shooters, run.ShooterID, "ShooterID");
        const drill = findItemById(drills, run.DrillID, "DrillID");
        const session = findItemById(sessions, run.SessionID, "SessionID");
        const { displayNotes, videoMeta } = getRunVideoMeta(run);

        return {
          id: `${run.Timestamp || "run"}-${run.ShooterID || "shooter"}-fallback-${index}`,
          run,
          shooter,
          drill,
          session,
          displayNotes,
          videoMeta,
        };
      });
  }, [recentRunsSorted, shooters, drills, sessions, eventDisplayNow]);

  const appRecentRunEntries = useMemo(() => {
    if (eventDisplayRecentRuns.length > 0) {
      return eventDisplayRecentRuns.slice(0, 20);
    }

    return recentRunsSorted.slice(0, 20).map((run, index) => ({
      id: `${getRunTimestamp(run) || "run"}-${run.ShooterID || "shooter"}-app-fallback-${index}`,
      ...buildRunDetailPayload(run),
    }));
  }, [eventDisplayRecentRuns, recentRunsSorted, shooters, drills, sessions]);

  const effectiveUserRole = useMemo(() => {
    if (!isFirebaseConfigured()) return "instructor";
    return String(authProfile?.role || "").trim().toLowerCase() || "";
  }, [authProfile]);
  const hasAdminAccess = effectiveUserRole === "admin";
  const hasMainAppAccess = effectiveUserRole === "admin" || effectiveUserRole === "instructor";
  const linkedStudentShooterId = String(
    authProfile?.shooterId || authProfile?.ShooterID || ""
  ).trim();
  const studentShooterProfile = linkedStudentShooterId
    ? findItemById(shooters, linkedStudentShooterId, "ShooterID")
    : null;
  const studentRuns = useMemo(() => {
    if (!linkedStudentShooterId) return [];

    return recentRunsSorted.filter(
      (run) => String(run.ShooterID || "").trim() === linkedStudentShooterId
    );
  }, [linkedStudentShooterId, recentRunsSorted]);
  const studentFilterOptions = useMemo(() => {
    const drillIds = new Set();
    const sessionIds = new Set();

    studentRuns.forEach((run) => {
      if (run.DrillID) drillIds.add(String(run.DrillID));
      if (run.SessionID) sessionIds.add(String(run.SessionID));
    });

    return {
      drills: Array.from(drillIds)
        .map((drillId) => findItemById(drills, drillId, "DrillID") || { DrillID: drillId, DrillName: drillId })
        .sort((a, b) => String(a.DrillName || "").localeCompare(String(b.DrillName || ""))),
      sessions: Array.from(sessionIds)
        .map((sessionId) => findItemById(sessions, sessionId, "SessionID") || { SessionID: sessionId, SessionName: sessionId })
        .sort((a, b) => String(a.SessionName || a.Name || "").localeCompare(String(b.SessionName || b.Name || ""))),
    };
  }, [drills, sessions, studentRuns]);
  const filteredStudentRuns = useMemo(() => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    return studentRuns.filter((run) => {
      if (studentFilterDrill !== "all" && String(run.DrillID || "") !== studentFilterDrill) {
        return false;
      }

      if (studentFilterSession !== "all" && String(run.SessionID || "") !== studentFilterSession) {
        return false;
      }

      if (studentFilterDate !== "all") {
        const timestamp = parseTimestampValue(getRunTimestamp(run))?.getTime() || Number.NaN;
        if (Number.isNaN(timestamp)) return false;

        if (studentFilterDate === "7d" && timestamp < now - 7 * dayMs) return false;
        if (studentFilterDate === "30d" && timestamp < now - 30 * dayMs) return false;
        if (studentFilterDate === "90d" && timestamp < now - 90 * dayMs) return false;
      }

      return true;
    });
  }, [studentFilterDate, studentFilterDrill, studentFilterSession, studentRuns]);
  const studentRecentEntries = useMemo(
    () =>
      filteredStudentRuns.slice(0, 12).map((run, index) => ({
        id: `${getRunTimestamp(run) || "run"}-${run.ShooterID || "shooter"}-student-${index}`,
        ...buildRunDetailPayload(run),
      })),
    [filteredStudentRuns, shooters, drills, sessions]
  );
  const studentStatSummary = useMemo(() => {
    const times = filteredStudentRuns
      .map((run) => Number(run.TotalTime || 0))
      .filter((value) => !Number.isNaN(value) && value > 0);
    const splitValues = filteredStudentRuns
      .map((run) => Number(run.BestSplit || 0))
      .filter((value) => !Number.isNaN(value) && value > 0);
    const firstShotValues = filteredStudentRuns
      .map((run) => Number(run.FirstShot || 0))
      .filter((value) => !Number.isNaN(value) && value > 0);
    const totalRounds = filteredStudentRuns.reduce(
      (sum, run) => sum + Number(run.TotalRounds || run.ShotCount || 0 || 0),
      0
    );

    return {
      attempts: filteredStudentRuns.length,
      bestTime: times.length ? Math.min(...times) : null,
      averageTime: times.length
        ? times.reduce((sum, value) => sum + value, 0) / times.length
        : null,
      bestSplit: splitValues.length ? Math.min(...splitValues) : null,
      bestFirstShot: firstShotValues.length ? Math.min(...firstShotValues) : null,
      totalRounds,
    };
  }, [filteredStudentRuns]);
  const studentChartData = useMemo(() => {
    const chronologicalRuns = [...filteredStudentRuns]
      .map((run, index) => ({
        run,
        timestamp: parseTimestampValue(getRunTimestamp(run))?.getTime() || 0,
        index,
      }))
      .sort((a, b) => {
        if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
          return a.timestamp - b.timestamp;
        }

        return a.index - b.index;
      })
      .map((entry) => entry.run);

    const totalTimeTrend = chronologicalRuns
      .map((run) => ({
        value: Number(run.TotalTime || 0),
        label: formatDateOnly(getRunTimestamp(run)),
      }))
      .filter((point) => !Number.isNaN(point.value) && point.value > 0)
      .slice(-10);

    const splitTrend = chronologicalRuns
      .map((run) => ({
        value: Number(run.BestSplit || 0),
        label: formatDateOnly(getRunTimestamp(run)),
      }))
      .filter((point) => !Number.isNaN(point.value) && point.value > 0)
      .slice(-10);

    const firstShotTrend = chronologicalRuns
      .map((run) => ({
        value: Number(run.FirstShot || 0),
        label: formatDateOnly(getRunTimestamp(run)),
      }))
      .filter((point) => !Number.isNaN(point.value) && point.value > 0)
      .slice(-10);

    const drillBreakdownMap = new Map();
    chronologicalRuns.forEach((run) => {
      const drillId = String(run.DrillID || "").trim();
      if (!drillId) return;

      const drill = findItemById(drills, drillId, "DrillID");
      const existing = drillBreakdownMap.get(drillId) || {
        label: drill?.DrillName || drillId,
        value: 0,
        bestTime: null,
      };

      existing.value += 1;

      const runTime = Number(run.TotalTime || 0);
      if (!Number.isNaN(runTime) && runTime > 0) {
        existing.bestTime =
          existing.bestTime === null ? runTime : Math.min(existing.bestTime, runTime);
      }

      drillBreakdownMap.set(drillId, existing);
    });

    const drillBreakdown = Array.from(drillBreakdownMap.values())
      .sort((a, b) => {
        if (b.value !== a.value) return b.value - a.value;
        return String(a.label || "").localeCompare(String(b.label || ""));
      })
      .slice(0, 5)
      .map((item) => ({
        ...item,
        meta: `${item.value} run${item.value === 1 ? "" : "s"}${
          item.bestTime ? ` • Best ${formatSplitForDisplay(item.bestTime.toFixed(2))}s` : ""
        }`,
      }));

    return {
      totalTimeTrend,
      splitTrend,
      firstShotTrend,
      drillBreakdown,
    };
  }, [drills, filteredStudentRuns]);
  const studentLastRun = studentRuns[0] || null;
  const shouldShowAuthGate =
    !isEventDisplayMode && isFirebaseConfigured() && authReady && !authUser;
  const shouldShowStudentShell =
    !isEventDisplayMode &&
    isFirebaseConfigured() &&
    authReady &&
    authUser &&
    effectiveUserRole === "student";
  const loadStudentAccounts = useCallback(async () => {
    if (!isFirebaseConfigured() || !hasAdminAccess || !authUser) {
      setStudentAccounts([]);
      return;
    }

    setStudentAccountsLoading(true);
    setStudentAccountMessage("");

    try {
      const profiles = await listUserProfiles();
      const visibleProfiles = profiles.filter(
        (profile) => String(profile?.id || "") !== String(authUser?.uid || "")
      );

      setStudentAccounts(visibleProfiles);
    } catch (error) {
      console.error("Student accounts load error:", error);
      setStudentAccountMessage("We could not load student accounts right now.");
    } finally {
      setStudentAccountsLoading(false);
    }
  }, [authUser, hasAdminAccess]);
  const instructorStudentAccounts = useMemo(
    () =>
      studentAccounts.map((profile) => {
        const linkedShooterId = String(profile?.shooterId || profile?.ShooterID || "").trim();
        return {
          ...profile,
          linkedShooterId,
          linkedShooter: linkedShooterId
            ? findItemById(shooters, linkedShooterId, "ShooterID")
            : null,
        };
      }),
    [shooters, studentAccounts]
  );
  const adminAccountGroups = useMemo(() => {
    const groups = [
      {
        key: "admin",
        title: "Admins",
        subtitle: "Can manage account roles, student links, and admin-only settings.",
        accounts: [],
      },
      {
        key: "instructor",
        title: "Instructors",
        subtitle: "Can use the full training app, timer, logging, matches, courses, and leaderboards.",
        accounts: [],
      },
      {
        key: "student",
        title: "Students",
        subtitle: "Can only view their linked dashboard, videos, and stats.",
        accounts: [],
      },
    ];

    instructorStudentAccounts.forEach((profile) => {
      const role = String(profile.role || "student").trim().toLowerCase() || "student";
      const group = groups.find((item) => item.key === role) || groups[2];
      group.accounts.push(profile);
    });

    return groups;
  }, [instructorStudentAccounts]);
  const unlinkedStudentAccounts = useMemo(
    () =>
      instructorStudentAccounts.filter((profile) => {
        const role = String(profile.role || "student").trim().toLowerCase() || "student";
        return role === "student" && !profile.linkedShooterId;
      }),
    [instructorStudentAccounts]
  );

  useEffect(() => {
    if (!hasAdminAccess || !authUser) {
      setStudentAccounts([]);
      return;
    }

    loadStudentAccounts();
  }, [authUser, hasAdminAccess, loadStudentAccounts]);

  const boxStyle = {
  background: theme.cardBg,
  borderRadius: 20,
  padding: 20,
  boxShadow: theme.shadow,
  border: `1px solid ${theme.border}`,
  transition: "background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease, color 0.25s ease",
};

  const tabButtonStyle = (tab) => ({
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "8px 4px",
  background: "transparent",
  border: "none",
  color: activeTab === tab ? theme.accent : theme.subtext,
  fontWeight: activeTab === tab ? 700 : 500,
  fontSize: 11,
  gap: 4,
  cursor: "pointer",
  transition: "all 0.2s ease",
  transform: activeTab === tab ? "translateY(-1px)" : "translateY(0)",
});

const tabIconStyle = (tab) => ({
  width: 30,
  height: 30,
  borderRadius: 999,
  display: "flex",
  flexDirection: "column", // 👈 add this
  alignItems: "center",
  justifyContent: "center",
  background: activeTab === tab ? theme.accentSoft : "transparent",
  color: activeTab === tab ? theme.accent : theme.subtext,
  fontSize: 16,
  lineHeight: 1,
  transition: "all 0.2s ease",
  boxShadow:
    activeTab === tab && darkMode
      ? "0 0 14px rgba(125,211,252,0.16)"
      : "none",
});

  const inputStyle = {
  width: "100%",
  minHeight: 48,
  padding: "12px 14px",
  fontSize: 17,
  borderRadius: 14,
  border: `1px solid ${theme.border}`,
  background: theme.inputBg,
  color: theme.inputText,
  boxSizing: "border-box",
  transition: "background 0.25s ease, border-color 0.25s ease, color 0.25s ease",
};

  const textAreaStyle = {
  ...inputStyle,
  minHeight: 100,
  resize: "vertical",
};


  const buttonStyle = {
  minHeight: Capacitor.isNativePlatform() ? 56 : 50,
  padding: Capacitor.isNativePlatform() ? "14px 18px" : "12px 18px",
  fontSize: Capacitor.isNativePlatform() ? 19 : 17,
  fontWeight: 700,
  borderRadius: 14,
  border: "none",
  background: theme.accent,
  color: darkMode ? "#120f0b" : "#ffffff",
  cursor: "pointer",
  boxShadow: darkMode ? "0 6px 18px rgba(200,163,106,0.22)" : "none",
  transition: "all 0.2s ease",
};

  const secondaryButtonStyle = {
  ...buttonStyle,
  background: theme.cardBgSoft,
  color: theme.text,
  border: `1px solid ${theme.border}`,
  boxShadow: "none",
};

const cardLabelStyle = {
  fontSize: 13,
  color: theme.subtext,
  marginBottom: 6,
  fontWeight: 600,
  letterSpacing: 0.2,
};

const statValueStyle = {
  fontSize: 34,
  fontWeight: 700,
  color: theme.text,
};

const sectionTitleStyle = {
  marginTop: 0,
  marginBottom: 6,
  fontSize: 30,
  color: theme.text,
  letterSpacing: -0.4,
};

const sectionEyebrowStyle = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: theme.subtext,
  opacity: 0.8,
  marginBottom: 8,
};

const sectionSubtitleStyle = {
  marginTop: 0,
  marginBottom: 18,
  color: theme.subtext,
  fontSize: 15,
  lineHeight: 1.45,
};

const infoPillStyle = {
  padding: "10px 12px",
  borderRadius: 14,
  border: `1px solid ${theme.border}`,
  background: theme.cardBgSoft,
  color: theme.text,
};

const tableHeaderCellStyle = {
  textAlign: "left",
  padding: "0 10px 12px",
  color: theme.subtext,
  fontSize: 13,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};

const tableHeaderFirstCellStyle = {
  ...tableHeaderCellStyle,
  padding: "0 10px 12px 0",
};

const filterCardStyle = {
  padding: 14,
  borderRadius: 16,
  border: `1px solid ${theme.border}`,
  background: theme.cardBgSoft,
};

const tableContainerStyle = {
  overflowX: "auto",
  borderRadius: 18,
  border: `1px solid ${theme.border}`,
  background: theme.cardBgSoft,
  padding: 12,
};

const compactMetricCellStyle = {
  padding: "12px 10px",
  color: theme.subtext,
  whiteSpace: "nowrap",
  minWidth: 68,
  fontVariantNumeric: "tabular-nums",
};

const compactMetricHeaderCellStyle = {
  ...tableHeaderCellStyle,
  minWidth: 68,
};

const leaderboardShooterHeaderCellStyle = {
  ...tableHeaderCellStyle,
  padding: "0 10px 12px 18px",
};

const centeredTableHeaderCellStyle = {
  ...tableHeaderCellStyle,
  textAlign: "center",
};

const centeredTableHeaderFirstCellStyle = {
  ...tableHeaderFirstCellStyle,
  textAlign: "center",
};

const centeredCompactMetricHeaderCellStyle = {
  ...compactMetricHeaderCellStyle,
  textAlign: "center",
};

const tableCellStyle = {
  padding: "12px 10px",
  color: theme.text,
  borderBottom: `1px solid ${theme.border}`,
};

const getRowStyle = (index) => ({
  background: index % 2 === 0 ? theme.rowBg : theme.rowAltBg,
});

  if (!isEventDisplayMode && isFirebaseConfigured() && !authReady) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: theme.pageBg,
          color: theme.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ ...boxStyle, width: "100%", maxWidth: 520, textAlign: "center" }}>
          <img
            src={headerImg}
            alt="JMT Performance"
            style={{ display: "block", margin: "0 auto 18px", width: "100%", maxWidth: 320, height: "auto" }}
          />
          <div style={{ color: theme.subtext, fontSize: 18, fontWeight: 700 }}>
            Loading account...
          </div>
        </div>
      </div>
    );
  }

  if (shouldShowAuthGate) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: theme.pageBg,
          color: theme.text,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ ...boxStyle, width: "100%", maxWidth: 560 }}>
          <img
            src={headerImg}
            alt="JMT Performance"
            style={{ display: "block", margin: "0 auto 18px", width: "100%", maxWidth: 340, height: "auto" }}
          />
          <div style={{ textAlign: "center", marginBottom: 22 }}>
            <div style={{ color: theme.text, fontSize: 30, fontWeight: 900, marginBottom: 8 }}>
              {authMode === "signin" ? "Sign In" : "Create Account"}
            </div>
            <div style={{ color: theme.subtext, fontSize: 16, lineHeight: 1.45 }}>
              {authMode === "signin"
                ? "Sign in to your JMT Performance account."
                : "New accounts start as student accounts. An admin can upgrade trusted users to Instructor or Admin later."}
            </div>
          </div>

          <form onSubmit={handleAuthSubmit} style={{ display: "grid", gap: 14 }}>
            {authMode === "register" ? (
              <input
                style={inputStyle}
                placeholder="Full name"
                value={authDisplayName}
                onChange={(event) => setAuthDisplayName(event.target.value)}
                autoComplete="name"
              />
            ) : null}

            <input
              style={inputStyle}
              placeholder="Email"
              value={authEmail}
              onChange={(event) => setAuthEmail(event.target.value)}
              autoComplete="email"
              type="email"
            />

            <input
              style={inputStyle}
              placeholder="Password"
              value={authPassword}
              onChange={(event) => setAuthPassword(event.target.value)}
              autoComplete={authMode === "signin" ? "current-password" : "new-password"}
              type="password"
            />

            {authMode === "register" ? (
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: `1px solid ${theme.border}`,
                  background: theme.cardBgSoft,
                  color: theme.subtext,
                  fontSize: 14,
                  fontWeight: 700,
                  lineHeight: 1.4,
                }}
              >
                Account type: Student. Admin approval is required for Instructor or Admin access.
              </div>
            ) : null}

            {authError ? (
              <div
                style={{
                  background: theme.dangerBg,
                  color: theme.dangerText,
                  borderRadius: 14,
                  padding: "12px 14px",
                  fontSize: 14,
                  fontWeight: 700,
                }}
              >
                {authError}
              </div>
            ) : null}

            <button type="submit" style={buttonStyle} disabled={authSubmitting}>
              {authSubmitting
                ? authMode === "signin"
                  ? "Signing In..."
                  : "Creating Account..."
                : authMode === "signin"
                ? "Sign In"
                : "Create Account"}
            </button>
          </form>

          <div style={{ marginTop: 16, textAlign: "center", color: theme.subtext, fontSize: 14 }}>
            {authMode === "signin" ? "Need an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => {
                setAuthMode((current) => (current === "signin" ? "register" : "signin"));
                setAuthError("");
              }}
              style={{
                background: "transparent",
                border: "none",
                color: theme.accent,
                fontWeight: 800,
                cursor: "pointer",
                padding: 0,
              }}
            >
              {authMode === "signin" ? "Create one" : "Sign in"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (shouldShowStudentShell) {
    const studentMetricCards = [
      {
        label: "Runs",
        value: studentStatSummary.attempts,
        detail: "Logged attempts",
      },
      {
        label: "Best Time",
        value: studentStatSummary.bestTime ? `${formatSplitForDisplay(studentStatSummary.bestTime.toFixed(2))}s` : "-",
        detail: "Fastest run",
      },
      {
        label: "Average",
        value: studentStatSummary.averageTime ? `${formatSplitForDisplay(studentStatSummary.averageTime.toFixed(2))}s` : "-",
        detail: "All runs",
      },
      {
        label: "Best Split",
        value: studentStatSummary.bestSplit ? `${formatSplitForDisplay(studentStatSummary.bestSplit.toFixed(2))}s` : "-",
        detail: "Fastest split",
      },
      {
        label: "Best First",
        value: studentStatSummary.bestFirstShot ? `${formatSplitForDisplay(studentStatSummary.bestFirstShot.toFixed(2))}s` : "-",
        detail: "First shot",
      },
      {
        label: "Rounds",
        value: studentStatSummary.totalRounds,
        detail: "Total rounds",
      },
    ];
    const studentChartCards = [
      {
        kind: "sparkline",
        title: "Total Time Trend",
        subtitle: "Last 10 filtered runs. Lower is faster.",
        points: studentChartData.totalTimeTrend,
        accent: "#d7b06c",
        fill: "rgba(215,176,108,0.92)",
        emptyMessage: "Log at least two runs with total time to see your speed trend.",
      },
      {
        kind: "sparkline",
        title: "Best Split Trend",
        subtitle: "Fastest split over your last 10 filtered runs.",
        points: studentChartData.splitTrend,
        accent: "#82d8c8",
        fill: "rgba(130,216,200,0.88)",
        emptyMessage: "Need at least two logged split values to chart your split trend.",
      },
      {
        kind: "sparkline",
        title: "First Shot Trend",
        subtitle: "How your first shot has moved over recent runs.",
        points: studentChartData.firstShotTrend,
        accent: "#e0906f",
        fill: "rgba(224,144,111,0.88)",
        emptyMessage: "Need at least two runs with first-shot data to chart this.",
      },
      {
        kind: "bars",
        title: "Drill Volume",
        subtitle: "Your most-used drills inside the current filters.",
        items: studentChartData.drillBreakdown,
        emptyMessage: "Once you have filtered runs across drills, they will show here.",
      },
    ];

    return (
      <div
        style={{
          minHeight: "100vh",
          background:
            "radial-gradient(circle at 50% -10%, rgba(200,163,106,0.18), transparent 34%), linear-gradient(180deg, #050505 0%, #0b0b0c 44%, #050505 100%)",
          color: theme.text,
          padding: Capacitor.isNativePlatform() ? "58px 14px 28px" : "24px 20px 32px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ maxWidth: 1120, margin: "0 auto", display: "grid", gap: 16 }}>
          <div
            style={{
              ...boxStyle,
              position: "relative",
              overflow: "hidden",
              padding: Capacitor.isNativePlatform() ? 18 : 24,
              background: "linear-gradient(145deg, rgba(24,24,28,0.96), rgba(10,10,12,0.98))",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: "0 0 auto auto",
                width: 180,
                height: 180,
                background: "radial-gradient(circle, rgba(200,163,106,0.20), transparent 70%)",
                transform: "translate(48px, -76px)",
                pointerEvents: "none",
              }}
            />
            <div style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div>
                <div style={sectionEyebrowStyle}>Student Dashboard</div>
                <div style={{ fontSize: Capacitor.isNativePlatform() ? 31 : 42, fontWeight: 900, color: theme.text, letterSpacing: -0.8 }}>
                {studentShooterProfile?.Name || authProfile?.displayName || authUser?.displayName || authUser?.email || "Student"}
                </div>
                <div style={{ color: theme.subtext, marginTop: 8, fontWeight: 800, letterSpacing: 0.2 }}>
                  {studentShooterProfile?.Level ? `Level ${studentShooterProfile.Level}` : "Awaiting shooter link"}
                </div>
                <div style={{ color: theme.subtext, marginTop: 10, lineHeight: 1.45, maxWidth: 620 }}>
                  Personal run history, videos, and performance stats from your linked JMT shooter profile.
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: theme.text,
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {studentStatSummary.attempts} filtered runs
                  </div>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: theme.text,
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {studentFilterDrill === "all"
                      ? "All drills"
                      : findItemById(drills, studentFilterDrill, "DrillID")?.DrillName || "Selected drill"}
                  </div>
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.06)",
                      color: theme.text,
                      fontSize: 12,
                      fontWeight: 800,
                    }}
                  >
                    {studentFilterDate === "all"
                      ? "All dates"
                      : studentFilterDate === "7d"
                      ? "Last 7 days"
                      : studentFilterDate === "30d"
                      ? "Last 30 days"
                      : "Last 90 days"}
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gap: 10, minWidth: 150 }}>
                <div style={{ ...infoPillStyle, textAlign: "center", background: "rgba(255,255,255,0.04)" }}>
                  <strong>Last Run</strong>
                  <br />
                  {studentLastRun ? formatDateOnly(getRunTimestamp(studentLastRun)) : "-"}
                </div>
                <button type="button" style={secondaryButtonStyle} onClick={handleSignOut}>
                  Sign Out
                </button>
              </div>
            </div>
          </div>

          {!linkedStudentShooterId ? (
            <div style={{ ...boxStyle, color: theme.subtext, lineHeight: 1.6, display: "grid", gap: 14 }}>
              <div>
                This account is signed in as a student, but it is not linked to a shooter profile yet.
              </div>
              <div>
                First, sync this student profile to Firebase. Then sign into the instructor account and link this student to a shooter.
              </div>
              {studentProfileMessage ? (
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: `1px solid ${theme.border}`,
                    background: theme.accentSoft,
                    color: theme.text,
                    fontWeight: 700,
                  }}
                >
                  {studentProfileMessage}
                </div>
              ) : null}
              <button
                type="button"
                style={buttonStyle}
                onClick={handleSyncStudentProfile}
                disabled={studentProfileSyncing}
              >
                {studentProfileSyncing ? "Syncing Profile..." : "Sync Student Profile"}
              </button>
            </div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                {studentMetricCards.map((metric) => (
                  <div
                    key={metric.label}
                    style={{
                      ...boxStyle,
                      padding: Capacitor.isNativePlatform() ? 14 : 18,
                      background: "linear-gradient(180deg, rgba(24,24,28,0.98), rgba(15,15,18,0.98))",
                    }}
                  >
                    <div style={{ ...sectionEyebrowStyle, marginBottom: 5 }}>{metric.label}</div>
                    <div style={{ fontSize: Capacitor.isNativePlatform() ? 28 : 34, fontWeight: 900, color: theme.text, fontVariantNumeric: "tabular-nums" }}>
                      {metric.value}
                    </div>
                    <div style={{ color: theme.subtext, fontSize: 12, fontWeight: 700, marginTop: 4 }}>
                      {metric.detail}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ ...boxStyle, display: "grid", gap: 14 }}>
                <div>
                  <div style={sectionEyebrowStyle}>Performance Trends</div>
                  <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>
                    Progress Snapshot
                  </div>
                </div>

                <div style={{ display: "grid", gap: 12 }}>
                  <StudentSparklineCard
                    {...studentChartCards[0]}
                    onOpen={() => setSelectedStudentChart(studentChartCards[0])}
                  />

                  <div style={{ display: "grid", gap: 12 }}>
                    <StudentSparklineCard
                      {...studentChartCards[1]}
                      onOpen={() => setSelectedStudentChart(studentChartCards[1])}
                    />

                    <StudentSparklineCard
                      {...studentChartCards[2]}
                      onOpen={() => setSelectedStudentChart(studentChartCards[2])}
                    />
                  </div>

                  <StudentBarBreakdownCard
                    {...studentChartCards[3]}
                    onOpen={() => setSelectedStudentChart(studentChartCards[3])}
                  />
                </div>
              </div>

              <div style={boxStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 14 }}>
                  <div>
                    <div style={sectionEyebrowStyle}>My Runs</div>
                    <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>Recent Activity</div>
                  </div>
                  <div style={{ color: theme.subtext, fontWeight: 800 }}>
                    {filteredStudentRuns.length} matched
                  </div>
                </div>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                    gap: 10,
                    marginBottom: 14,
                  }}
                >
                  <select
                    style={inputStyle}
                    value={studentFilterDrill}
                    onChange={(event) => setStudentFilterDrill(event.target.value)}
                  >
                    <option value="all">All Drills</option>
                    {studentFilterOptions.drills.map((drill) => (
                      <option key={`student-drill-filter-${drill.DrillID}`} value={String(drill.DrillID)}>
                        {drill.DrillName || drill.DrillID}
                      </option>
                    ))}
                  </select>

                  <select
                    style={inputStyle}
                    value={studentFilterSession}
                    onChange={(event) => setStudentFilterSession(event.target.value)}
                  >
                    <option value="all">All Sessions</option>
                    {studentFilterOptions.sessions.map((session) => (
                      <option key={`student-session-filter-${session.SessionID}`} value={String(session.SessionID)}>
                        {session.SessionName || session.Name || session.SessionID}
                      </option>
                    ))}
                  </select>

                  <select
                    style={inputStyle}
                    value={studentFilterDate}
                    onChange={(event) => setStudentFilterDate(event.target.value)}
                  >
                    <option value="all">All Dates</option>
                    <option value="7d">Last 7 Days</option>
                    <option value="30d">Last 30 Days</option>
                    <option value="90d">Last 90 Days</option>
                  </select>

                  <button
                    type="button"
                    style={{ ...secondaryButtonStyle, minHeight: 48, fontSize: 15 }}
                    onClick={() => {
                      setStudentFilterDrill("all");
                      setStudentFilterSession("all");
                      setStudentFilterDate("all");
                    }}
                  >
                    Reset Filters
                  </button>
                </div>

                {studentRecentEntries.length === 0 ? (
                  <div style={{ color: theme.subtext }}>No runs matched those filters.</div>
                ) : (
                  <div style={{ display: "grid", gap: 12 }}>
                    {studentRecentEntries.map((entry) => {
                      const hasVideo = Boolean(getPlayableVideoUrl(entry.videoMeta));

                      return (
                        <div
                          key={entry.id}
                          style={{
                            border: `1px solid ${theme.border}`,
                            borderRadius: 18,
                            padding: 14,
                            background: theme.cardBgSoft,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
                            <div>
                              <div style={{ fontSize: 21, fontWeight: 900, color: theme.text }}>
                                {entry.drill?.DrillName || entry.run.DrillID || "Drill"}
                              </div>
                              <div style={{ color: theme.subtext, fontWeight: 800, marginTop: 4 }}>
                                {entry.session?.SessionName || entry.run.SessionID || "Session"} • {formatDateOnly(getRunTimestamp(entry.run))}
                              </div>
                            </div>
                            {hasVideo ? (
                              <button
                                type="button"
                                style={{
                                  ...buttonStyle,
                                  minHeight: 42,
                                  padding: "9px 13px",
                                  fontSize: 14,
                                  borderRadius: 12,
                                }}
                                onClick={() =>
                                  openRunVideoPlayer(
                                    entry.videoMeta,
                                    `${entry.shooter?.Name || "Student"} - ${entry.drill?.DrillName || "Run"}`
                                  )
                                }
                              >
                                Open Video
                              </button>
                            ) : null}
                          </div>

                          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
                            {[
                              ["Total", entry.run.TotalTime || "-"],
                              ["Shots", entry.run.ShotCount || "-"],
                              ["First", entry.run.FirstShot || "-"],
                              ["Best", formatSplitForDisplay(entry.run.BestSplit) || "-"],
                            ].map(([label, value]) => (
                              <div key={`${entry.id}-${label}`} style={{ ...infoPillStyle, padding: "9px 8px" }}>
                                <div style={{ color: theme.subtext, fontSize: 10, fontWeight: 900, letterSpacing: 0.5, textTransform: "uppercase" }}>
                                  {label}
                                </div>
                                <div style={{ color: theme.text, fontSize: 16, fontWeight: 900, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                                  {value}
                                </div>
                              </div>
                            ))}
                          </div>

                          <button type="button" style={{ ...secondaryButtonStyle, minHeight: 42, fontSize: 14 }} onClick={() => setSelectedRecentRun(entry)}>
                            View Run Details
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        {selectedRecentRun
          ? createPortal(
              <div
                onClick={closeRecentRunDetail}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.78)",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center",
                  zIndex: 1000000,
                  padding: 14,
                }}
              >
                <div
                  onClick={(event) => event.stopPropagation()}
                  style={{
                    width: "100%",
                    maxWidth: 760,
                    maxHeight: "84vh",
                    overflowY: "auto",
                    WebkitOverflowScrolling: "touch",
                    background: theme.cardBg,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 24,
                    boxShadow: theme.shadow,
                    padding: 18,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
                    <div>
                      <div style={sectionEyebrowStyle}>Run Detail</div>
                      <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>
                        {selectedRecentRun.drill?.DrillName || selectedRecentRun.run.DrillID || "Run"}
                      </div>
                      <div style={{ color: theme.subtext, fontWeight: 800, marginTop: 4 }}>
                        {selectedRecentRun.session?.SessionName || selectedRecentRun.run.SessionID || "Session"} • {formatDateOnly(getRunTimestamp(selectedRecentRun.run))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={closeRecentRunDetail}
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: "50%",
                        border: `1px solid ${theme.border}`,
                        background: theme.cardBgSoft,
                        color: theme.text,
                        fontSize: 24,
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10, marginBottom: 16 }}>
                    <div style={infoPillStyle}><strong>Total:</strong><br />{selectedRecentRun.run.TotalTime || "—"}</div>
                    <div style={infoPillStyle}><strong>Shots:</strong><br />{selectedRecentRun.run.ShotCount || "—"}</div>
                    <div style={infoPillStyle}><strong>First:</strong><br />{selectedRecentRun.run.FirstShot || "—"}</div>
                    <div style={infoPillStyle}><strong>Avg Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.AvgSplit) || "—"}</div>
                    <div style={infoPillStyle}><strong>Best Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.BestSplit) || "—"}</div>
                    <div style={infoPillStyle}><strong>Worst Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.WorstSplit) || "—"}</div>
                    <div style={infoPillStyle}><strong>Result:</strong><br />{selectedRecentRun.run.PassFail || "—"}</div>
                    <div style={infoPillStyle}><strong>Score:</strong><br />{selectedRecentRun.run.Score || "—"}</div>
                  </div>

                  {[
                    selectedRecentRun.run.AHits,
                    selectedRecentRun.run.CHits,
                    selectedRecentRun.run.DHits,
                    selectedRecentRun.run.Misses,
                    selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots,
                    selectedRecentRun.run.SteelHits,
                    selectedRecentRun.run.SteelMisses,
                    selectedRecentRun.run.TotalPoints,
                    selectedRecentRun.run.HitFactor,
                  ].some((value) => String(value ?? "").trim() !== "") ? (
                    <div style={{ ...boxStyle, boxShadow: "none", marginBottom: 16, padding: 14 }}>
                      <div style={sectionEyebrowStyle}>Scoring</div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
                        <div style={infoPillStyle}><strong>A Hits:</strong><br />{selectedRecentRun.run.AHits || "—"}</div>
                        <div style={infoPillStyle}><strong>C Hits:</strong><br />{selectedRecentRun.run.CHits || "—"}</div>
                        <div style={infoPillStyle}><strong>D Hits:</strong><br />{selectedRecentRun.run.DHits || "—"}</div>
                        <div style={infoPillStyle}><strong>Misses:</strong><br />{selectedRecentRun.run.Misses || "—"}</div>
                        <div style={infoPillStyle}><strong>No Shoot:</strong><br />{selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots || "—"}</div>
                        <div style={infoPillStyle}><strong>Steel Hits:</strong><br />{selectedRecentRun.run.SteelHits || "—"}</div>
                        <div style={infoPillStyle}><strong>Steel Misses:</strong><br />{selectedRecentRun.run.SteelMisses || "—"}</div>
                        <div style={infoPillStyle}><strong>Total Points:</strong><br />{selectedRecentRun.run.TotalPoints || "—"}</div>
                        <div style={infoPillStyle}><strong>Hit Factor:</strong><br />{selectedRecentRun.run.HitFactor || "—"}</div>
                      </div>
                    </div>
                  ) : null}

                  <div style={{ ...boxStyle, boxShadow: "none", padding: 14, marginBottom: selectedRecentRun.videoMeta ? 16 : 0 }}>
                    <div style={sectionEyebrowStyle}>Notes</div>
                    <div style={{ color: selectedRecentRun.displayNotes ? theme.text : theme.subtext, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {selectedRecentRun.displayNotes || "No notes added for this run."}
                    </div>
                  </div>

                  {selectedRecentRun.videoMeta ? (
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() =>
                        openRunVideoPlayer(
                          selectedRecentRun.videoMeta,
                          `${selectedRecentRun.shooter?.Name || "Student"} - ${selectedRecentRun.drill?.DrillName || "Run"}`
                        )
                      }
                    >
                      Play Video
                    </button>
                  ) : null}
                </div>
              </div>,
              document.body
            )
          : null}
        {selectedStudentChart
          ? createPortal(
              <div
                onClick={() => setSelectedStudentChart(null)}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,0.86)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  zIndex: 1000001,
                  padding: Capacitor.isNativePlatform() ? "58px 14px 24px" : "24px",
                }}
              >
                <div
                  onClick={(event) => event.stopPropagation()}
                  style={{
                    width: "100%",
                    maxWidth: 980,
                    maxHeight: "88vh",
                    overflowY: "auto",
                    WebkitOverflowScrolling: "touch",
                    background: "linear-gradient(180deg, rgba(13,13,16,0.99), rgba(6,6,8,0.99))",
                    border: `1px solid ${theme.border}`,
                    borderRadius: 26,
                    boxShadow: theme.shadow,
                    padding: Capacitor.isNativePlatform() ? 18 : 22,
                    display: "grid",
                    gap: 14,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                    <div>
                      <div style={sectionEyebrowStyle}>Expanded Chart</div>
                      <div style={{ fontSize: 28, fontWeight: 900, color: theme.text }}>
                        {selectedStudentChart.title}
                      </div>
                      <div style={{ color: theme.subtext, fontWeight: 700, marginTop: 6, maxWidth: 720 }}>
                        {selectedStudentChart.subtitle}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedStudentChart(null)}
                      style={{
                        width: 42,
                        height: 42,
                        borderRadius: "50%",
                        border: `1px solid ${theme.border}`,
                        background: theme.cardBgSoft,
                        color: theme.text,
                        fontSize: 24,
                        cursor: "pointer",
                        flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {selectedStudentChart.kind === "sparkline" ? (
                    <StudentSparklineCard
                      {...selectedStudentChart}
                      fullscreen
                    />
                  ) : (
                    <StudentBarBreakdownCard
                      {...selectedStudentChart}
                      fullscreen
                    />
                  )}
                </div>
              </div>,
              document.body
            )
          : null}
      </div>
    );
  }




  async function subscribeNativeTimerNotifications() {
  try {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    const deviceId = nativeDeviceIdRef.current;

    if (!deviceId) {
      setTimerStatusMessage("No native timer device ID");
      return;
    }

    if (nativeNotifyActiveRef.current) {
      setTimerStatusMessage("Already subscribed to timer");
      return;
    }

    const service = "7520ffff-14d2-4cda-8b6b-697c554c9311";
    const characteristic = "75200001-14d2-4cda-8b6b-697c554c9311";

    await BleClient.startNotifications(
      deviceId,
      service,
      characteristic,
      (value) => {
        try {
          const bytes = new Uint8Array(value.buffer);
          // console.log("NATIVE TIMER RAW BYTES:", Array.from(bytes));
          handleNativeTimerBytes(bytes);

          // We will hook this into your existing parser next.
        } catch (err) {
          console.error("Native notification parse error:", err);
        }
      }
    );

    nativeNotifyActiveRef.current = true;
setTimerStatusMessage("Ready");

    nativeNotifyActiveRef.current = true;
    setTimerStatusMessage("Ready");
  } catch (err) {
    console.error("Native notification subscribe error:", err);
    setTimerStatusMessage("Notification subscribe failed");
  }
}

  async function connectTimer() {
  try {
    if (Capacitor.isNativePlatform()) {
  await scanNativeBle();
  return;
}
    setTimerStatusMessage("Connecting to timer...");

    // always start fresh
    if (eventCharRef.current) {
      try {
        eventCharRef.current.removeEventListener(
          "characteristicvaluechanged",
          handleTimerEvent
        );
      } catch {}
      eventCharRef.current = null;
    }

    if (timerDeviceRef.current?.gatt?.connected) {
      try {
        timerDeviceRef.current.gatt.disconnect();
      } catch {}
    }

    timerDeviceRef.current = null;
    timerServerRef.current = null;

    await new Promise((resolve) => setTimeout(resolve, 800));

    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "SG-" }],
      optionalServices: ["7520ffff-14d2-4cda-8b6b-697c554c9311"],
    });

    timerDeviceRef.current = device;
    device.removeEventListener("gattserverdisconnected", handleTimerDisconnected);
    device.addEventListener("gattserverdisconnected", handleTimerDisconnected);

    if (!device.gatt) {
      throw new Error("This device does not support GATT.");
    }

    const server = await device.gatt.connect();
    timerServerRef.current = server;

    const service = await server.getPrimaryService(
      "7520ffff-14d2-4cda-8b6b-697c554c9311"
    );

    const eventChar = await service.getCharacteristic(
      "75200001-14d2-4cda-8b6b-697c554c9311"
    );

    await eventChar.startNotifications();

    eventCharRef.current = eventChar;
    eventChar.removeEventListener("characteristicvaluechanged", handleTimerEvent);
    eventChar.addEventListener("characteristicvaluechanged", handleTimerEvent);

    setTimerConnected(true);
    setTimerDeviceName(device.name || "SG Timer");
    setTimerStatusMessage("Connected");

    console.log("Listening for timer events...");
  } catch (err) {
    console.error("Bluetooth error:", err);
    setTimerStatusMessage("Connection failed");
    setTimerDeviceName("");
    setTimerConnected(false);
    alert("Bluetooth error: " + err.message);
  }
}
let currentShots = [];

function handleTimerEvent(event) {
  const value = event.target.value; // This is already a DataView

  const eventId = value.getUint8(1);

  // SESSION_STARTED or SESSION_SET_BEGIN
 if (eventId === 0x00 || eventId === 0x05) {
  currentShots = [];
  lastShotSnapshotRef.current = [];
  discardCurrentTimerRunRef.current = false;
  setLiveShotTimes([]);
  setTimerRunning(true);
  pushNativeRecordingStats({ shots: 0, totalTime: 0 });
  console.log("Session started / set begin");
  return;
}

  // SHOT_DETECTED
if (eventId === 0x04) {
  const shotNum = value.getUint16(6, false);
  const rawTime = value.getUint32(8, false);
  const seconds = Number((rawTime / 1000).toFixed(3));

  console.log("Shot detected parsed:", { shotNum, rawTime, seconds });

  if (seconds > 0 && Number.isFinite(seconds)) {
  currentShots.push(seconds);
  lastShotSnapshotRef.current = [...currentShots];
  setLiveShotTimes([...currentShots]);
  pushNativeRecordingStats({ shots: currentShots.length, totalTime: seconds });
}

  return;
}

  // SESSION_STOPPED
  if (eventId === 0x03) {
  console.log("Session ended");
  setTimerRunning(false);
  lastShotSnapshotRef.current = [...currentShots];
  const finalTotalTime = currentShots.length > 0 ? currentShots[currentShots.length - 1] : 0;
  pushNativeRecordingStats({ shots: currentShots.length, totalTime: finalTotalTime });
  if (discardCurrentTimerRunRef.current || videoCaptureSessionRef.current.discardPending) {
    currentShots = [];
    lastShotSnapshotRef.current = [];
    setLiveShotTimes([]);
    discardCurrentTimerRunRef.current = false;
    videoCaptureSessionRef.current = {
      ...videoCaptureSessionRef.current,
      active: false,
      awaitingStop: false,
      pendingFinalize: false,
      discardPending: false,
      recordedMeta: null,
    };
    setVideoStatus("Video mode cancelled. Run discarded.");
    return;
  }
  if (videoCaptureSessionRef.current.awaitingStop) {
    videoCaptureSessionRef.current = {
      ...videoCaptureSessionRef.current,
      pendingFinalize: true,
    };
    return;
  }
  finalizeRun();
}
}
async function finalizeRun() {
  const finalizedShotsSource =
    currentShots.length > 0 ? currentShots : lastShotSnapshotRef.current;

  console.log("finalizeRun invoked", {
    shotCount: finalizedShotsSource.length,
    selectedShooter: selectedShooterRef.current,
    selectedDrill: selectedDrillRef.current,
    selectedSession: selectedSessionRef.current,
    recordedMeta: videoCaptureSessionRef.current.recordedMeta,
  });

  if (finalizedShotsSource.length === 0) return;

  const shotTimes = [...finalizedShotsSource]
    .map(Number)
    .filter((n) => !Number.isNaN(n) && n > 0);

  if (shotTimes.length === 0) return;

  const totalTime = shotTimes[shotTimes.length - 1];
  const firstShot = shotTimes[0];

  const splitTimes = [];
  for (let i = 1; i < shotTimes.length; i++) {
    splitTimes.push(Number((shotTimes[i] - shotTimes[i - 1]).toFixed(3)));
  }

  const avgSplit =
    splitTimes.length > 0
      ? formatSplitCellValue((splitTimes.reduce((a, b) => a + b, 0) / splitTimes.length).toFixed(3))
      : "";

  const bestSplit =
    splitTimes.length > 0 ? formatSplitCellValue(Math.min(...splitTimes).toFixed(3)) : "";

  const worstSplit =
    splitTimes.length > 0 ? formatSplitCellValue(Math.max(...splitTimes).toFixed(3)) : "";

  const splitsRaw = splitTimes.map((time) => formatSplitForExport(time)).join(", ");

  const drill = findItemById(drillsRef.current, selectedDrillRef.current, "DrillID");
  const passTime = Number(drill?.PassTime || 0);

  let scoreValue = "";
  let computedPassFail = "";

  if (passTime > 0) {
    const overPar = Math.max(0, totalTime - passTime);
    const deductionSteps = Math.ceil(overPar / 0.1);
    scoreValue = Math.max(0, 100 - deductionSteps * 5);
    computedPassFail = totalTime <= passTime ? "Pass" : "Fail";
  }

  const manualQualification = qualificationLevel || "";

  const pendingSession = findItemById(
    sessionsRef.current,
    selectedSessionRef.current,
    "SessionID"
  );

  const timerStageScoringSessionType =
    getStageScoringSessionType(pendingSession, selectedSessionRef.current);
  const usesTimerStageScoring = Boolean(timerStageScoringSessionType);

  const timerUspsaPoints = usesTimerStageScoring ? uspsaScore.points : "";
  const timerUspsaHitFactor = usesTimerStageScoring ? uspsaScore.hitFactor : "";
  let timerVideoMeta = videoCaptureSessionRef.current.recordedMeta;

  if (!usesTimerStageScoring && timerVideoMeta?.localFilePath) {
    setVideoStatus(
      isFirebaseConfigured()
        ? "Uploading timer video to cloud storage..."
        : "Timer video saved locally only. Firebase is not configured."
    );

    try {
      const uploadFile = await buildUploadFile({
        filePath: timerVideoMeta.localFilePath,
        fileName: timerVideoMeta.name || "",
      });
      const uploadResult = await uploadVideoAttachment(uploadFile, {
        shooterId: selectedShooterRef.current,
        drillId: selectedDrillRef.current,
        sessionId: selectedSessionRef.current,
        source: "timer",
      });

      timerVideoMeta = {
        ...timerVideoMeta,
        url: uploadResult.url,
        rawUrl: uploadResult.rawUrl || timerVideoMeta.rawUrl || "",
        storage: uploadResult.uploaded ? "cloud" : timerVideoMeta.storage || "local-only",
        uploadedAt: uploadResult.uploaded ? new Date().toISOString() : timerVideoMeta.uploadedAt || "",
        status: uploadResult.uploaded ? "Uploaded" : timerVideoMeta.status || "Local only",
      };

      videoCaptureSessionRef.current = {
        ...videoCaptureSessionRef.current,
        recordedMeta: timerVideoMeta,
      };
      console.log("Timer video upload result:", timerVideoMeta);
      setVideoStatus(
        uploadResult.uploaded
          ? "Timer video uploaded. Saving run..."
          : "Timer video stayed local only. Saving run..."
      );
    } catch (error) {
      console.error("Timer video upload error:", error);
      console.error("Timer video upload error details:", {
        code: error?.code,
        message: error?.message,
        name: error?.name,
        full: error,
      });
      setVideoStatus(`Timer video upload failed: ${describeError(error)}`);
    }
  }

  const run = {
    timestamp: new Date().toISOString(),
    sessionId: selectedSessionRef.current,
    shooterId: selectedShooterRef.current,
    drillId: selectedDrillRef.current,
    totalTime: Number(totalTime.toFixed(3)),
    shotCount: shotTimes.length,
    firstShot: Number(firstShot.toFixed(3)),
    avgSplit,
    bestSplit,
    worstSplit,
    splitsRaw,
    source: "timer",
    score: usesTimerStageScoring ? timerUspsaPoints : scoreValue,
    passFail: computedPassFail,
    notes: "",
    qualificationLevel: manualQualification,
    videoUrl: timerVideoMeta?.url || "",
    videoRawUrl: timerVideoMeta?.rawUrl || "",
    videoFileName: timerVideoMeta?.name || "",
    scoringType: timerStageScoringSessionType,
    powerFactor: usesTimerStageScoring ? powerFactor : "",
    aHits: usesTimerStageScoring ? Number(aHits || 0) : "",
    cHits: usesTimerStageScoring ? Number(cHits || 0) : "",
    dHits: usesTimerStageScoring ? Number(dHits || 0) : "",
    misses: usesTimerStageScoring ? Number(misses || 0) : "",
    noShoots: usesTimerStageScoring ? Number(noShoots || 0) : "",
    steelHits: usesTimerStageScoring ? Number(steelHits || 0) : "",
    steelMisses: usesTimerStageScoring ? Number(steelMisses || 0) : "",
    totalPoints: timerUspsaPoints,
    hitFactor: timerUspsaHitFactor,
    stageName: stageName || "Course",
    totalRounds: calculateShooterTotalRounds(
      runsRef.current,
      selectedShooterRef.current,
      shotTimes.length
    ),
  };

  console.log("FINALIZE selectedSessionRef.current:", selectedSessionRef.current);
  console.log("FINALIZE pendingSession:", pendingSession);
  console.log("FINALIZE session name:", pendingSession?.SessionName);
  console.log("FINALIZE timerStageScoringSessionType:", timerStageScoringSessionType);

  if (usesTimerStageScoring) {
    console.log("OPENING USPSA POPUP", run);
    setPendingUspsaRun(run);
    setShowUspsaScoringModal(true);
    currentShots = [];
    setLiveShotTimes([]);
    return;
  }

  console.log("AUTO RUN:", run);

  let result = null;

  if (!isSavingRef.current) {
    isSavingRef.current = true;

    try {
      result = await apiSaveRun(run);
    } catch (e) {
      console.error("Save error:", e);
      setMessage(`Timer run save error: ${e.message || e}`);
    }

    isSavingRef.current = false;
  }

  console.log("AUTO SAVE RESPONSE:", result);

  if (result && result.success === true) {
    setMessage("Timer run saved.");
    setLastTimerRun(run);
    setLiveShotTimes([]);
    lastShotSnapshotRef.current = [];
    discardCurrentTimerRunRef.current = false;
    videoCaptureSessionRef.current = {
      active: false,
      awaitingStop: false,
      pendingFinalize: false,
      discardPending: false,
      recordedMeta: null,
    };
    handleMatchRunSaved(run);
    await load();
  } else {
    const errorText =
      result?.error ||
      result?.raw ||
      "Timer run did not save. Check Xcode logs for AUTO RUN and AUTO SAVE RESPONSE.";
    setMessage(errorText);
    console.error("Timer run save failed with result:", result);
  }

  currentShots = [];
  lastShotSnapshotRef.current = [];
}

async function completeUspsaScoringAndLog() {
  if (!pendingUspsaRun) return;

  const finalRun = {
    ...pendingUspsaRun,
    scoringType: pendingUspsaRun.scoringType || "USPSA",
    powerFactor,
    aHits: Number(aHits || 0),
    cHits: Number(cHits || 0),
    dHits: Number(dHits || 0),
    misses: Number(misses || 0),
    noShoots: Number(noShoots || 0),
    steelHits: Number(steelHits || 0),
    steelMisses: Number(steelMisses || 0),
    totalPoints: uspsaScore.points,
    hitFactor: uspsaScore.hitFactor,
    score: uspsaScore.points,
    stageName: stageName || "Course",
    totalRounds:
      pendingUspsaRun.totalRounds ||
      calculateShooterTotalRounds(
        runsRef.current,
        pendingUspsaRun.shooterId || pendingUspsaRun.ShooterID,
        pendingUspsaRun.shotCount || pendingUspsaRun.ShotCount || 0
      ),
  };

  // close popup immediately
  clearUspsaScoringState();

  try {
    setSaving(true);
    setMessage("");

    // small haptic tap
    if (Capacitor.isNativePlatform()) {
      await Haptics.impact({ style: ImpactStyle.Medium});
    }

    let finalRunToSave = { ...finalRun };

    if (pendingUspsaRun.videoFileName || pendingUspsaRun.videoUrl || videoCaptureSessionRef.current.recordedMeta?.localFilePath) {
      let scoringVideoMeta =
        pendingUspsaRun.videoFileName || pendingUspsaRun.videoUrl
          ? {
              name: pendingUspsaRun.videoFileName || "",
              url: pendingUspsaRun.videoUrl || "",
              localFilePath: videoCaptureSessionRef.current.recordedMeta?.localFilePath || "",
              rawUrl: videoCaptureSessionRef.current.recordedMeta?.rawUrl || "",
              storage: videoCaptureSessionRef.current.recordedMeta?.storage || "",
              uploadedAt: videoCaptureSessionRef.current.recordedMeta?.uploadedAt || "",
              status: videoCaptureSessionRef.current.recordedMeta?.status || "",
            }
          : videoCaptureSessionRef.current.recordedMeta;

      if (scoringVideoMeta?.localFilePath) {
        setVideoStatus(
          isFirebaseConfigured()
            ? "Uploading timer video to cloud storage..."
            : "Timer video saved locally only. Firebase is not configured."
        );

        try {
          const uploadFile = await buildUploadFile({
            filePath: scoringVideoMeta.localFilePath,
            fileName: scoringVideoMeta.name || "",
          });
          const uploadResult = await uploadVideoAttachment(uploadFile, {
            shooterId: pendingUspsaRun.shooterId,
            drillId: pendingUspsaRun.drillId,
            sessionId: pendingUspsaRun.sessionId,
            source: "timer",
          });

          scoringVideoMeta = {
            ...scoringVideoMeta,
            name: scoringVideoMeta.name || pendingUspsaRun.videoFileName || "",
            url: uploadResult.url,
            rawUrl: uploadResult.rawUrl || scoringVideoMeta.rawUrl || "",
            storage: uploadResult.uploaded ? "cloud" : scoringVideoMeta.storage || "local-only",
            uploadedAt: uploadResult.uploaded ? new Date().toISOString() : scoringVideoMeta.uploadedAt || "",
            status: uploadResult.uploaded ? "Uploaded" : scoringVideoMeta.status || "Local only",
          };

          finalRunToSave = {
            ...finalRunToSave,
            videoUrl: scoringVideoMeta?.url || "",
            videoRawUrl: scoringVideoMeta?.rawUrl || "",
            videoFileName: scoringVideoMeta?.name || "",
          };

          videoCaptureSessionRef.current = {
            ...videoCaptureSessionRef.current,
            recordedMeta: scoringVideoMeta,
          };
        } catch (error) {
          console.error("Timer video upload during stage scoring failed:", error);
          setVideoStatus(`Timer video upload failed: ${describeError(error)}`);
        }
      }
    }

    const response = await apiSaveRun(finalRunToSave);

    if (response && response.success) {
      setMessage("USPSA run saved.");
      setLastTimerRun(finalRunToSave);
      setLiveShotTimes([]);
      lastShotSnapshotRef.current = [];
      currentShots = [];
      discardCurrentTimerRunRef.current = false;
      videoCaptureSessionRef.current = {
        active: false,
        awaitingStop: false,
        pendingFinalize: false,
        discardPending: false,
        recordedMeta: null,
      };
      handleMatchRunSaved(finalRunToSave);
      await load();
    } else {
      setMessage("USPSA run did not save.");
    }
  } catch (error) {
    console.error("USPSA save error:", error);
    setMessage(`Error saving USPSA run: ${error.message}`);
  } finally {
    setSaving(false);
  }
}

const uspsaScore = calculateUspsaScore();

function clearUspsaScoringState() {
  setShowUspsaScoringModal(false);
  setPendingUspsaRun(null);
  setPowerFactor("minor");
  setAHits("");
  setCHits("");
  setDHits("");
  setMisses("");
  setNoShoots("");
  setSteelHits("");
  setSteelMisses("");
  setStageName("");
}

function adjustUspsaValue(setter, currentValue, delta) {
  const next = Math.max(0, Number(currentValue || 0) + delta);
  setter(String(next));
}

function calculateUspsaScore() {
  const a = Number(aHits || 0);
  const c = Number(cHits || 0);
  const d = Number(dHits || 0);
  const m = Number(misses || 0);
  const ns = Number(noShoots || 0);
  const sh = Number(steelHits || 0);
  const sm = Number(steelMisses || 0);

  const cValue = powerFactor === "major" ? 4 : 3;
  const dValue = powerFactor === "major" ? 2 : 1;

  const points =
    a * 5 +
    c * cValue +
    d * dValue +
    sh * 5 -
    m * 10 -
    ns * 10 -
    sm * 10;

  const safePoints = Math.max(0, points);

  const timeSource = pendingUspsaRun?.totalTime || totalTime || 0;
  const timeNum = Number(timeSource);

  const hitFactor =
    timeNum > 0 ? Number((safePoints / timeNum).toFixed(4)) : "";

  return {
    points: safePoints,
    hitFactor,
  };
}

function handleTimerDisconnected() {
  console.log("Timer disconnected");

  setTimerConnected(false);
  setTimerDeviceName("");
  setTimerStatusMessage("Disconnected");
  setTimerRunning(false);

  eventCharRef.current = null;
  timerDeviceRef.current = null;
  timerServerRef.current = null;

  if (
    Capacitor.isNativePlatform() &&
    !nativeDisconnectingRef.current &&
    !nativeManualConnectInProgressRef.current
  ) {
    if (reconnectAttemptTimeoutRef.current) {
      clearTimeout(reconnectAttemptTimeoutRef.current);
    }

    reconnectAttemptTimeoutRef.current = setTimeout(() => {
      autoReconnectTimer();
    }, 1200);
  }
}

async function disconnectTimer() {
  try {
    if (Capacitor.isNativePlatform() && nativeDeviceIdRef.current) {
      nativeDisconnectingRef.current = true;

      if (nativeNotifyActiveRef.current) {
        try {
          await BleClient.stopNotifications(
            nativeDeviceIdRef.current,
            "7520ffff-14d2-4cda-8b6b-697c554c9311",
            "75200001-14d2-4cda-8b6b-697c554c9311"
          );
        } catch (err) {
          console.error("Stop notifications error:", err);
        }

        nativeNotifyActiveRef.current = false;
      }

      try {
        await BleClient.disconnect(nativeDeviceIdRef.current);
      } catch (err) {
        console.error("Native disconnect error:", err);
      }
    }

    if (eventCharRef.current) {
      eventCharRef.current.removeEventListener(
        "characteristicvaluechanged",
        handleTimerEvent
      );
    }

    if (timerDeviceRef.current?.gatt?.connected) {
      timerDeviceRef.current.gatt.disconnect();
    }
  } catch (err) {
    console.error("Disconnect error:", err);
  } finally {
    setTimerConnected(false);
    setTimerDeviceName("");
    setTimerStatusMessage("Disconnected");
    setTimerRunning(false);

    eventCharRef.current = null;
    timerDeviceRef.current = null;
    timerServerRef.current = null;

    nativeDeviceIdRef.current = "";
    nativeNotifyActiveRef.current = false;

    setTimeout(() => {
      nativeDisconnectingRef.current = false;
    }, 2000);

    if (reconnectAttemptTimeoutRef.current) {
      clearTimeout(reconnectAttemptTimeoutRef.current);
      reconnectAttemptTimeoutRef.current = null;
    }
  }
}

async function autoReconnectTimer() {
  try {
    if (nativeManualConnectInProgressRef.current) {
      console.log("Manual timer connect in progress — skipping auto reconnect");
      return;
    }

    setTimerStatusMessage("Attempting auto reconnect...");

    if (Capacitor.isNativePlatform()) {
      if (timerConnected || nativeDeviceIdRef.current || nativeScanInProgressRef.current) {
        return;
      }

      const savedDeviceId = localStorage.getItem("lastDeviceId");
      const savedDeviceName = localStorage.getItem("lastDeviceName") || "SG Timer";

      if (savedDeviceId) {
        const reconnected = await connectToNativeTimer({
          id: savedDeviceId,
          name: savedDeviceName,
        });

        if (reconnected) {
          return;
        }

        clearRememberedNativeTimer();
        setTimerStatusMessage("Saved timer unavailable. Scanning for nearby timers...");
      }

      await scanNativeBle();
      return;
    }

    if (!navigator.bluetooth?.getDevices) {
      console.log("Auto reconnect not supported in this browser");
      setTimerStatusMessage("Auto reconnect not supported. Click Connect Timer.");
      return;
    }

    const devices = await navigator.bluetooth.getDevices();
    const savedDevice = devices.find(
      (d) => d.name && d.name.startsWith("SG-")
    );

    if (!savedDevice) {
      console.log("No previously approved SG timer found");
      setTimerStatusMessage("Manual reconnect needed");
      return;
    }

    timerDeviceRef.current = savedDevice;
    savedDevice.removeEventListener("gattserverdisconnected", handleTimerDisconnected);
    savedDevice.addEventListener("gattserverdisconnected", handleTimerDisconnected);

    if (!savedDevice.gatt) {
      throw new Error("Saved device does not support GATT.");
    }

    const server = savedDevice.gatt.connected
      ? savedDevice.gatt
      : await savedDevice.gatt.connect();

    timerServerRef.current = server;

    const service = await server.getPrimaryService(
      "7520ffff-14d2-4cda-8b6b-697c554c9311"
    );

    const eventChar = await service.getCharacteristic(
      "75200001-14d2-4cda-8b6b-697c554c9311"
    );

    await eventChar.startNotifications();

    eventCharRef.current = eventChar;
    eventChar.removeEventListener("characteristicvaluechanged", handleTimerEvent);
    eventChar.addEventListener("characteristicvaluechanged", handleTimerEvent);

    setTimerConnected(true);
    setTimerDeviceName(savedDevice.name || "SG Timer");
    setTimerStatusMessage("Auto reconnect successful");

    console.log("Auto reconnected to timer");
  } catch (err) {
    console.error("Auto reconnect failed:", err);
    setTimerConnected(false);
    setTimerDeviceName("");
    setTimerStatusMessage("Manual reconnect needed");
  }
}

  if (isEventDisplayMode) {
    const eventTimestampLabel = eventDisplayNow.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    const eventDateLabel = eventDisplayNow.toLocaleDateString([], {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const formatEventSeconds = (value) =>
      Number.isFinite(Number(value)) && Number(value) > 0
        ? `${formatSplitForDisplay(Number(value).toFixed(2))}s`
        : "-";
    const leaderboardRows =
      eventDisplayLeaderboardMode === "training"
        ? eventDisplayTrainingLeaderboard.slice(0, 8)
        : eventDisplayUspsaLeaderboard.slice(0, 8);
    const splitRows = eventDisplayBestSplitRankings.slice(0, 5);
    const firstShotRows = eventDisplayBestFirstShotRankings.slice(0, 5);
    const splitMax = splitRows.length ? Math.max(...splitRows.map((row) => row.value)) : 0;
    const firstShotMax = firstShotRows.length ? Math.max(...firstShotRows.map((row) => row.value)) : 0;
    const eventDisplayTrainingBoardLabel =
      selectedEventDisplayTrainingBoard?.label || "Select a Date / Drill";
    const eventDisplayUspsaBoardLabel =
      selectedEventDisplayUspsaBoard?.label || "Select a Date / Drill";
    const eventDisplayBoardLabel =
      selectedEventDisplayBoard?.label ||
      (eventDisplayLeaderboardMode === "training"
        ? eventDisplayTrainingBoardLabel
        : eventDisplayUspsaBoardLabel);
    const eventDisplayUspsaSummaryRuns = eventDisplayUspsaRuns.length;
    const eventDisplayUspsaSummaryBestHF =
      eventDisplayUspsaLeaderboard.length > 0
        ? Math.max(...eventDisplayUspsaLeaderboard.map((row) => row.bestHitFactor || 0))
        : 0;
    const eventRecentCardStyle = {
      borderRadius: 22,
      padding: "20px 22px",
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(255,255,255,0.04)",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1.4fr) auto",
      gap: 18,
      alignItems: "center",
    };
    const eventStageCardStyle = {
      borderRadius: 22,
      padding: "20px 22px",
      border: "1px solid rgba(255,255,255,0.08)",
      background: "rgba(255,255,255,0.04)",
      display: "grid",
      gridTemplateColumns: "minmax(0, 1.2fr) auto",
      gap: 18,
      alignItems: "center",
    };

    return (
      <div
        style={{
          minHeight: "100vh",
          padding: "28px 36px",
          color: "#f3efe6",
          fontFamily: "Arial, sans-serif",
          background:
            "radial-gradient(circle at top left, rgba(200,163,106,0.16), transparent 28%), radial-gradient(circle at top right, rgba(146,98,43,0.22), transparent 24%), linear-gradient(180deg, #090909 0%, #111111 45%, #0a0a0a 100%)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "none",
            margin: "0 auto",
            display: "grid",
            gap: 22,
          }}
        >
          <div
            style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 28,
              padding: "26px 28px",
              border: "1px solid rgba(200, 163, 106, 0.28)",
              background:
                "linear-gradient(135deg, rgba(31,24,18,0.96), rgba(16,16,16,0.96))",
              boxShadow: "0 28px 80px rgba(0,0,0,0.36)",
            }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                background:
                  "linear-gradient(90deg, transparent 0%, rgba(200,163,106,0.08) 50%, transparent 100%)",
                opacity: 0.8,
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "relative",
                display: "grid",
                gridTemplateColumns: "1.4fr 1fr",
                gap: 18,
                alignItems: "center",
              }}
            >
              <div style={{ display: "grid", gap: 16 }}>
                <img
                  src={headerImg}
                  alt="JMT Performance"
                  style={{
                    width: "min(780px, 100%)",
                    maxWidth: "100%",
                    height: "auto",
                    display: "block",
                  }}
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gap: 12,
                  justifyItems: "end",
                  textAlign: "right",
                }}
              >
                <div
                  style={{
                    color: "#dfc28d",
                    fontSize: 14,
                    fontWeight: 800,
                    letterSpacing: 2.2,
                    textTransform: "uppercase",
                  }}
                >
                  Event Display
                </div>
                <div
                  style={{
                    fontSize: 54,
                    lineHeight: 1,
                    fontWeight: 800,
                    color: "#f7f1e5",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {eventTimestampLabel}
                </div>
                <div
                  style={{
                    color: "#b8aa8a",
                    fontSize: 20,
                    fontWeight: 600,
                  }}
                >
                  {eventDateLabel}
                </div>
              </div>
            </div>
          </div>

          {eventDisplayRecentOpen
            ? createPortal(
                <div
                  onClick={closeEventDisplayRecentRuns}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 100000,
                    background: "rgba(3,3,4,0.84)",
                    padding: 32,
                    display: "flex",
                    alignItems: "stretch",
                    justifyContent: "center",
                    opacity: eventDisplayRecentVisible ? 1 : 0,
                    transition: "opacity 220ms ease",
                  }}
                >
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: "100%",
                      maxWidth: 1400,
                      borderRadius: 30,
                      border: "1px solid rgba(200,163,106,0.28)",
                      background: "linear-gradient(180deg, rgba(17,17,18,0.98), rgba(10,10,10,0.98))",
                      boxShadow: "0 32px 90px rgba(0,0,0,0.42)",
                      padding: 28,
                      display: "grid",
                      gridTemplateRows: "auto 1fr",
                      gap: 20,
                      overflow: "hidden",
                      transform: eventDisplayRecentVisible ? "translateY(0) scale(1)" : "translateY(24px) scale(0.985)",
                      opacity: eventDisplayRecentVisible ? 1 : 0,
                      transition: "transform 220ms ease, opacity 220ms ease",
                    }}
                  >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 16,
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: "#c8a36a",
                        fontSize: 15,
                        fontWeight: 800,
                        letterSpacing: 2,
                        textTransform: "uppercase",
                        marginBottom: 4,
                      }}
                    >
                      Touchscreen View
                    </div>
                    <div style={{ color: "#f7f1e5", fontSize: 38, fontWeight: 800 }}>
                      Recent Runs
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={closeEventDisplayRecentRuns}
                    style={{
                      minWidth: 96,
                      height: 56,
                      borderRadius: 18,
                      border: "1px solid rgba(255,255,255,0.16)",
                      background: "rgba(255,255,255,0.08)",
                      color: "#f7f1e5",
                      fontSize: 26,
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </div>

                <div
                  style={{
                    overflowY: "auto",
                    display: "grid",
                    gap: 16,
                    paddingRight: 6,
                    minHeight: 0,
                    maxHeight: "100%",
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                    touchAction: "pan-y",
                  }}
                >
                  {eventDisplayRecentRuns.length === 0 ? (
                    <div style={{ color: "#b8aa8a", fontSize: 24, padding: "18px 0" }}>
                      No recent runs available yet.
                    </div>
                  ) : (
                    eventDisplayRecentRuns.map((entry) => {
                      const hasPlayableVideo = Boolean(getPlayableVideoUrl(entry.videoMeta));

                      return (
                        <div key={entry.id} style={eventRecentCardStyle}>
                          <div
                            onClick={() => openRunDetail(entry.run)}
                            style={{ minWidth: 0, display: "grid", gap: 8, cursor: "pointer" }}
                          >
                            <div
                              style={{
                                color: "#f7f1e5",
                                fontSize: 30,
                                fontWeight: 800,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {entry.shooter?.Name || entry.run.ShooterID || "Shooter"}
                            </div>
                            <div
                              style={{
                                color: "#d7c29a",
                                fontSize: 21,
                                fontWeight: 700,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {entry.drill?.DrillName || entry.run.DrillID || "Drill"}
                            </div>
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 10,
                                color: "#b8aa8a",
                                fontSize: 17,
                                fontWeight: 700,
                              }}
                            >
                              <span>{formatDate(getRunTimestamp(entry.run))}</span>
                              <span>•</span>
                              <span>{entry.session?.SessionName || entry.run.SessionID || "Session"}</span>
                              <span>•</span>
                              <span>{entry.run.TotalTime || "—"} sec</span>
                              <span>•</span>
                              <span>{entry.run.PassFail || "—"}</span>
                            </div>
                          </div>

                          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                            {hasPlayableVideo ? (
                              <button
                                type="button"
                                onClick={() => {
                                  const videoTitle = `${entry.shooter?.Name || "Shooter"} - ${entry.drill?.DrillName || "Run"}`;
                                  openEventDisplayRecentVideo(entry.videoMeta, videoTitle);
                                }}
                                style={{
                                  minWidth: 210,
                                  height: 74,
                                  borderRadius: 22,
                                  border: "1px solid rgba(200,163,106,0.3)",
                                  background: "linear-gradient(135deg, rgba(200,163,106,0.24), rgba(200,163,106,0.12))",
                                  color: "#f7f1e5",
                                  fontSize: 24,
                                  fontWeight: 800,
                                  cursor: "pointer",
                                  padding: "0 24px",
                                }}
                              >
                                Watch Video
                              </button>
                            ) : (
                              <div
                                style={{
                                  minWidth: 210,
                                  height: 74,
                                  borderRadius: 22,
                                  border: "1px solid rgba(255,255,255,0.08)",
                                  background: "rgba(255,255,255,0.04)",
                                  color: "#8f8572",
                                  fontSize: 22,
                                  fontWeight: 700,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: "0 24px",
                                }}
                              >
                                No Video
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                  </div>
                </div>,
                document.body
              )
            : null}

          {eventDisplayStagesOpen
            ? createPortal(
                <div
                  onClick={closeEventDisplayStages}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 100000,
                    background: "rgba(3,3,4,0.84)",
                    padding: 32,
                    display: "flex",
                    alignItems: "stretch",
                    justifyContent: "center",
                    opacity: eventDisplayStagesVisible ? 1 : 0,
                    transition: "opacity 220ms ease",
                  }}
                >
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: "100%",
                      maxWidth: 1440,
                      borderRadius: 30,
                      border: "1px solid rgba(200,163,106,0.28)",
                      background: "linear-gradient(180deg, rgba(17,17,18,0.98), rgba(10,10,10,0.98))",
                      boxShadow: "0 32px 90px rgba(0,0,0,0.42)",
                      padding: 28,
                      display: "grid",
                      gridTemplateRows: "auto 1fr",
                      gap: 20,
                      overflow: "hidden",
                      transform: eventDisplayStagesVisible ? "translateY(0) scale(1)" : "translateY(24px) scale(0.985)",
                      opacity: eventDisplayStagesVisible ? 1 : 0,
                      transition: "transform 220ms ease, opacity 220ms ease",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 16,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            color: "#c8a36a",
                            fontSize: 15,
                            fontWeight: 800,
                            letterSpacing: 2,
                            textTransform: "uppercase",
                            marginBottom: 4,
                          }}
                        >
                          Touchscreen View
                        </div>
                        <div style={{ color: "#f7f1e5", fontSize: 38, fontWeight: 800 }}>
                          Stages
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={closeEventDisplayStages}
                        style={{
                          minWidth: 96,
                          height: 56,
                          borderRadius: 18,
                          border: "1px solid rgba(255,255,255,0.16)",
                          background: "rgba(255,255,255,0.08)",
                          color: "#f7f1e5",
                          fontSize: 26,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        ×
                      </button>
                    </div>

                    <div
                      style={{
                        overflowY: "auto",
                        display: "grid",
                        gap: 16,
                        paddingRight: 6,
                      }}
                    >
                      {eventDisplayCoursesLoading ? (
                        <div style={{ color: "#b8aa8a", fontSize: 24, padding: "18px 0" }}>
                          Loading stages...
                        </div>
                      ) : eventDisplayCourses.length === 0 ? (
                        <div style={{ color: "#b8aa8a", fontSize: 24, padding: "18px 0" }}>
                          No shared stages available yet. Open the Course tab on the device that already has your PDFs so they can sync into the shared library.
                        </div>
                      ) : (
                        eventDisplayCourses.map((course) => (
                          <div key={course.id} style={eventStageCardStyle}>
                            <div style={{ minWidth: 0, display: "grid", gap: 8 }}>
                              <div
                                style={{
                                  color: "#f7f1e5",
                                  fontSize: 30,
                                  fontWeight: 800,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {course.title || "Course"}
                              </div>
                              <div
                                style={{
                                  color: "#d7c29a",
                                  fontSize: 21,
                                  fontWeight: 700,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {course.folder || "Stage"} • {course.sessionType || "Session"}
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  gap: 10,
                                  color: "#b8aa8a",
                                  fontSize: 17,
                                  fontWeight: 700,
                                }}
                              >
                                <span>{course.pdfFileName || "Briefing PDF"}</span>
                                {course.updatedAt ? (
                                  <>
                                    <span>•</span>
                                    <span>{formatDate(course.updatedAt)}</span>
                                  </>
                                ) : null}
                              </div>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    let stageUrl = String(course.storageUrl || "").trim();
                                    if (!stageUrl && course.storagePath) {
                                      const storage = getFirebaseStorageInstance();
                                      if (storage) {
                                        stageUrl = await getDownloadURL(ref(storage, course.storagePath));
                                      }
                                    }

                                    if (!stageUrl) {
                                      setMessage("No PDF found for this stage.");
                                      return;
                                    }

                                    setEventDisplayStagePdf({
                                      title: course.title || "Stage Briefing",
                                      url: stageUrl,
                                    });
                                    setEventDisplayStageViewerOpen(true);
                                  } catch (error) {
                                    console.error("Event display stage open error:", error);
                                    setMessage("Could not open that stage PDF.");
                                  }
                                }}
                                style={{
                                  minWidth: 210,
                                  height: 74,
                                  borderRadius: 22,
                                  border: "1px solid rgba(200,163,106,0.3)",
                                  background: "linear-gradient(135deg, rgba(200,163,106,0.24), rgba(200,163,106,0.12))",
                                  color: "#f7f1e5",
                                  fontSize: 24,
                                  fontWeight: 800,
                                  cursor: "pointer",
                                  padding: "0 24px",
                                }}
                              >
                                View Stage
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>,
                document.body
              )
            : null}

          {eventDisplayStageViewerOpen && eventDisplayStagePdf
            ? createPortal(
                <div
                  onClick={closeEventDisplayStageViewer}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 100001,
                    background: "rgba(0,0,0,0.9)",
                    padding: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{
                      width: "100%",
                      height: "100%",
                      borderRadius: 28,
                      border: "1px solid rgba(200,163,106,0.28)",
                      overflow: "hidden",
                      background: "#050505",
                      display: "grid",
                      gridTemplateRows: "auto 1fr",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 16,
                        padding: "20px 24px",
                        background: "rgba(0,0,0,0.72)",
                        borderBottom: "1px solid rgba(255,255,255,0.08)",
                      }}
                    >
                      <div style={{ color: "#f7f1e5", fontSize: 28, fontWeight: 800 }}>
                        {eventDisplayStagePdf.title || "Stage Briefing"}
                      </div>
                      <button
                        type="button"
                        onClick={closeEventDisplayStageViewer}
                        style={{
                          minWidth: 96,
                          height: 56,
                          borderRadius: 18,
                          border: "1px solid rgba(255,255,255,0.16)",
                          background: "rgba(255,255,255,0.08)",
                          color: "#f7f1e5",
                          fontSize: 26,
                          fontWeight: 700,
                          cursor: "pointer",
                        }}
                      >
                        ×
                      </button>
                    </div>

                    <iframe
                      title={eventDisplayStagePdf.title || "Stage Briefing"}
                      src={eventDisplayStagePdf.url}
                      style={{
                        width: "100%",
                        height: "100%",
                        border: "none",
                        background: "#111",
                      }}
                    />
                  </div>
                </div>,
                document.body
              )
            : null}

          {selectedRecentRun
            ? createPortal(
                <div
                  onClick={closeRecentRunDetail}
                  style={{
                    position: "fixed",
                    inset: 0,
                    background: "rgba(0,0,0,0.8)",
                    display: "flex",
                    alignItems: "flex-end",
                    justifyContent: "center",
                    zIndex: 1000001,
                    padding: 16,
                  }}
                >
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      width: "100%",
                      maxWidth: 900,
                      maxHeight: "84vh",
                      overflowY: "auto",
                      WebkitOverflowScrolling: "touch",
                      background: "linear-gradient(180deg, rgba(19,19,20,0.98), rgba(10,10,10,0.98))",
                      border: "1px solid rgba(200,163,106,0.24)",
                      borderRadius: 24,
                      boxShadow: "0 24px 80px rgba(0,0,0,0.42)",
                      padding: 20,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 12,
                        marginBottom: 14,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            color: "#c8a36a",
                            fontSize: 14,
                            fontWeight: 800,
                            letterSpacing: 1.8,
                            textTransform: "uppercase",
                          }}
                        >
                          Run Detail
                        </div>
                        <div style={{ fontSize: 24, fontWeight: 900, color: "#f7f1e5" }}>
                          {selectedRecentRun.shooter?.Name || selectedRecentRun.run.ShooterID} ·{" "}
                          {selectedRecentRun.drill?.DrillName || selectedRecentRun.run.DrillID}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={closeRecentRunDetail}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "#b8aa8a",
                          fontSize: 28,
                          cursor: "pointer",
                          lineHeight: 1,
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
                      <div style={infoPillStyle}><strong>Date:</strong><br />{formatDateOnly(getRunTimestamp(selectedRecentRun.run))}</div>
                      <div style={infoPillStyle}><strong>Session:</strong><br />{selectedRecentRun.session?.SessionName || selectedRecentRun.run.SessionID || "—"}</div>
                      <div style={infoPillStyle}><strong>Qual Level:</strong><br />{selectedRecentRun.run.QualificationLevel || "—"}</div>
                      <div style={infoPillStyle}><strong>Pass/Fail:</strong><br />{selectedRecentRun.run.PassFail || "—"}</div>
                      <div style={infoPillStyle}><strong>Score:</strong><br />{selectedRecentRun.run.Score || "—"}</div>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
                      <div style={infoPillStyle}><strong>Total:</strong><br />{selectedRecentRun.run.TotalTime || "—"}</div>
                      <div style={infoPillStyle}><strong>Shots:</strong><br />{selectedRecentRun.run.ShotCount || "—"}</div>
                      <div style={infoPillStyle}><strong>First:</strong><br />{selectedRecentRun.run.FirstShot || "—"}</div>
                      <div style={infoPillStyle}><strong>Avg Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.AvgSplit) || "—"}</div>
                      <div style={infoPillStyle}><strong>Best Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.BestSplit) || "—"}</div>
                      <div style={infoPillStyle}><strong>Worst Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.WorstSplit) || "—"}</div>
                    </div>

                    {[
                      selectedRecentRun.run.AHits,
                      selectedRecentRun.run.CHits,
                      selectedRecentRun.run.DHits,
                      selectedRecentRun.run.Misses,
                      selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots,
                      selectedRecentRun.run.SteelHits,
                      selectedRecentRun.run.SteelMisses,
                      selectedRecentRun.run.TotalPoints,
                      selectedRecentRun.run.HitFactor,
                      selectedRecentRun.run.PowerFactor,
                    ].some((value) => String(value ?? "").trim() !== "") ? (
                      <div
                        style={{
                          padding: 16,
                          borderRadius: 18,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(255,255,255,0.04)",
                          marginBottom: 16,
                        }}
                      >
                        <div style={sectionEyebrowStyle}>Scoring</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
                          <div style={infoPillStyle}><strong>A Hits:</strong><br />{selectedRecentRun.run.AHits || "—"}</div>
                          <div style={infoPillStyle}><strong>C Hits:</strong><br />{selectedRecentRun.run.CHits || "—"}</div>
                          <div style={infoPillStyle}><strong>D Hits:</strong><br />{selectedRecentRun.run.DHits || "—"}</div>
                          <div style={infoPillStyle}><strong>Misses:</strong><br />{selectedRecentRun.run.Misses || "—"}</div>
                          <div style={infoPillStyle}><strong>No Shoot:</strong><br />{selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots || "—"}</div>
                          <div style={infoPillStyle}><strong>Steel Hits:</strong><br />{selectedRecentRun.run.SteelHits || "—"}</div>
                          <div style={infoPillStyle}><strong>Steel Misses:</strong><br />{selectedRecentRun.run.SteelMisses || "—"}</div>
                          <div style={infoPillStyle}><strong>Total Points:</strong><br />{selectedRecentRun.run.TotalPoints || "—"}</div>
                          <div style={infoPillStyle}><strong>Hit Factor:</strong><br />{selectedRecentRun.run.HitFactor || "—"}</div>
                          <div style={infoPillStyle}><strong>Power Factor:</strong><br />{selectedRecentRun.run.PowerFactor || "—"}</div>
                        </div>
                      </div>
                    ) : null}

                    <div
                      style={{
                        padding: 16,
                        borderRadius: 18,
                        border: "1px solid rgba(255,255,255,0.08)",
                        background: "rgba(255,255,255,0.04)",
                        marginBottom: 16,
                      }}
                    >
                      <div style={sectionEyebrowStyle}>Notes</div>
                      <div style={{ color: selectedRecentRun.displayNotes ? "#f7f1e5" : "#b8aa8a", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                        {selectedRecentRun.displayNotes || "No notes added for this run."}
                      </div>
                    </div>
                  </div>
                </div>,
                document.body
              )
            : null}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr",
              gap: 22,
              alignItems: "stretch",
            }}
          >
            <div
              style={{
                borderRadius: 28,
                padding: 28,
                border: "1px solid rgba(200,163,106,0.22)",
                background: "linear-gradient(180deg, rgba(19,19,20,0.98), rgba(13,13,14,0.96))",
                boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
                <div>
                  <div style={{ color: "#c8a36a", fontSize: 14, fontWeight: 800, letterSpacing: 1.8, textTransform: "uppercase" }}>
                    {isEventDisplayRotatingAll
                      ? "All Leaderboards"
                      : eventDisplayLeaderboardMode === "training"
                      ? "Training Board"
                      : "USPSA Board"}
                  </div>
                  <div style={{ color: "#f7f1e5", fontSize: 34, fontWeight: 800 }}>
                    Leaderboard
                  </div>
                  <div style={{ color: "#b8aa8a", fontSize: 18, fontWeight: 700, marginTop: 6 }}>
                    {eventDisplayBoardLabel}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                  <select
                    value={selectedEventDisplayBoardOption?.combinedValue || "__all__"}
                    onChange={(event) => {
                      const nextValue = event.target.value || "__all__";
                      setEventDisplayBoardSelection(nextValue);

                      if (nextValue === "__all__") {
                        setEventDisplayRotationToken((current) => current + 1);
                      }
                    }}
                    style={{
                      minWidth: 420,
                      height: 68,
                      borderRadius: 20,
                      border: "1px solid rgba(200,163,106,0.28)",
                      background: "rgba(255,255,255,0.04)",
                      color: "#f7f1e5",
                      padding: "0 18px",
                      fontSize: 18,
                      fontWeight: 700,
                    }}
                    aria-label="Select leaderboard"
                    title="Select leaderboard"
                  >
                    {eventDisplayBoardDropdownOptions.length === 0 ? (
                      <option value="__all__" style={{ color: "#111" }}>
                        All Leaderboards
                      </option>
                    ) : (
                      eventDisplayBoardDropdownOptions.map((option) => (
                        <option key={option.combinedValue} value={option.combinedValue} style={{ color: "#111" }}>
                          {option.combinedValue === "__all__"
                            ? "All Leaderboards"
                            : `${option.mode === "training" ? "Training" : "USPSA"} - ${option.label}`}
                        </option>
                      ))
                    )}
                  </select>

                  <button
                    type="button"
                    onClick={() => {
                      if (eventDisplayRecentOpen) {
                        closeEventDisplayRecentRuns();
                      } else {
                        openEventDisplayRecentRuns();
                      }
                    }}
                    style={{
                      width: 68,
                      height: 68,
                      borderRadius: 20,
                      border: "1px solid rgba(200,163,106,0.28)",
                      background: eventDisplayRecentOpen
                        ? "linear-gradient(135deg, rgba(200,163,106,0.26), rgba(200,163,106,0.12))"
                        : "rgba(255,255,255,0.04)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                      boxShadow: eventDisplayRecentOpen
                        ? "0 0 24px rgba(200,163,106,0.24)"
                        : "none",
                      WebkitTapHighlightColor: "transparent",
                    }}
                    aria-label="Open recent runs"
                    title="Recent Runs"
                  >
                    <Trophy size={34} color="#c8a36a" />
                  </button>
                </div>
              </div>

              {leaderboardRows.length === 0 ? (
                <div style={{ color: "#b8aa8a", fontSize: 22, padding: "26px 0" }}>
                  {eventDisplayLeaderboardMode === "training"
                    ? "No training leaderboard data for that Date / Drill yet."
                    : "No USPSA leaderboard data for that Date / Drill yet."}
                </div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {eventDisplayLeaderboardMode === "training"
                    ? leaderboardRows.map((row, index) => (
                        <div
                          key={row.shooterId}
                          onClick={() => openRunDetail(row.detailRun)}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "92px minmax(280px, 1.9fr) repeat(4, minmax(124px, 1fr))",
                            alignItems: "center",
                            gap: 18,
                            padding: "18px 22px",
                            borderRadius: 22,
                            background:
                              index === 0
                                ? "linear-gradient(90deg, rgba(200,163,106,0.22), rgba(200,163,106,0.08))"
                                : "rgba(255,255,255,0.04)",
                            border:
                              index === 0
                                ? "1px solid rgba(200,163,106,0.34)"
                                : "1px solid rgba(255,255,255,0.06)",
                            cursor: row.detailRun ? "pointer" : "default",
                          }}
                        >
                          <div
                            style={{
                              color: index === 0 ? "#f5d8a1" : "#c8a36a",
                              fontSize: 36,
                              fontWeight: 900,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            #{index + 1}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                color: "#f7f1e5",
                                fontSize: 30,
                                fontWeight: 800,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {row.name}
                            </div>
                            <div style={{ color: "#b8aa8a", fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2 }}>
                              {row.level || "Shooter"} • {row.attempts} runs
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Best</div>
                            <div style={{ color: "#f7f1e5", fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{formatEventSeconds(row.best)}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Avg</div>
                            <div style={{ color: "#f7f1e5", fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{formatEventSeconds(row.average)}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Latest</div>
                            <div style={{ color: "#dbc7a1", fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{formatEventSeconds(row.latest)}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Passes</div>
                            <div style={{ color: "#93d6a1", fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{row.passCount}</div>
                          </div>
                        </div>
                      ))
                    : leaderboardRows.map((row, index) => (
                        <div
                          key={row.shooterId}
                          onClick={() => openRunDetail(row.detailRun)}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "92px minmax(260px, 1.7fr) repeat(4, minmax(118px, 1fr))",
                            alignItems: "center",
                            gap: 18,
                            padding: "18px 22px",
                            borderRadius: 22,
                            background:
                              index === 0
                                ? "linear-gradient(90deg, rgba(200,163,106,0.22), rgba(200,163,106,0.08))"
                                : "rgba(255,255,255,0.04)",
                            border:
                              index === 0
                                ? "1px solid rgba(200,163,106,0.34)"
                                : "1px solid rgba(255,255,255,0.06)",
                            cursor: row.detailRun ? "pointer" : "default",
                          }}
                        >
                          <div
                            style={{
                              color: index === 0 ? "#f5d8a1" : "#c8a36a",
                              fontSize: 36,
                              fontWeight: 900,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            #{index + 1}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                color: "#f7f1e5",
                                fontSize: 30,
                                fontWeight: 800,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {row.name}
                            </div>
                            <div style={{ color: "#b8aa8a", fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.2 }}>
                              {row.level || "Shooter"} • {row.runs} runs
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>HF</div>
                            <div style={{ color: "#f7f1e5", fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                              {row.bestHitFactor ? row.bestHitFactor.toFixed(4) : "-"}
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Points</div>
                            <div style={{ color: "#f7f1e5", fontSize: 28, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                              {row.totalPoints ? row.totalPoints.toFixed(0) : "-"}
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>Time</div>
                            <div style={{ color: "#dbc7a1", fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                              {formatEventSeconds(row.fastestTime)}
                            </div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ color: "#8f7d60", fontSize: 13, fontWeight: 800, textTransform: "uppercase", letterSpacing: 1.4 }}>
                              Stage %
                            </div>
                            <div style={{ color: "#93d6a1", fontSize: 26, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                              {`${Number(row.stagePercent || 0).toFixed(2)}%`}
                            </div>
                          </div>
                        </div>
                      ))}
                </div>
              )}
            </div>
          </div>

          <div
            style={{
              borderRadius: 28,
              padding: 24,
              border: "1px solid rgba(200,163,106,0.2)",
              background: "linear-gradient(180deg, rgba(17,17,18,0.98), rgba(10,10,10,0.98))",
              boxShadow: "0 24px 80px rgba(0,0,0,0.28)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <div style={{ color: "#c8a36a", fontSize: 14, fontWeight: 800, letterSpacing: 1.8, textTransform: "uppercase" }}>
                  Rotating Spotlight
                </div>
                <div style={{ color: "#f7f1e5", fontSize: 32, fontWeight: 800 }}>
                  {eventDisplaySlide === 0 ? "Split Leaders" : "First Shot Leaders"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {[0, 1].map((dot) => (
                  <div
                    key={dot}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: eventDisplaySlide === dot ? "#c8a36a" : "rgba(255,255,255,0.14)",
                      boxShadow: eventDisplaySlide === dot ? "0 0 18px rgba(200,163,106,0.55)" : "none",
                    }}
                  />
                ))}
              </div>
            </div>

            {eventDisplaySlide === 0 ? (
              <div style={{ display: "grid", gap: 14 }}>
                {splitRows.length === 0 ? (
                  <div style={{ color: "#b8aa8a", fontSize: 22, padding: "18px 0" }}>
                    No split data yet.
                  </div>
                ) : (
                  splitRows.map((row, index) => (
                    <div key={row.shooterId} style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 220px) 1fr 120px", gap: 14, alignItems: "center" }}>
                      <div style={{ color: "#c8a36a", fontSize: 24, fontWeight: 900 }}>#{index + 1}</div>
                      <div style={{ color: "#f7f1e5", fontSize: 24, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</div>
                      <div style={{ height: 18, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${splitMax > 0 ? Math.max(18, (row.value / splitMax) * 100) : 0}%`,
                            height: "100%",
                            borderRadius: 999,
                            background: "linear-gradient(90deg, rgba(200,163,106,0.45), rgba(200,163,106,0.95))",
                          }}
                        />
                      </div>
                      <div style={{ color: "#f7f1e5", fontSize: 24, fontWeight: 800, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatEventSeconds(row.value)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 14 }}>
                {firstShotRows.length === 0 ? (
                  <div style={{ color: "#b8aa8a", fontSize: 22, padding: "18px 0" }}>
                    No first shot data yet.
                  </div>
                ) : (
                  firstShotRows.map((row, index) => (
                    <div key={row.shooterId} style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 220px) 1fr 120px", gap: 14, alignItems: "center" }}>
                      <div style={{ color: "#c8a36a", fontSize: 24, fontWeight: 900 }}>#{index + 1}</div>
                      <div style={{ color: "#f7f1e5", fontSize: 24, fontWeight: 800, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.name}</div>
                      <div style={{ height: 18, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${firstShotMax > 0 ? Math.max(18, (row.value / firstShotMax) * 100) : 0}%`,
                            height: "100%",
                            borderRadius: 999,
                            background: "linear-gradient(90deg, rgba(200,163,106,0.45), rgba(200,163,106,0.95))",
                          }}
                        />
                      </div>
                      <div style={{ color: "#f7f1e5", fontSize: 24, fontWeight: 800, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatEventSeconds(row.value)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {activeRunVideo
          ? createPortal(
              <div
                onClick={closeRunVideoPlayer}
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "#000",
                  zIndex: 1000002,
                }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  onTouchStart={handleRunVideoTouchStart}
                  onTouchMove={handleRunVideoTouchMove}
                  onTouchEnd={handleRunVideoTouchEnd}
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "#000",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 12,
                      paddingTop: "max(22px, calc(env(safe-area-inset-top) + 18px))",
                      paddingRight: 22,
                      paddingBottom: 16,
                      paddingLeft: 22,
                      background: "linear-gradient(to bottom, rgba(0,0,0,0.78), rgba(0,0,0,0.22), transparent)",
                      position: "relative",
                      zIndex: 2,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 28,
                        fontWeight: 800,
                        color: "#fff",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {activeRunVideo.title || "Run Video"}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        closeRunVideoPlayer();
                      }}
                      style={{
                        minWidth: 96,
                        height: 56,
                        borderRadius: 18,
                        border: "1px solid rgba(255,255,255,0.16)",
                        background: "rgba(255,255,255,0.08)",
                        color: "#f7f1e5",
                        fontSize: 26,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                  </div>

                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minHeight: 0,
                      padding: "0 18px 18px",
                      position: "relative",
                      zIndex: 1,
                    }}
                  >
                    {activeRunVideo.mode === "iframe" ? (
                      <iframe
                        title={activeRunVideo.title || "Run Video"}
                        src={activeRunVideo.fallbackUrl || activeRunVideo.externalUrl || activeRunVideo.url}
                        allow="autoplay; fullscreen"
                        style={{
                          width: "100%",
                          height: "100%",
                          border: "none",
                          background: "#000",
                        }}
                      />
                    ) : (
                      <video
                        key={activeRunVideo.url}
                        controls
                        autoPlay
                        playsInline
                        preload="metadata"
                        controlsList="noremoteplayback"
                        disablePictureInPicture
                        disableRemotePlayback
                        src={activeRunVideo.url}
                        onError={handleRunVideoPlaybackError}
                        style={{
                          width: "100%",
                          height: "100%",
                          background: "#000",
                          objectFit: "contain",
                        }}
                      />
                    )}
                  </div>

                  {activeRunVideo.errorMessage ? (
                    <div
                      style={{
                        position: "absolute",
                        left: 20,
                        right: 20,
                        bottom: 84,
                        zIndex: 2,
                        textAlign: "center",
                        color: "#f8d7da",
                        fontSize: 18,
                        fontWeight: 700,
                        textShadow: "0 2px 12px rgba(0,0,0,0.55)",
                      }}
                    >
                      {activeRunVideo.errorMessage}
                    </div>
                  ) : null}

                  {activeRunVideo.externalUrl ? (
                    <div
                      style={{
                        position: "absolute",
                        left: 20,
                        right: 20,
                        bottom: 28,
                        zIndex: 2,
                        textAlign: "center",
                      }}
                    >
                      <button
                        type="button"
                        onClick={(event) =>
                          openRunVideoExternalLink(
                            event,
                            activeRunVideo.browserUrl || activeRunVideo.externalUrl
                          )
                        }
                        style={{
                          color: "#fff",
                          textDecoration: "underline",
                          fontSize: 20,
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          cursor: "pointer",
                          textShadow: "0 2px 12px rgba(0,0,0,0.55)",
                        }}
                      >
                        Open in browser instead
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>,
              document.body
            )
          : null}
      </div>
    );
  }

  return (
  <div>
    <PullToRefresh
  className="app-pull-refresh"
  pullDownThreshold={82}
  maxPullDownDistance={126}
  resistance={1.85}
  backgroundColor={theme.pageBg}
  onRefresh={async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        await Haptics.impact({ style: ImpactStyle.Light });
      } catch {
        // Ignore haptic issues on unsupported devices.
      }
    }

    await Promise.all([load(), wait(420)]);
  }}
  pullingContent={
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRadius: 999,
        background: theme.cardBgSoft,
        border: `1px solid ${theme.border}`,
        color: theme.subtext,
        fontSize: 14,
        fontWeight: 700,
        letterSpacing: 0.2,
        boxShadow: "0 10px 24px rgba(0, 0, 0, 0.08)",
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: "#b68b3d",
          opacity: 0.9,
          boxShadow: "0 0 0 4px rgba(182, 139, 61, 0.14)",
        }}
      />
      Pull to refresh
    </div>
  }
  refreshingContent={
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderRadius: 999,
        background: theme.cardBgSoft,
        border: `1px solid ${theme.border}`,
        color: "#c79b45",
        fontSize: 14,
        fontWeight: 800,
        letterSpacing: 0.2,
        boxShadow: "0 10px 24px rgba(0, 0, 0, 0.1)",
      }}
    >
      <span className="app-refresh-spinner" />
      Refreshing…
    </div>
  }
>
      <div
    style={{
      fontFamily: "Arial, sans-serif",
      background: theme.pageBg,
      minHeight: "100vh",
      paddingLeft: activeTab === "course" ? 0 : 16,
      paddingRight: activeTab === "course" ? 0 : 16,
      paddingBottom: Capacitor.isNativePlatform() ? 110 : 24,
      paddingTop: activeTab === "course" ? 0 : Capacitor.isNativePlatform() ? 90 : 16,
      transition: "background 0.25s ease, color 0.25s ease",
      overflow: activeTab === "course" ? "hidden" : "visible",
    }}
  >
    <div style={{ maxWidth: activeTab === "course" ? "none" : 1300, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 18, display: activeTab === "course" ? "none" : "block" }}>
        
    

  <img
  src={headerImg}
  alt="JMT Performance"
  onLoad={() => setHeaderLoaded(true)}
  style={{
    display: "block",
    margin: "0 auto 14px auto",
    width: "100%",
    maxWidth: Capacitor.isNativePlatform() ? 380 : 420,
    height: "auto",
    objectFit: "contain",

    // 👇 animation
    opacity: headerLoaded ? 1 : 0,
    transition: "opacity 0.6s ease",
  }}
/>

  <p
    style={{
      textAlign: "center",
      marginTop: 0,
      marginBottom: 16,
      color: theme.subtext,
      fontSize: Capacitor.isNativePlatform() ? 14 : 20,
      lineHeight: 1.35,
    }}
  >
    Range timer, shooter tracking, and performance logs.
  </p>
</div>
<style>
  {`
    @keyframes goldShimmerIn {
      0% {
        transform: scaleX(0.18);
        opacity: 0.45;
      }
      50% {
        transform: scaleX(1);
        opacity: 1;
      }
      100% {
        transform: scaleX(0.18);
        opacity: 0.45;
      }
    }
      @keyframes pulseGlow {
  0% {
    box-shadow: 0 0 10px rgba(127,29,29,0.6), 0 0 20px rgba(127,29,29,0.4);
  }
  50% {
    box-shadow: 0 0 18px rgba(127,29,29,0.9), 0 0 36px rgba(127,29,29,0.6);
  }
  100% {
    box-shadow: 0 0 10px rgba(127,29,29,0.6), 0 0 20px rgba(127,29,29,0.4);
  }
}
  @keyframes hapticPress {
  0% {
    transform: scale(1) translateY(0) translateX(0);
  }
  20% {
    transform: scale(0.985) translateY(2px) translateX(-0.5px);
  }
  40% {
    transform: scale(0.975) translateY(3px) translateX(0.5px);
  }
  60% {
    transform: scale(0.97) translateY(3px) translateX(-0.4px);
  }
  80% {
    transform: scale(0.978) translateY(2px) translateX(0.3px);
  }
  100% {
    transform: scale(0.97) translateY(3px) translateX(0);
  }
}
  `}
  
	</style>

	<div
	  style={{
	    ...boxStyle,
	    marginBottom: 20,
	    display: activeTab === "match" ? "block" : "none",
	  }}
	>
	  <div style={sectionEyebrowStyle}>Roster Flow</div>
	  <h2 style={sectionTitleStyle}>Match Mode</h2>
	  <p style={sectionSubtitleStyle}>
	    Build a single-stage match roster, then the app will auto-load each shooter and advance after every saved run.
	  </p>

	  {!activeMatch ? (
	    <div style={{ display: "grid", gap: 16 }}>
	      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
	        <input
	          style={inputStyle}
	          placeholder="Match name"
	          value={matchNameInput}
	          onChange={(e) => setMatchNameInput(e.target.value)}
	        />
	        <select style={inputStyle} value={matchDrillId} onChange={(e) => setMatchDrillId(e.target.value)}>
	          <option value="">Select drill</option>
	          {drills.map((drill) => (
	            <option key={drill.DrillID} value={String(drill.DrillID)}>
	              {drill.DrillName}
	            </option>
	          ))}
	        </select>
	        <select style={inputStyle} value={matchSessionId} onChange={(e) => setMatchSessionId(e.target.value)}>
	          <option value="">Select session</option>
	          {sessions.map((session) => (
	            <option key={session.SessionID} value={String(session.SessionID)}>
	              {session.SessionName || session.Name || session.SessionID}
	            </option>
	          ))}
	        </select>
	      </div>

	      <div style={{ ...tableContainerStyle, padding: 16 }}>
	        <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
	          Add Shooters
	        </div>
	        <input
	          style={{ ...inputStyle, marginBottom: 12 }}
	          placeholder="Search shooters to add"
	          value={matchShooterSearch}
	          onChange={(e) => setMatchShooterSearch(e.target.value)}
	        />
	        <div style={{ display: "grid", gap: 10, maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
	          {filteredMatchShooterOptions.map((shooter) => (
	            <button
	              key={shooter.ShooterID}
	              type="button"
	              onClick={() => addShooterToMatchRoster(shooter.ShooterID)}
	              style={{
	                ...secondaryButtonStyle,
	                justifyContent: "space-between",
	                textAlign: "left",
	                width: "100%",
	              }}
	            >
	              <span>{shooter.Name}{shooter.Level ? ` (L${shooter.Level})` : ""}</span>
	              <Plus size={18} />
	            </button>
	          ))}
	          {!filteredMatchShooterOptions.length ? (
	            <div style={{ color: theme.subtext, textAlign: "center", padding: "10px 0" }}>
	              No shooters match that search.
	            </div>
	          ) : null}
	        </div>
	      </div>

	      <div style={{ ...tableContainerStyle, padding: 16 }}>
	        <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
	          Match Roster
	        </div>
          <div style={{ color: theme.subtext, fontSize: 13, marginBottom: 12 }}>
            Use the reorder buttons to adjust the running order.
          </div>
	        {matchRosterIds.length ? (
	          <div style={{ display: "grid", gap: 10 }}>
	            {matchRosterIds.map((shooterId, index) => {
	              const shooter = findItemById(shooters, shooterId, "ShooterID");
                const isFirst = index === 0;
                const isLast = index === matchRosterIds.length - 1;
	              return (
	                <div
	                  key={`match-roster-top-${shooterId}`}
	                  style={{
	                    display: "grid",
	                    gridTemplateColumns: "48px minmax(0, 1fr) auto",
	                    gap: 12,
	                    alignItems: "center",
	                    padding: 12,
	                    borderRadius: 14,
	                    background: theme.cardBgSoft,
	                    border: `1px solid ${theme.border}`,
	                  }}
	                >
	                  <div style={{ fontSize: 18, fontWeight: 800, color: theme.accent, textAlign: "center" }}>
	                    {index + 1}
	                  </div>
	                  <div style={{ minWidth: 0, paddingRight: 10 }}>
	                    <div style={{ color: theme.text, fontWeight: 800, fontSize: 18 }}>
	                      {shooter?.Name || shooterId}
	                    </div>
	                    <div style={{ color: theme.subtext, fontSize: 14 }}>
	                      {shooter?.Level ? `Level ${shooter.Level}` : "Shooter"}
	                    </div>
	                  </div>
	                  <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", marginLeft: 8 }}>
	                    <button
                        type="button"
                        style={{
                          ...secondaryButtonStyle,
                          width: 36,
                          minWidth: 36,
                          height: 36,
                          padding: 0,
                          opacity: isFirst ? 0.45 : 1,
                          cursor: isFirst ? "not-allowed" : "pointer",
                        }}
                        onClick={() => moveMatchRosterShooter(shooterId, "up")}
                        disabled={isFirst}
                        aria-label="Move shooter up"
                      >
                        <ChevronUp size={18} />
                      </button>
	                    <button
                        type="button"
                        style={{
                          ...secondaryButtonStyle,
                          width: 36,
                          minWidth: 36,
                          height: 36,
                          padding: 0,
                          opacity: isLast ? 0.45 : 1,
                          cursor: isLast ? "not-allowed" : "pointer",
                        }}
                        onClick={() => moveMatchRosterShooter(shooterId, "down")}
                        disabled={isLast}
                        aria-label="Move shooter down"
                      >
                        <ChevronDown size={18} />
                      </button>
	                    <button
                        type="button"
                        style={{
                          ...secondaryButtonStyle,
                          width: 36,
                          minWidth: 36,
                          height: 36,
                          padding: 0,
                        }}
                        onClick={() => removeShooterFromMatchRoster(shooterId)}
                        aria-label="Remove shooter"
                      >
                        <Trash2 size={16} />
	                  </button>
	                  </div>
	                </div>
	              );
	            })}
	          </div>
	        ) : (
	          <div style={{ color: theme.subtext }}>
	            Add shooters to build the running order.
	          </div>
	        )}
	      </div>

	      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
	        <button
            type="button"
            style={{
              ...buttonStyle,
              opacity: !matchDrillId || !matchSessionId || matchRosterIds.length === 0 ? 0.7 : 1,
              cursor: !matchDrillId || !matchSessionId || matchRosterIds.length === 0 ? "not-allowed" : "pointer",
            }}
            onClick={startMatch}
            disabled={!matchDrillId || !matchSessionId || matchRosterIds.length === 0}
          >
	          Start Match
	        </button>
	        <button type="button" style={secondaryButtonStyle} onClick={resetMatchBuilder}>
	          Clear Builder
	        </button>
	      </div>
	    </div>
	  ) : (
	    <div style={{ display: "grid", gap: 16 }}>
	      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
	        <div style={infoPillStyle}><strong>Match:</strong><br />{activeMatch.name}</div>
	        <div style={infoPillStyle}><strong>Drill:</strong><br />{findItemById(drills, activeMatch.drillId, "DrillID")?.DrillName || activeMatch.drillId}</div>
	        <div style={infoPillStyle}><strong>Session:</strong><br />{findItemById(sessions, activeMatch.sessionId, "SessionID")?.SessionName || activeMatch.sessionId}</div>
	        <div style={infoPillStyle}><strong>Progress:</strong><br />{Math.min((activeMatch.currentIndex || 0) + 1, activeMatch.shooterIds.length)} / {activeMatch.shooterIds.length}</div>
	      </div>

	      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
	        <div style={{ ...tableContainerStyle, padding: 18 }}>
	          <div style={sectionEyebrowStyle}>Now Up</div>
	          <div style={{ fontSize: 28, fontWeight: 900, color: theme.text }}>
	            {activeMatchCurrentShooter?.Name || "Done"}
	          </div>
	        </div>
	        <div style={{ ...tableContainerStyle, padding: 18 }}>
	          <div style={sectionEyebrowStyle}>On Deck</div>
	          <div style={{ fontSize: 24, fontWeight: 800, color: theme.text }}>
	            {activeMatchNextShooter?.Name || "No one"}
	          </div>
	        </div>
	      </div>

	      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
	        <button type="button" style={buttonStyle} onClick={() => { syncMatchSelection(activeMatch); setActiveTab("timer"); }}>
	          <Play size={18} /> Open Timer
	        </button>
	        <button type="button" style={secondaryButtonStyle} onClick={skipCurrentMatchShooter}>
	          <SkipForward size={18} /> Skip Shooter
	        </button>
	        <button type="button" style={secondaryButtonStyle} onClick={() => finishMatch()}>
	          <CheckCircle2 size={18} /> Finish Match
	        </button>
	      </div>

	      <div style={{ ...tableContainerStyle, padding: 16 }}>
	        <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
	          Roster Status
	        </div>
	        <div style={{ display: "grid", gap: 10 }}>
	          {activeMatch.shooterIds.map((shooterId, index) => {
	            const shooter = findItemById(shooters, shooterId, "ShooterID");
	            const result = (activeMatch.results || []).find(
	              (entry) => String(entry.shooterId) === String(shooterId)
	            );
	            const isCurrent = index === activeMatch.currentIndex;
	            return (
	              <div
	                key={`active-match-top-${shooterId}`}
	                style={{
	                  display: "grid",
	                  gridTemplateColumns: "56px minmax(0, 1fr) auto",
	                  gap: 10,
	                  alignItems: "center",
	                  padding: 12,
	                  borderRadius: 14,
	                  background: isCurrent ? theme.accentSoft : theme.cardBgSoft,
	                  border: `1px solid ${isCurrent ? theme.accent : theme.border}`,
	                }}
	              >
	                <div style={{ fontSize: 18, fontWeight: 800, color: theme.accent, textAlign: "center" }}>
	                  {index + 1}
	                </div>
	                <div>
	                  <div style={{ color: theme.text, fontWeight: 800, fontSize: 18 }}>
	                    {shooter?.Name || shooterId}
	                  </div>
	                  <div style={{ color: theme.subtext, fontSize: 14 }}>
	                    {result ? `Saved ${result.totalTime || "—"}s • ${result.passFail || "Scored"}` : isCurrent ? "Current shooter" : "Waiting"}
	                  </div>
	                </div>
	                <div style={{ color: result ? theme.successText : isCurrent ? theme.accent : theme.subtext, fontWeight: 800 }}>
	                  {result ? "Done" : isCurrent ? "Up" : "Queued"}
	                </div>
	              </div>
	            );
	          })}
	        </div>
	      </div>
	    </div>
	  )}
	</div>

	      </div>

	        <div
 style={{
    ...boxStyle,
    background: theme.pageBg, // 🔥 force true black
    marginTop: -8,
    marginBottom: 20,
    border: "none",
    boxShadow: "none",
    display: activeTab === "timer" ? "block" : "none",
  }}
>
  {isFirebaseConfigured() && hasMainAppAccess ? (
    <div
      style={{
        ...boxStyle,
        marginBottom: 18,
        background: theme.cardBgSoft,
        border: `1px solid ${theme.border}`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 14,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={sectionEyebrowStyle}>{hasAdminAccess ? "Admin Account" : "Instructor Account"}</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>
            {authProfile?.displayName || authUser?.displayName || authUser?.email || (hasAdminAccess ? "Admin" : "Instructor")}
          </div>
          <div style={{ color: theme.subtext, marginTop: 6, lineHeight: 1.45 }}>
            Signed in as {authUser?.email || "your account"}.
            {hasAdminAccess
              ? " Admin accounts can manage user roles and link students to shooter profiles."
              : " Instructor accounts can use the main training app, timer, logging, matches, courses, and leaderboards."}
          </div>
          {!hasAdminAccess ? (
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 14,
                border: `1px solid ${theme.border}`,
                background: theme.cardBg,
                color: theme.subtext,
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              If this is your owner account, make it Admin before tightening Firebase rules.
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {hasAdminAccess ? (
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => {
                setAdminCreateAccountOpen((current) => !current);
                setStudentAccountMessage("");
              }}
            >
              {adminCreateAccountOpen ? "Close Create Account" : "Create Account"}
            </button>
          ) : null}
          {hasAdminAccess ? (
            <button type="button" style={secondaryButtonStyle} onClick={loadStudentAccounts}>
              Refresh Accounts
            </button>
          ) : null}
          <button type="button" style={secondaryButtonStyle} onClick={handleSignOut}>
            Sign Out
          </button>
        </div>
      </div>

      {studentAccountMessage ? (
        <div
          style={{
            marginBottom: 14,
            padding: "12px 14px",
            borderRadius: 14,
            background: theme.accentSoft,
            border: `1px solid ${theme.border}`,
            color: theme.text,
            fontWeight: 700,
          }}
        >
          {studentAccountMessage}
        </div>
      ) : null}

      {hasAdminAccess ? (
      <div style={{ display: "grid", gap: 14 }}>
        {adminCreateAccountOpen ? (
          <div
            style={{
              padding: 16,
              borderRadius: 18,
              border: `1px solid ${theme.border}`,
              background: theme.cardBg,
              display: "grid",
              gap: 12,
            }}
          >
            <div>
              <div style={{ ...sectionEyebrowStyle, marginBottom: 4 }}>Admin Create Account</div>
              <div style={{ color: theme.text, fontSize: 22, fontWeight: 900 }}>
                Add Student or Instructor
              </div>
              <div style={{ color: theme.subtext, marginTop: 6, lineHeight: 1.45 }}>
                Create a login without leaving your admin session. Student accounts can be linked to a shooter profile right away.
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <input
                style={inputStyle}
                placeholder="Full name"
                value={adminCreateAccountName}
                onChange={(event) => setAdminCreateAccountName(event.target.value)}
                autoComplete="off"
              />
              <input
                style={inputStyle}
                placeholder="Email"
                value={adminCreateAccountEmail}
                onChange={(event) => setAdminCreateAccountEmail(event.target.value)}
                autoComplete="off"
                type="email"
              />
              <input
                style={inputStyle}
                placeholder="Temporary password"
                value={adminCreateAccountPassword}
                onChange={(event) => setAdminCreateAccountPassword(event.target.value)}
                autoComplete="new-password"
                type="password"
              />
              <select
                style={inputStyle}
                value={adminCreateAccountRole}
                onChange={(event) => {
                  const nextRole = String(event.target.value || "student");
                  setAdminCreateAccountRole(nextRole);
                  if (nextRole !== "student") {
                    setAdminCreateAccountShooterId("");
                  }
                }}
              >
                <option value="student">Student</option>
                <option value="instructor">Instructor</option>
              </select>
            </div>

            {adminCreateAccountRole === "student" ? (
              <select
                style={inputStyle}
                value={adminCreateAccountShooterId}
                onChange={(event) => setAdminCreateAccountShooterId(event.target.value)}
              >
                <option value="">No shooter linked yet</option>
                {shooters.map((shooter) => (
                  <option key={`admin-create-shooter-${shooter.ShooterID}`} value={shooter.ShooterID}>
                    {shooter.Name}
                    {shooter.Level ? ` • Level ${shooter.Level}` : ""}
                  </option>
                ))}
              </select>
            ) : null}

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                style={buttonStyle}
                onClick={handleAdminCreateAccount}
                disabled={adminCreateAccountSaving}
              >
                {adminCreateAccountSaving ? "Creating Account..." : "Create Account"}
              </button>
              <button
                type="button"
                style={secondaryButtonStyle}
                onClick={() => {
                  setAdminCreateAccountOpen(false);
                  setAdminCreateAccountName("");
                  setAdminCreateAccountEmail("");
                  setAdminCreateAccountPassword("");
                  setAdminCreateAccountRole("student");
                  setAdminCreateAccountShooterId("");
                }}
                disabled={adminCreateAccountSaving}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {studentAccountsLoading ? (
          <div style={{ color: theme.subtext }}>Loading student accounts...</div>
        ) : instructorStudentAccounts.length === 0 ? (
          <div style={{ color: theme.subtext }}>
            No account profiles found yet. If a student signed in but does not show here, their profile may not have saved to Firebase.
          </div>
        ) : (
          <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 10,
            }}
          >
            <div style={{ ...infoPillStyle, background: theme.cardBg }}>
              <strong>Total Accounts</strong>
              <br />
              <span style={{ fontSize: 26, fontWeight: 900 }}>{instructorStudentAccounts.length}</span>
            </div>
            <div
              style={{
                ...infoPillStyle,
                background: unlinkedStudentAccounts.length ? "rgba(248,113,113,0.12)" : theme.cardBg,
                border: `1px solid ${unlinkedStudentAccounts.length ? "rgba(248,113,113,0.38)" : theme.border}`,
              }}
            >
              <strong>Needs Linking</strong>
              <br />
              <span style={{ fontSize: 26, fontWeight: 900, color: unlinkedStudentAccounts.length ? theme.dangerText : theme.text }}>
                {unlinkedStudentAccounts.length}
              </span>
            </div>
          </div>
          {unlinkedStudentAccounts.length ? (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 16,
                border: "1px solid rgba(248,113,113,0.38)",
                background: "rgba(248,113,113,0.12)",
                color: theme.text,
                fontWeight: 800,
                lineHeight: 1.4,
              }}
            >
              Action needed: {unlinkedStudentAccounts.length} student account{unlinkedStudentAccounts.length === 1 ? "" : "s"} still need shooter links.
            </div>
          ) : null}
          {adminAccountGroups.map((group) => (
            <div
              key={`admin-account-group-${group.key}`}
              style={{
                border: `1px solid ${theme.border}`,
                borderRadius: 18,
                background: theme.cardBg,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  padding: 14,
                  background: theme.headerBg,
                  borderBottom: `1px solid ${theme.border}`,
                }}
              >
                <div>
                  <div style={{ color: theme.text, fontSize: 18, fontWeight: 900 }}>
                    {group.title}
                  </div>
                  <div style={{ color: theme.subtext, fontSize: 13, marginTop: 4, lineHeight: 1.35 }}>
                    {group.subtitle}
                  </div>
                </div>
                <div
                  style={{
                    minWidth: 42,
                    height: 42,
                    borderRadius: 14,
                    display: "grid",
                    placeItems: "center",
                    color: theme.accent,
                    background: theme.accentSoft,
                    fontSize: 20,
                    fontWeight: 900,
                  }}
                >
                  {group.accounts.length}
                </div>
              </div>

              <div style={{ display: "grid", gap: 10, padding: 12 }}>
                {group.accounts.length === 0 ? (
                  <div style={{ color: theme.subtext, padding: "8px 2px" }}>
                    No {group.title.toLowerCase()} yet.
                  </div>
                ) : (
                  group.accounts.map((profile) => {
                    const needsLink = group.key === "student" && !profile.linkedShooterId;

                    return (
                    <div
                      key={profile.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1.2fr) minmax(220px, 1fr)",
                        gap: 12,
                        alignItems: "center",
                        padding: 14,
                        borderRadius: 16,
                        border: `1px solid ${needsLink ? "rgba(248,113,113,0.48)" : theme.border}`,
                        background: needsLink ? "rgba(248,113,113,0.10)" : theme.cardBgSoft,
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 18, fontWeight: 800, color: theme.text }}>
                            {profile.displayName || profile.email || profile.id}
                          </div>
                          {needsLink ? (
                            <span
                              style={{
                                padding: "4px 8px",
                                borderRadius: 999,
                                background: "rgba(248,113,113,0.18)",
                                color: theme.dangerText,
                                border: "1px solid rgba(248,113,113,0.38)",
                                fontSize: 11,
                                fontWeight: 900,
                                letterSpacing: 0.5,
                                textTransform: "uppercase",
                              }}
                            >
                              Needs Link
                            </span>
                          ) : null}
                        </div>
                        <div style={{ color: theme.subtext, marginTop: 4, fontSize: 14, overflowWrap: "anywhere" }}>
                          {profile.email || "No email"}
                        </div>
                        <div style={{ color: needsLink ? theme.dangerText : theme.subtext, marginTop: 6, fontSize: 13, fontWeight: 800 }}>
                          {profile.linkedShooter
                            ? `Linked to ${profile.linkedShooter.Name}${profile.linkedShooter.Level ? ` • Level ${profile.linkedShooter.Level}` : ""}`
                            : group.key === "student"
                            ? "Choose a shooter below to activate this dashboard"
                            : "No shooter link required"}
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        <select
                          style={inputStyle}
                          value={String(profile.role || "student").trim().toLowerCase() || "student"}
                          onChange={(event) => handleAccountRoleSave(profile.id, event.target.value)}
                          disabled={studentAccountSavingUid === profile.id}
                        >
                          <option value="admin">Admin</option>
                          <option value="instructor">Instructor</option>
                          <option value="student">Student</option>
                        </select>
                        <select
                          style={{
                            ...inputStyle,
                            borderColor: needsLink ? "rgba(248,113,113,0.55)" : theme.border,
                          }}
                          value={profile.linkedShooterId}
                          onChange={(event) => handleStudentLinkSave(profile.id, event.target.value)}
                          disabled={studentAccountSavingUid === profile.id || String(profile.role || "").toLowerCase() !== "student"}
                        >
                          <option value="">No linked shooter</option>
                          {shooters.map((shooter) => (
                            <option key={`student-link-${profile.id}-${shooter.ShooterID}`} value={String(shooter.ShooterID)}>
                              {shooter.Name}
                              {shooter.Level ? ` • L${shooter.Level}` : ""}
                            </option>
                          ))}
                        </select>
                        {studentAccountSavingUid === profile.id ? (
                          <div style={{ color: theme.subtext, fontSize: 13, fontWeight: 700 }}>
                            Saving account...
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                  })
                )}
              </div>
            </div>
          ))}
          </>
        )}
      </div>
      ) : null}
    </div>
  ) : null}
  <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
       <div
  style={{
    width: "100%",
    padding: "8px 4px",
    marginBottom: 16,
  }}
>
  <div
  style={{
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1.6,
    color: theme.subtext,
    marginBottom: 4,
    opacity: 0.7,
  }}
>
  CONTROL PANEL
</div>

  <div
  style={{
    fontSize: 26,
    fontWeight: 900,
    color: "#d4af37",
    textShadow: "0 0 10px rgba(212,175,55,0.35)",
  }}
>
  Live Timer Control
</div>
  <div
  style={{
    position: "relative",
    marginTop: 10,
    height: 2,
    width: "100%",
    borderRadius: 2,
    background: "rgba(212,175,55,0.18)",
    overflow: "hidden",
  }}
>
  <div
    style={{
      position: "absolute",
      inset: 0,
      width: "50%",
      background: "linear-gradient(90deg, #d4af37, rgba(212,175,55,0.55), transparent)",
      transformOrigin: "left center",
      animation: "goldShimmerIn 2.2s ease-in-out infinite",
    }}
  />
  <div
    style={{
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      width: "50%",
      background: "linear-gradient(270deg, #d4af37, rgba(212,175,55,0.55), transparent)",
      transformOrigin: "right center",
      animation: "goldShimmerIn 2.2s ease-in-out infinite",
    }}
  />
</div>

</div>

      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
          marginBottom: 16,
        }}
      >
        {activeMatch ? (
          <div
            style={{
              gridColumn: "1 / -1",
              background: `linear-gradient(135deg, ${theme.accentSoft}, ${theme.cardBgSoft})`,
              padding: 16,
              borderRadius: 18,
              border: `1px solid ${theme.accent}`,
              color: theme.text,
              boxShadow: darkMode ? "0 14px 30px rgba(0,0,0,0.22)" : "0 14px 30px rgba(0,0,0,0.08)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={sectionEyebrowStyle}>Match Mode Active</div>
                <div style={{ fontSize: 20, fontWeight: 900, color: theme.text }}>
                  {activeMatch.name}
                </div>
              </div>
              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: 999,
                  border: `1px solid ${theme.border}`,
                  background: "rgba(0,0,0,0.14)",
                  color: theme.subtext,
                  fontSize: 13,
                  fontWeight: 800,
                  letterSpacing: "0.04em",
                }}
              >
                SHOOTER {Math.min((activeMatch.currentIndex || 0) + 1, activeMatch.shooterIds.length)} OF {activeMatch.shooterIds.length}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                gap: 12,
                marginTop: 14,
              }}
            >
              <div
                style={{
                  background: "rgba(0,0,0,0.18)",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 16,
                  padding: "14px 16px",
                }}
              >
                <div style={sectionEyebrowStyle}>Up Now</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: theme.text, lineHeight: 1.05 }}>
                  {activeMatchCurrentShooter?.Name || "Shooter"}
                </div>
              </div>

              <div
                style={{
                  background: "rgba(0,0,0,0.12)",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 16,
                  padding: "14px 16px",
                }}
              >
                <div style={sectionEyebrowStyle}>On Deck</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: theme.text, lineHeight: 1.1 }}>
                  {activeMatchNextShooter?.Name || "No one"}
                </div>
              </div>

              <div
                style={{
                  background: "rgba(0,0,0,0.12)",
                  border: `1px solid ${theme.border}`,
                  borderRadius: 16,
                  padding: "14px 16px",
                }}
              >
                <div style={sectionEyebrowStyle}>Stage Setup</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, lineHeight: 1.15 }}>
                  {selectedDrillData?.DrillName || findItemById(drills, activeMatch.drillId, "DrillID")?.DrillName || activeMatch.drillId || "Course"}
                </div>
                <div style={{ marginTop: 4, fontSize: 13, color: theme.subtext, fontWeight: 700 }}>
                  {selectedSessionData?.SessionName || findItemById(sessions, activeMatch.sessionId, "SessionID")?.SessionName || activeMatch.sessionId || "USPSA"}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
              <button
                type="button"
                style={{
                  ...buttonStyle,
                  padding: "10px 14px",
                  minHeight: 0,
                }}
                onClick={skipCurrentMatchShooter}
              >
                <SkipForward size={16} /> Skip Shooter
              </button>
              <button
                type="button"
                style={{
                  ...secondaryButtonStyle,
                  padding: "10px 14px",
                  minHeight: 0,
                }}
                onClick={() => finishMatch()}
              >
                <CheckCircle2 size={16} /> Finish Match
              </button>
            </div>
          </div>
        ) : null}
        

        <div
  onClick={() => toggleSelector("shooter")}
  style={{
    background: theme.cardBgSoft,
    padding: 16,
    borderRadius: 16,
    border: `1px solid ${theme.border}`,
    boxShadow: darkMode ? "none" : "0 1px 4px rgba(0,0,0,0.04)",
    transition: "all 0.25s ease",
    cursor: "pointer",
  }}
>
  <div style={cardLabelStyle}>Shooter</div>
  <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: theme.text }}>
    {selectedShooterData?.Name || "—"}
  </div>
</div>

        <div
  onClick={() => toggleSelector("drill")}
  style={{
    background: theme.cardBgSoft,
    padding: 16,
    borderRadius: 16,
    border: `1px solid ${theme.border}`,
    boxShadow: darkMode ? "none" : "0 1px 4px rgba(0,0,0,0.04)",
    transition: "all 0.25s ease",
    cursor: "pointer",
  }}
>
  <div style={cardLabelStyle}>Drill</div>
  <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: theme.text }}>
    {selectedDrillData?.DrillName || "—"}
  </div>
</div>

  <div
  onClick={() => toggleSelector("session")}
  style={{
    background: theme.cardBgSoft,
    padding: 16,
    borderRadius: 16,
    border: `1px solid ${theme.border}`,
    boxShadow: darkMode ? "none" : "0 1px 4px rgba(0,0,0,0.04)",
    transition: "all 0.25s ease",
    cursor: "pointer",
  }}
>
  <div style={cardLabelStyle}>Session</div>
  <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2, color: theme.text }}>
    {selectedSessionData?.SessionName || "—"}
  </div>
</div>
      </div>

      {qualificationModeActive ? (
        <div
          style={{
            ...boxStyle,
            marginBottom: 16,
            background: "linear-gradient(180deg, rgba(24,24,28,0.98), rgba(12,12,14,0.98))",
            display: "grid",
            gap: 14,
          }}
        >
          <div>
            <div style={sectionEyebrowStyle}>Qualification Mode</div>
            <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>
              {activeQualification?.name || selectedDrillData?.DrillName || "Qualification"}
            </div>
            <div style={{ color: theme.subtext, marginTop: 6, lineHeight: 1.45 }}>
              Everyone shoots the same distance together, then you enter each score before advancing to the next distance.
            </div>
          </div>

          {message ? (
            <div
              style={{
                borderRadius: 16,
                padding: "12px 14px",
                fontSize: 14,
                fontWeight: 700,
                lineHeight: 1.45,
                color:
                  message.toLowerCase().includes("failed") ||
                  message.toLowerCase().includes("error") ||
                  message.toLowerCase().includes("enter a score")
                    ? theme.dangerText
                    : theme.successText,
                background:
                  message.toLowerCase().includes("failed") ||
                  message.toLowerCase().includes("error") ||
                  message.toLowerCase().includes("enter a score")
                    ? theme.dangerBg
                    : theme.successBg,
              }}
            >
              {message}
            </div>
          ) : null}

          {!activeQualification ? (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                <div style={infoPillStyle}>
                  <strong>Distances</strong>
                  <br />
                  {qualificationDistances.length}
                </div>
                <div style={infoPillStyle}>
                  <strong>Stage Pass</strong>
                  <br />
                  {selectedQualificationPreviewTarget > 0
                    ? `${Math.ceil(selectedQualificationPreviewTarget * (selectedQualificationPassPercent / 100))}/${selectedQualificationPreviewTarget} (${selectedQualificationPassPercent}%)`
                    : `${selectedQualificationPassPercent}% per distance`}
                </div>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Qualification Distances
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {qualificationDistances.map((distance, index) => (
                    <div
                      key={`qualification-distance-${index}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "70px minmax(0, 1fr) auto",
                        gap: 12,
                        alignItems: "center",
                        padding: "10px 12px",
                        borderRadius: 14,
                        border: `1px solid ${theme.border}`,
                        background: theme.cardBgSoft,
                      }}
                    >
                      <div style={{ color: theme.accent, fontWeight: 900 }}>{index + 1}</div>
                      <div style={{ color: theme.text, fontWeight: 800 }}>{distance.label}</div>
                      <div style={{ color: theme.subtext, fontSize: 13, fontWeight: 700 }}>
                        {distance.roundCount ? `${distance.roundCount} rds` : "Rounds not set"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Add Shooters
                </div>
                <input
                  style={{ ...inputStyle, marginBottom: 12 }}
                  placeholder="Search shooters to add"
                  value={qualificationShooterSearch}
                  onChange={(event) => setQualificationShooterSearch(event.target.value)}
                />
                <div style={{ display: "grid", gap: 10, maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                  {filteredQualificationShooterOptions.map((shooter) => (
                    <button
                      key={shooter.ShooterID}
                      type="button"
                      onClick={() => addShooterToQualificationRoster(shooter.ShooterID)}
                      style={{
                        ...secondaryButtonStyle,
                        justifyContent: "space-between",
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <span>{shooter.Name}{shooter.Level ? ` (L${shooter.Level})` : ""}</span>
                      <Plus size={18} />
                    </button>
                  ))}
                  {!filteredQualificationShooterOptions.length ? (
                    <div style={{ color: theme.subtext, textAlign: "center", padding: "10px 0" }}>
                      No shooters match that search.
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Qualification Roster
                </div>
                {qualificationRosterIds.length === 0 ? (
                  <div style={{ color: theme.subtext }}>Add at least one shooter to start the qualification.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {qualificationRosterIds.map((shooterId) => {
                      const shooter = findItemById(shooters, shooterId, "ShooterID");
                      return (
                        <div
                          key={`qualification-roster-${shooterId}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(0, 1fr) auto",
                            gap: 12,
                            alignItems: "center",
                            padding: "10px 12px",
                            borderRadius: 14,
                            border: `1px solid ${theme.border}`,
                            background: theme.cardBgSoft,
                          }}
                        >
                          <div>
                            <div style={{ color: theme.text, fontWeight: 800 }}>
                              {shooter?.Name || shooterId}
                            </div>
                            <div style={{ color: theme.subtext, fontSize: 13, marginTop: 4 }}>
                              {shooter?.Level ? `Level ${shooter.Level}` : "Shooter"}
                            </div>
                          </div>
                          <button
                            type="button"
                            style={{ ...secondaryButtonStyle, minHeight: 0, padding: "8px 12px" }}
                            onClick={() => removeShooterFromQualificationRoster(shooterId)}
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={startQualification}>
                  Start Qualification
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => {
                    setQualificationRosterIds([]);
                    setQualificationShooterSearch("");
                  }}
                >
                  Clear Roster
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
                <div style={infoPillStyle}>
                  <strong>Distance</strong>
                  <br />
                  {activeQualificationDistance?.label || "Stage"}
                </div>
                <div style={infoPillStyle}>
                  <strong>Progress</strong>
                  <br />
                  {`${Math.min(activeQualificationDistanceIndex + 1, activeQualification.distances?.length || 1)} / ${activeQualification.distances?.length || 1}`}
                </div>
                <div style={infoPillStyle}>
                  <strong>Stage Pass</strong>
                  <br />
                  {activeQualificationStageTarget > 0
                    ? `${Math.ceil(activeQualificationStageTarget * (activeQualificationPassPercent / 100))}/${activeQualificationStageTarget}`
                    : `${activeQualificationPassPercent}%`}
                </div>
              </div>

              <div style={{ display: "grid", gap: 10 }}>
                {activeQualificationRoster.map((shooter) => {
                  const entry = qualificationStageEntries[String(shooter.ShooterID)] || { score: "", notes: "" };
                  const stageTarget = getQualificationStageTarget(activeQualificationDistance);
                  const numericScore =
                    String(entry.score || "").trim() === "" ? "" : Number(entry.score || 0) || 0;

                  return (
                    <div
                      key={`qualification-score-${shooter.ShooterID}`}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "minmax(0, 1fr) minmax(164px, 184px)",
                        gap: 12,
                        alignItems: "start",
                        padding: 14,
                        borderRadius: 16,
                        border: `1px solid ${theme.border}`,
                        background: theme.cardBgSoft,
                      }}
                    >
                      <div style={{ display: "grid", gap: 10 }}>
                        <div>
                          <div style={{ color: theme.text, fontSize: 18, fontWeight: 800 }}>
                            {shooter.Name}
                          </div>
                          <div style={{ color: theme.subtext, fontSize: 13, marginTop: 4 }}>
                            {shooter.Level ? `Level ${shooter.Level}` : "Shooter"}
                          </div>
                        </div>
                        <textarea
                          style={{ ...textAreaStyle, minHeight: 78 }}
                          placeholder="Notes"
                          value={entry.notes}
                          onChange={(event) =>
                            setQualificationStageEntries((current) => ({
                              ...current,
                              [String(shooter.ShooterID)]: {
                                ...current[String(shooter.ShooterID)],
                                score: current[String(shooter.ShooterID)]?.score || "",
                                notes: event.target.value,
                              },
                            }))
                          }
                        />
                      </div>
                      <div style={{ display: "grid", gap: 10 }}>
                        <input
                          style={{
                            ...inputStyle,
                            textAlign: "center",
                            fontSize: 22,
                            fontWeight: 900,
                            paddingTop: 14,
                            paddingBottom: 14,
                          }}
                          placeholder="Score"
                          value={entry.score}
                          readOnly
                        />
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "44px minmax(0, 1fr) 44px",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <button
                            type="button"
                            style={{
                              ...secondaryButtonStyle,
                              minHeight: 0,
                              height: 44,
                              padding: 0,
                              fontSize: 24,
                              fontWeight: 900,
                            }}
                            onClick={() =>
                              setQualificationStageEntries((current) => {
                                const currentScore = Number(current[String(shooter.ShooterID)]?.score || 0) || 0;
                                return {
                                  ...current,
                                  [String(shooter.ShooterID)]: {
                                    ...current[String(shooter.ShooterID)],
                                    score: String(Math.max(0, currentScore - 1)),
                                    notes: current[String(shooter.ShooterID)]?.notes || "",
                                  },
                                };
                              })
                            }
                          >
                            -
                          </button>
                          <button
                            type="button"
                            style={{
                              ...buttonStyle,
                              minHeight: 0,
                              height: 44,
                              padding: "0 10px",
                              fontSize: 16,
                              fontWeight: 900,
                            }}
                            onClick={() =>
                              setQualificationStageEntries((current) => ({
                                ...current,
                                [String(shooter.ShooterID)]: {
                                  ...current[String(shooter.ShooterID)],
                                  score: String(stageTarget || 0),
                                  notes: current[String(shooter.ShooterID)]?.notes || "",
                                },
                              }))
                            }
                          >
                            Max
                          </button>
                          <button
                            type="button"
                            style={{
                              ...secondaryButtonStyle,
                              minHeight: 0,
                              height: 44,
                              padding: 0,
                              fontSize: 24,
                              fontWeight: 900,
                            }}
                            onClick={() =>
                              setQualificationStageEntries((current) => {
                                const currentScore = Number(current[String(shooter.ShooterID)]?.score || 0) || 0;
                                const nextScore = stageTarget > 0 ? Math.min(stageTarget, currentScore + 1) : currentScore + 1;
                                return {
                                  ...current,
                                  [String(shooter.ShooterID)]: {
                                    ...current[String(shooter.ShooterID)],
                                    score: String(nextScore),
                                    notes: current[String(shooter.ShooterID)]?.notes || "",
                                  },
                                };
                              })
                            }
                          >
                            +
                          </button>
                        </div>
                        {stageTarget > 0 ? (
                          <div
                            style={{
                              color: theme.subtext,
                              fontSize: 12,
                              fontWeight: 700,
                              textAlign: "center",
                            }}
                          >
                            Max {stageTarget}
                            {numericScore !== "" ? ` • Selected ${numericScore}` : ""}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>

              {qualificationOverallResults.length ? (
                <div style={{ ...tableContainerStyle, padding: 16 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                    Qualification Totals So Far
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {qualificationOverallResults.map((entry, index) => (
                      <div
                        key={`qualification-total-${entry.shooterId}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "54px minmax(0, 1fr) auto",
                          gap: 12,
                          alignItems: "center",
                          padding: "10px 12px",
                          borderRadius: 14,
                          border: `1px solid ${theme.border}`,
                          background: theme.cardBgSoft,
                        }}
                      >
                        <div style={{ color: theme.accent, fontWeight: 900 }}>#{index + 1}</div>
                        <div style={{ color: theme.text, fontWeight: 800 }}>
                          {entry.shooter?.Name || entry.shooterId}
                        </div>
                        <div style={{ color: theme.text, fontWeight: 900 }}>{entry.totalScore}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={saveQualificationDistance}
                  disabled={qualificationSaving}
                >
                  {qualificationSaving
                    ? "Saving Distance..."
                    : activeQualificationDistanceIndex + 1 >= (activeQualification.distances?.length || 0)
                    ? "Save Final Distance"
                    : `Save ${activeQualificationDistance?.label || "Distance"} & Advance`}
                </button>
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => finishQualification()}
                  disabled={qualificationSaving}
                >
                  End Qualification
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {!qualificationModeActive ? (
      <>
      <div
  style={{
    background: theme.pageBg,
    padding: 16,
    borderRadius: 16,
      border: "none",
      boxShadow: darkMode ? "none" : "0 1px 4px rgba(0,0,0,0.04)",
      transition: "all 0.25s ease",
  }}
>
  
  
  
  <button
    disabled={timerActionLocked}
    onClick={async () => {
      if (timerActionLocked) return;

      setTimerActionLocked(true);

      try {
        if (timerRunning) {
  await Haptics.impact({ style: ImpactStyle.Heavy }); // stop = stronger
  await stopTimer();
} else {
  await Haptics.impact({ style: ImpactStyle.Heavy }); // start = lighter
  await startTimer();
}
      } finally {
        setTimeout(() => setTimerActionLocked(false), 800);
      }
    }}
    onMouseDown={(e) => {
  e.currentTarget.style.animation = "hapticPress 0.12s ease-out forwards";
}}
onMouseUp={(e) => {
  e.currentTarget.style.animation = "none";
  e.currentTarget.style.transform = "scale(1) translateY(0)";
}}
onMouseLeave={(e) => {
  e.currentTarget.style.animation = "none";
  e.currentTarget.style.transform = "scale(1) translateY(0)";
}}
onTouchStart={(e) => {
  e.currentTarget.style.animation = "hapticPress 0.12s ease-out forwards";
}}
onTouchEnd={(e) => {
  e.currentTarget.style.animation = "none";
  e.currentTarget.style.transform = "scale(1) translateY(0)";
}}

    style={{
      width: "100%",
      padding: "56px 20px",
      borderRadius: 20,
      border: "none",
      background: timerRunning
        ? "linear-gradient(135deg, #b91c1c, #7f1d1d)"
        : "linear-gradient(135deg, #d4af37, #b8962e)",
      color: timerRunning ? "#fff" : "#000",
      fontWeight: 800,
      fontSize: 26,
      letterSpacing: 1.5,
      transition: "transform 0.1s ease, box-shadow 0.2s ease",
      transform: "scale(1) translateY(0)",
      letterSpacing: 1,

      boxShadow: timerRunning
  ? "0 0 12px rgba(127,29,29,0.7), 0 0 24px rgba(127,29,29,0.5)"
  : "0 0 10px rgba(212,175,55,0.6), 0 0 20px rgba(212,175,55,0.4)",
  animation: timerRunning ? "pulseGlow 1.2s ease-in-out infinite" : "none",
  transform: "scale(1) translateY(0)",
      marginBottom: 10,
      cursor: timerActionLocked ? "not-allowed" : "pointer",
      opacity: timerActionLocked ? 0.7 : 1,
    }}
  >
    {timerRunning ? "■ Stop Timer" : "▶ Start Timer"}
  </button>

  {Capacitor.isNativePlatform() ? (
    <button
      type="button"
      onClick={openNativeVideoMode}
      disabled={!timerConnected || nativeVideoModeOpen}
      style={{
        ...buttonStyle,
        width: "100%",
        marginBottom: 10,
        background: nativeVideoModeOpen
          ? "linear-gradient(135deg, #7f1d1d, #5f1616)"
          : "linear-gradient(135deg, #dc2626, #991b1b)",
        color: "#fff",
        boxShadow: nativeVideoModeOpen
          ? "0 0 12px rgba(127,29,29,0.45)"
          : "0 0 12px rgba(220,38,38,0.32)",
        opacity: !timerConnected || nativeVideoModeOpen ? 0.7 : 1,
        cursor: !timerConnected || nativeVideoModeOpen ? "not-allowed" : "pointer",
      }}
    >
      {nativeVideoModeOpen ? "Video Mode Open" : "Open Video Mode"}
    </button>
  ) : null}

  <div
    style={{
      display: "grid",
      gridTemplateColumns: timerConnected ? "1.1fr 0.9fr" : "1fr",
      gap: 10,
      marginBottom: 10,
    }}
  >
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 14,
        fontWeight: 800,
        textAlign: "center",
        fontSize: 15,
        background: timerConnected ? theme.successBg : theme.cardBgSoft,
        color: timerConnected ? theme.successText : theme.subtext,
        border: `1px solid ${timerConnected ? "transparent" : theme.border}`,
        transition: "all 0.25s ease",
        boxShadow: timerConnected
          ? "0 4px 12px rgba(34,197,94,0.22)"
          : "none",
      }}
    >
      {timerConnected
        ? `Connected to ${timerDeviceName || "SG Timer"}`
        : scanningTimers
        ? "Scanning for timers..."
        : "Timer not connected"}
    </div>

    <button
      type="button"
      onClick={timerConnected ? disconnectTimer : connectTimer}
      style={{
        ...secondaryButtonStyle,
        width: "100%",
        marginBottom: 0,
        background: timerConnected ? theme.dangerBg : theme.cardBg,
        color: timerConnected ? theme.dangerText : theme.text,
        border: `1px solid ${timerConnected ? "transparent" : theme.border}`,
        boxShadow: "none",
      }}
    >
      {timerConnected ? "Disconnect Timer" : "Connect Timer"}
    </button>
  </div>

  {shouldShowForgetTimerButton ? (
    <button
      type="button"
      onClick={forgetSavedTimer}
      style={{
        width: "100%",
        marginBottom: 12,
        padding: "8px 10px",
        borderRadius: 12,
        border: `1px solid ${theme.border}`,
        background: "transparent",
        color: theme.subtext,
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: "0.04em",
        cursor: "pointer",
      }}
    >
      Forget Saved Timer
    </button>
  ) : null}

  
</div>

      {timerStatusMessage && (
  <div
    style={{
      marginBottom: 12,
      fontSize: 14,
      fontWeight: 700,
      color: timerStatusMessage.toLowerCase().includes("failed") || timerStatusMessage.toLowerCase().includes("no timer")
        ? theme.dangerText
        : theme.subtext,
      background: theme.cardBgSoft,
      border: `1px solid ${theme.border}`,
      borderRadius: 14,
      padding: "10px 12px",
    }}
  >
    {timerStatusMessage}
  </div>
)}



      <div
  style={{
    background: "rgba(255,255,255,0.02)", // 🔥 ultra subtle lift
    padding: 16,
    borderRadius: 16,
    marginBottom: 16,
    border: "none",
    boxShadow: "0 6px 18px rgba(0,0,0,0.4)", // depth without gray look
    backdropFilter: "blur(6px)", // optional premium feel
  }}
>
        <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  }}
>
  <div style={{ fontSize: 18, fontWeight: 800, color: theme.text }}>Live Shots</div>
  <div
  style={{
    fontSize: 13,
    fontWeight: 700,
    color: theme.accent,
    background: theme.accentSoft,
    padding: "4px 10px",
    borderRadius: 999,
  }}
>
    {liveShotTimes.length} shot{liveShotTimes.length === 1 ? "" : "s"}
  </div>
</div>

        

        {liveShotTimes.length === 0 ? (
          <div
            style={{
              color: theme.subtext,
              textAlign: "center",
              fontSize: 17,
              padding: "8px 0",
            }}
          >
            No live shots yet
          </div>
        ) : (
          liveShotTimes.map((t, i) => (
  <div
    key={i}
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "12px 14px",
      borderRadius: 12,
      background: theme.cardBg,
      border: `1px solid ${theme.border}`,
      marginBottom: 8,
    }}
  >
    <div style={{ fontWeight: 700, fontSize: 16, color: theme.text }}>
      Shot {i + 1}
    </div>

    <div style={{ textAlign: "right" }}>
      <div style={{ fontWeight: 800, fontSize: 18, color: theme.text }}>
        {t.toFixed(2)}s
      </div>

      {i > 0 && (
        <div style={{ fontSize: 13, color: theme.subtext }}>
          Split {(t - liveShotTimes[i - 1]).toFixed(2)}
        </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>

      {lastTimerRun && (
        <div
          style={{
            background: "rgba(255,255,255,0.02)",
            padding: 16,
            borderRadius: 16,
            border: "none",
            boxShadow: "0 6px 18px rgba(0,0,0,0.4)",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10, color: theme.text }}>
  Last Timer Run
</div>

          <div
  style={{
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
    color: theme.text,
  }}
>
            <div><strong>Total:</strong> {lastTimerRun.totalTime}</div>
            <div><strong>Shots:</strong> {lastTimerRun.shotCount}</div>
            <div><strong>First:</strong> {lastTimerRun.firstShot}</div>
            <div><strong>Avg Split:</strong> {formatSplitForDisplay(lastTimerRun.avgSplit)}</div>
            <div><strong>Best:</strong> {formatSplitForDisplay(lastTimerRun.bestSplit)}</div>
            <div><strong>Worst:</strong> {formatSplitForDisplay(lastTimerRun.worstSplit)}</div>
            <div><strong>Score:</strong> {lastTimerRun.score || "-"}</div>
            <div><strong>Result:</strong> {lastTimerRun.passFail || "-"}</div>
          </div>
        </div>
      )}
      </>
      ) : null}
        </div>

    <div
  style={{
    ...boxStyle,
    marginBottom: 20,
    display: activeTab === "log" ? "block" : "none",
  }}
>
      <div style={sectionEyebrowStyle}>Manual Entry</div>
      <h2 style={{ ...sectionTitleStyle, textAlign: "center" }}>Log Run</h2>
      <p style={{ ...sectionSubtitleStyle, textAlign: "center", maxWidth: 720, marginLeft: "auto", marginRight: "auto" }}>
        Enter a run by hand, attach a video, and save the result to your tracker with the same scoring and cloud link flow used by timer imports.
      </p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <select
  style={inputStyle}
  value={selectedShooter}
  onChange={(e) => {
    setSelectedShooter(e.target.value);
    selectedShooterRef.current = e.target.value;
  }}
>
  {shooters.map((s) => (
    <option key={s.ShooterID} value={s.ShooterID}>
      {s.Name} (L{s.Level})
    </option>
  ))}
</select>

<select
  style={inputStyle}
  value={selectedDrill}
  onChange={(e) => {
    setSelectedDrill(e.target.value);
    selectedDrillRef.current = e.target.value;
  }}
>
  {drills.map((d) => (
    <option key={d.DrillID} value={d.DrillID}>
      {d.DrillName}
    </option>
  ))}
</select>

<select
  style={inputStyle}
  value={selectedSession}
  onChange={(e) => {
    setSelectedSession(e.target.value);
    selectedSessionRef.current = e.target.value;
  }}
>
  {sessions.map((s) => (
    <option key={s.SessionID} value={s.SessionID}>
      {s.SessionName}
    </option>
  ))}
</select>

            <input
              style={inputStyle}
              placeholder="Total Time"
              value={totalTime}
              onChange={(e) => setTotalTime(e.target.value)}
              type="number"
              step="0.01"
            />

            <input
              style={inputStyle}
              placeholder="Shots"
              value={shotCount}
              onChange={(e) => setShotCount(e.target.value)}
              type="number"
            />

            <input
              style={inputStyle}
              placeholder="First Shot"
              value={firstShot}
              onChange={(e) => setFirstShot(e.target.value)}
              type="number"
              step="0.01"
            />

            

            <input
              style={inputStyle}
              placeholder="Score"
              value={score}
              onChange={(e) => setScore(e.target.value)}
              type="number"
              step="0.01"
            />

            <select style={inputStyle} value={passFail} onChange={(e) => setPassFail(e.target.value)}>
              <option value="">Pass / Fail</option>
              <option value="Pass">Pass</option>
              <option value="Fail">Fail</option>
            </select>

            <select style={inputStyle} value={qualificationLevel} onChange={(e) => setQualificationLevel(e.target.value)}>
              <option value="">Qualification Level</option>
              <option value="0">Level 0</option>
              <option value="1">Level 1</option>
              <option value="2">Level 2</option>
              <option value="3">Level 3</option>
              <option value="4">Level 4</option>
              <option value="5">Level 5</option>
            </select>
          </div>

      

          <div style={{ marginTop: 14 }}>
            <textarea
              style={textAreaStyle}
              placeholder="Notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div
            style={{
              marginTop: 14,
              padding: 18,
              borderRadius: 18,
              border: `1px solid ${theme.border}`,
              background: theme.cardBgSoft,
            }}
          >
            <div style={sectionEyebrowStyle}>Video</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: theme.text, marginBottom: 8 }}>
              Video Attachment
            </div>
            <div style={{ color: theme.subtext, fontSize: 15, lineHeight: 1.4, marginBottom: 12 }}>
              Attach a video to this run. It stays local in the app for about 24 hours and, when Firebase is configured, uploads to permanent cloud storage with a link saved to the run.
            </div>
            <input
              ref={videoInputRef}
              style={inputStyle}
              type="file"
              accept="video/*"
              onChange={handleVideoFileChange}
            />

            {videoFile ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12, color: theme.subtext, fontSize: 14 }}>
                  <div style={infoPillStyle}><strong style={{ color: theme.text }}>Name:</strong><br />{videoFile.name}</div>
                  <div style={infoPillStyle}><strong style={{ color: theme.text }}>Size:</strong><br />{formatFileSize(videoFile.size)}</div>
                  <div style={infoPillStyle}><strong style={{ color: theme.text }}>Duration:</strong><br />{formatDuration(videoDuration) || "Loading..."}</div>
                  <div style={infoPillStyle}><strong style={{ color: theme.text }}>Mode:</strong><br />{isFirebaseConfigured() ? "24h local + cloud" : "24h local only"}</div>
                </div>
                <video
                  controls
                  preload="metadata"
                  src={videoPreviewUrl}
                  onLoadedMetadata={(e) => setVideoDuration(e.currentTarget.duration.toFixed(1))}
                  style={{
                    width: "100%",
                    maxWidth: 480,
                    borderRadius: 12,
                    border: `1px solid ${theme.border}`,
                    background: "#000",
                  }}
                />
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
                  <button style={secondaryButtonStyle} type="button" onClick={clearVideoSelection}>
                    Remove Video
                  </button>
                  {videoUploadedUrl ? (
                    <button
                      type="button"
                      style={secondaryButtonStyle}
                      onClick={() =>
                        openRunVideoPlayer(
                          {
                            url: videoUploadedUrl,
                            rawUrl: videoCaptureSessionRef.current.recordedMeta?.rawUrl || "",
                            localFilePath: videoFilePath || videoCaptureSessionRef.current.recordedMeta?.localFilePath || "",
                            name: videoFileName || videoFile?.name || "Uploaded Video",
                          },
                          "Uploaded Video"
                        )
                      }
                    >
                      Open Uploaded Video
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {videoStatus ? (
              <div
                style={{
                  marginTop: 12,
                  color: theme.subtext,
                  fontSize: 14,
                  background: theme.cardBg,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 14,
                  padding: "10px 12px",
                }}
              >
                {videoStatus}
              </div>
            ) : null}
          </div>
          

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <button style={buttonStyle} onClick={saveRun} disabled={saving || loading}>
              {saving ? "Saving..." : "Save Run"}
            </button>
            <button style={secondaryButtonStyle} onClick={clearRunForm}>
              Clear Form
            </button>
          <button style={buttonStyle} onClick={connectTimer}>
            Connect Timer
          </button>
          </div>
        

          {message ? (
            <div
              style={{
                marginTop: 14,
                fontSize: 15,
                fontWeight: 700,
                color: message.toLowerCase().includes("error") || message.toLowerCase().includes("did not")
                  ? theme.dangerText
                  : theme.successText,
                background: message.toLowerCase().includes("error") || message.toLowerCase().includes("did not")
                  ? theme.dangerBg
                  : theme.successBg,
                borderRadius: 14,
                padding: "12px 14px",
              }}
            >
              {message}
            </div>
          ) : null}

                    <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, fontSize: 15, color: theme.subtext }}>
            <div style={infoPillStyle}><strong>Shooter:</strong><br />{selectedShooterData?.Name || "-"}</div>
            <div style={infoPillStyle}><strong>Level:</strong><br />{selectedShooterData?.Level || "-"}</div>
            <div style={infoPillStyle}><strong>Drill:</strong><br />{selectedDrillData?.DrillName || "-"}</div>
            <div style={infoPillStyle}><strong>Par:</strong><br />{selectedDrillData?.ParTime || "-"}</div>
            <div style={infoPillStyle}><strong>Rounds:</strong><br />{selectedDrillData?.RoundCount || "-"}</div>
            <div style={infoPillStyle}><strong>Session:</strong><br />{selectedSessionData?.SessionName || "-"}</div>
          </div>
        </div>

        <div
          style={{
            display: activeTab === "progress" ? "grid" : "none",
            gridTemplateColumns: "1fr",
            gap: 12,
            marginBottom: 20,
          }}
>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Attempts</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.attempts}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Best Time</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.best}{statCards.best !== "-" ? "s" : ""}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Average Time</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.average}{statCards.average !== "-" ? "s" : ""}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Best First Shot</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.bestFirstShot}{statCards.bestFirstShot !== "-" ? "s" : ""}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Best Split</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.bestSplit}{statCards.bestSplit !== "-" ? "s" : ""}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Total Rounds</div><div style={{ fontSize: 34, fontWeight: 700 }}>{statCards.totalRounds}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Passed</div><div style={{ fontSize: 34, fontWeight: 700 }}>{qualificationSummary.passed}</div></div>
          <div style={boxStyle}><div style={{ color: theme.subtext, marginBottom: 6 }}>Failed</div><div style={{ fontSize: 34, fontWeight: 700 }}>{qualificationSummary.failed}</div></div>
          
        </div>

	        <div
  style={{
    display: ["leaderboard", "progress", "recent"].includes(activeTab) ? "grid" : "none",
    gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
    gap: 20,
    marginBottom: 20,
  }}
>
          <div
  style={{
    ...boxStyle,
    display: activeTab === "leaderboard" ? "block" : "none",
  }}
>
            <div style={sectionEyebrowStyle}>Training</div>
            <h2 style={sectionTitleStyle}>Training Leaderboard</h2>
            <p style={sectionSubtitleStyle}>
              Compare training-session runs by Date / Drill.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 520px)", gap: 14, marginBottom: 14 }}>
              <select
                style={inputStyle}
                value={trainingLeaderboardBoard}
                onChange={(e) => setTrainingLeaderboardBoard(e.target.value)}
              >
                {trainingLeaderboardBoardOptions.length === 0 ? (
                  <option value="">No Training boards yet</option>
                ) : (
                  trainingLeaderboardBoardOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div style={{ marginBottom: 12, color: theme.subtext, fontSize: 16 }}>
              {selectedTrainingLeaderboardBoard
                ? `Showing Training runs for ${selectedTrainingLeaderboardBoard.label}`
                : "No Training boards available yet"}
            </div>
            <div style={tableContainerStyle}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse", fontSize: 18 }}>
                <thead>
                  <tr>
                    <th style={centeredTableHeaderFirstCellStyle}>Rank</th>
                    <th style={centeredTableHeaderCellStyle}>Shooter</th>
                    <th style={centeredTableHeaderCellStyle}>Level</th>
                    <th style={centeredTableHeaderCellStyle}>Best</th>
                    <th style={centeredTableHeaderCellStyle}>Avg</th>
                    <th style={centeredTableHeaderCellStyle}>Latest</th>
                    <th style={centeredTableHeaderCellStyle}>Attempts</th>
                    <th style={centeredTableHeaderCellStyle}>Passes</th>
                  </tr>
                </thead>
                <tbody>
                  {trainingLeaderboard.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ padding: "12px 10px 12px 0", color: theme.subtext }}>
                        No Training runs found for that Date / Drill.
                      </td>
                    </tr>
                  ) : (
                    trainingLeaderboard.map((row, index) => (
                      <tr
                        key={row.shooterId}
                        onClick={() => openRunDetail(row.detailRun)}
                        style={{ cursor: row.detailRun ? "pointer" : "default" }}
                      >
                        <td style={{ padding: "12px 10px 12px 0", color: theme.text, fontWeight: 800, whiteSpace: "nowrap" }}>{index + 1}</td>
                        <td style={{ padding: "12px 10px", color: theme.text, fontWeight: 700, whiteSpace: "nowrap" }}>{row.name}</td>
                        <td style={{ padding: "12px 10px", color: theme.subtext, whiteSpace: "nowrap" }}>{row.level}</td>
                        <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.best}s</td>
                        <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.avg}s</td>
                        <td style={{ padding: "12px 10px", color: theme.subtext, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.latest}s</td>
                        <td style={{ padding: "12px 10px", color: theme.subtext, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.attempts}</td>
                        <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.passCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            </div>
          </div>

	          <div style={{ marginTop: 28, display: activeTab === "leaderboard" ? "block" : "none" }}>
  <div style={sectionEyebrowStyle}>USPSA</div>
  <h2 style={sectionTitleStyle}>
    USPSA Leaderboard
  </h2>

  <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 520px)", gap: 14, marginBottom: 14 }}>
    <select
      style={inputStyle}
      value={uspsaLeaderboardBoard}
      onChange={(e) => setUspsaLeaderboardBoard(e.target.value)}
    >
      {uspsaLeaderboardBoardOptions.length === 0 ? (
        <option value="">No USPSA boards yet</option>
      ) : (
        uspsaLeaderboardBoardOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))
      )}
    </select>
  </div>

  <div
    style={{
      marginBottom: 12,
      color: theme.subtext,
      fontSize: 16,
    }}
  >
    {!selectedUspsaLeaderboardBoard
      ? "No USPSA boards available yet"
      : `Showing USPSA runs for ${selectedUspsaLeaderboardBoard.label}`}
  </div>

  <div style={tableContainerStyle}>
  <div style={{ overflowX: "auto" }}>
    <table style={{ width: "100%", minWidth: 780, borderCollapse: "collapse", fontSize: 18 }}>
      <thead>
        <tr>
          <th style={centeredTableHeaderFirstCellStyle}>Rank</th>
          <th style={centeredTableHeaderCellStyle}>Shooter</th>
          <th style={centeredTableHeaderCellStyle}>Runs</th>
          <th style={centeredTableHeaderCellStyle}>Fastest Time</th>
          <th style={centeredTableHeaderCellStyle}>Total Points</th>
          <th style={centeredTableHeaderCellStyle}>Best HF</th>
          <th style={centeredTableHeaderCellStyle}>Stage %</th>
        </tr>
      </thead>
      <tbody>
                {uspsaStageRankings.length === 0 ? (
          <tr>
            <td colSpan={7} style={{ padding: "12px 10px 12px 0", color: theme.subtext }}>
              No USPSA runs found for that Date / Drill.
            </td>
          </tr>
        ) : (
          uspsaStageRankings.map((row, index) => (
            <tr
              key={row.shooterId}
              onClick={() => openRunDetail(row.detailRun)}
              style={{ cursor: row.detailRun ? "pointer" : "default" }}
            >
              <td style={{ padding: "10px 10px 10px 0", color: theme.text, whiteSpace: "nowrap" }}>{index + 1}</td>
              <td style={{ padding: "10px 10px", color: theme.text, whiteSpace: "nowrap" }}>{row.shooterName}</td>
              <td style={{ padding: "10px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{row.runs}</td>
              <td style={{ padding: "10px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {row.fastestTime ? row.fastestTime.toFixed(2) : "-"}
              </td>
              <td style={{ padding: "10px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {row.totalPoints ? row.totalPoints.toFixed(0) : "-"}
              </td>
              <td style={{ padding: "10px 10px", color: theme.text, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {row.bestHitFactor ? row.bestHitFactor.toFixed(4) : "-"}
              </td>
              <td style={{ padding: "10px 10px", color: "#d4af37", fontWeight: 800, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {row.stagePercent
                  ? `${row.stagePercent.toFixed(2)}%`
                  : "-"}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
  </div>
</div>

	        <div
  style={{
    ...boxStyle,
    display: activeTab === "progress" ? "block" : "none",
  }}
>
            <div style={sectionEyebrowStyle}>Drill Trend</div>
            <h2 style={sectionTitleStyle}>Shooter Progress</h2>
            <div style={{ marginBottom: 12, color: theme.subtext, fontSize: 18 }}>
              {selectedShooterData?.Name || "Shooter"} on {selectedDrillData?.DrillName || "Drill"}
            </div>
            <div style={tableContainerStyle}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 18 }}>
                <thead>
                  <tr>
                    <th style={tableHeaderCellStyle}>Date</th>
                    <th style={tableHeaderCellStyle}>Time</th>
                    <th style={tableHeaderCellStyle}>Shots</th>
                    <th style={tableHeaderCellStyle}>First</th>
                    <th style={tableHeaderCellStyle}>Avg</th>
                    <th style={tableHeaderCellStyle}>Score</th>
                    <th style={tableHeaderCellStyle}>Pass/Fail</th>
                    <th style={tableHeaderCellStyle}>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedProgress.map((run, index) => (
                    <tr key={`${run.Timestamp}-${index}`}>
                      <td style={{ padding: "12px 0", color: theme.text }}>{formatDateOnly(run.Timestamp)}</td>
                      <td style={{ padding: "12px 0", color: theme.text, fontWeight: 700 }}>{run.TotalTime}</td>
                      <td style={{ padding: "12px 0", color: theme.text }}>{run.ShotCount}</td>
                      <td style={{ padding: "12px 0", color: theme.subtext }}>{run.FirstShot || ""}</td>
                      <td style={{ padding: "12px 0", color: theme.subtext }}>{formatSplitForDisplay(run.AvgSplit)}</td>
                      <td style={{ padding: "12px 0", color: theme.text }}>{run.Score || ""}</td>
                      <td style={{ padding: "12px 0", color: run.PassFail === "Pass" ? theme.successText : run.PassFail === "Fail" ? theme.dangerText : theme.subtext, fontWeight: 700 }}>{run.PassFail || ""}</td>
                      <td style={{ padding: "12px 0", color: theme.subtext }}>{findItemById(sessions, run.SessionID, "SessionID")?.SessionName || run.SessionID}</td>
                    </tr>
                  ))}
	                </tbody>
	              </table>
	  </div>
	        </div>
	      </div>

	        <div
	          style={{
	            ...boxStyle,
            marginBottom: 20,
            display: "none",
          }}
        >
          <div style={sectionEyebrowStyle}>Roster Flow</div>
          <h2 style={sectionTitleStyle}>Match Mode</h2>
          <p style={sectionSubtitleStyle}>
            Build a single-stage match roster, then the app will auto-load each shooter and advance after every saved run.
          </p>

          {!activeMatch ? (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <input
                  style={inputStyle}
                  placeholder="Match name"
                  value={matchNameInput}
                  onChange={(e) => setMatchNameInput(e.target.value)}
                />
                <select style={inputStyle} value={matchDrillId} onChange={(e) => setMatchDrillId(e.target.value)}>
                  <option value="">Select drill</option>
                  {drills.map((drill) => (
                    <option key={drill.DrillID} value={String(drill.DrillID)}>
                      {drill.DrillName}
                    </option>
                  ))}
                </select>
                <select style={inputStyle} value={matchSessionId} onChange={(e) => setMatchSessionId(e.target.value)}>
                  <option value="">Select session</option>
                  {sessions.map((session) => (
                    <option key={session.SessionID} value={String(session.SessionID)}>
                      {session.SessionName || session.Name || session.SessionID}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Add Shooters
                </div>
                <input
                  style={{ ...inputStyle, marginBottom: 12 }}
                  placeholder="Search shooters to add"
                  value={matchShooterSearch}
                  onChange={(e) => setMatchShooterSearch(e.target.value)}
                />
                <div style={{ display: "grid", gap: 10, maxHeight: 220, overflowY: "auto", paddingRight: 4 }}>
                  {filteredMatchShooterOptions.map((shooter) => (
                    <button
                      key={shooter.ShooterID}
                      type="button"
                      onClick={() => addShooterToMatchRoster(shooter.ShooterID)}
                      style={{
                        ...secondaryButtonStyle,
                        justifyContent: "space-between",
                        textAlign: "left",
                        width: "100%",
                      }}
                    >
                      <span>{shooter.Name}{shooter.Level ? ` (L${shooter.Level})` : ""}</span>
                      <Plus size={18} />
                    </button>
                  ))}
                  {!filteredMatchShooterOptions.length ? (
                    <div style={{ color: theme.subtext, textAlign: "center", padding: "10px 0" }}>
                      No shooters match that search.
                    </div>
                  ) : null}
                </div>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Match Roster
                </div>
                {matchRosterIds.length ? (
                  <div style={{ display: "grid", gap: 10 }}>
                    {matchRosterIds.map((shooterId, index) => {
                      const shooter = findItemById(shooters, shooterId, "ShooterID");
                      return (
                        <div
                          key={`match-roster-${shooterId}`}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "56px minmax(0, 1fr) auto",
                            gap: 10,
                            alignItems: "center",
                            padding: 12,
                            borderRadius: 14,
                            background: theme.cardBgSoft,
                            border: `1px solid ${theme.border}`,
                          }}
                        >
                          <div style={{ fontSize: 18, fontWeight: 800, color: theme.accent, textAlign: "center" }}>
                            {index + 1}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: theme.text, fontWeight: 800, fontSize: 18 }}>
                              {shooter?.Name || shooterId}
                            </div>
                            <div style={{ color: theme.subtext, fontSize: 14 }}>
                              {shooter?.Level ? `Level ${shooter.Level}` : "Shooter"}
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 8 }}>
                            <button type="button" style={secondaryButtonStyle} onClick={() => moveMatchRosterShooter(shooterId, "up")}>↑</button>
                            <button type="button" style={secondaryButtonStyle} onClick={() => moveMatchRosterShooter(shooterId, "down")}>↓</button>
                            <button type="button" style={secondaryButtonStyle} onClick={() => removeShooterFromMatchRoster(shooterId)}>Remove</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ color: theme.subtext }}>
                    Add shooters to build the running order.
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={startMatch}>
                  Start Match
                </button>
                <button type="button" style={secondaryButtonStyle} onClick={resetMatchBuilder}>
                  Clear Builder
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
                <div style={infoPillStyle}><strong>Match:</strong><br />{activeMatch.name}</div>
                <div style={infoPillStyle}><strong>Drill:</strong><br />{findItemById(drills, activeMatch.drillId, "DrillID")?.DrillName || activeMatch.drillId}</div>
                <div style={infoPillStyle}><strong>Session:</strong><br />{findItemById(sessions, activeMatch.sessionId, "SessionID")?.SessionName || activeMatch.sessionId}</div>
                <div style={infoPillStyle}><strong>Progress:</strong><br />{Math.min((activeMatch.currentIndex || 0) + 1, activeMatch.shooterIds.length)} / {activeMatch.shooterIds.length}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <div style={{ ...tableContainerStyle, padding: 18 }}>
                  <div style={sectionEyebrowStyle}>Now Up</div>
                  <div style={{ fontSize: 28, fontWeight: 900, color: theme.text }}>
                    {activeMatchCurrentShooter?.Name || "Done"}
                  </div>
                </div>
                <div style={{ ...tableContainerStyle, padding: 18 }}>
                  <div style={sectionEyebrowStyle}>On Deck</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: theme.text }}>
                    {activeMatchNextShooter?.Name || "No one"}
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button type="button" style={buttonStyle} onClick={() => { syncMatchSelection(activeMatch); setActiveTab("timer"); }}>
                  <Play size={18} /> Open Timer
                </button>
                <button type="button" style={secondaryButtonStyle} onClick={skipCurrentMatchShooter}>
                  <SkipForward size={18} /> Skip Shooter
                </button>
                <button type="button" style={secondaryButtonStyle} onClick={() => finishMatch()}>
                  <CheckCircle2 size={18} /> Finish Match
                </button>
              </div>

              <div style={{ ...tableContainerStyle, padding: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                  Roster Status
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {activeMatch.shooterIds.map((shooterId, index) => {
                    const shooter = findItemById(shooters, shooterId, "ShooterID");
                    const result = (activeMatch.results || []).find(
                      (entry) => String(entry.shooterId) === String(shooterId)
                    );
                    const isCurrent = index === activeMatch.currentIndex;
                    return (
                      <div
                        key={`active-match-${shooterId}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "56px minmax(0, 1fr) auto",
                          gap: 10,
                          alignItems: "center",
                          padding: 12,
                          borderRadius: 14,
                          background: isCurrent ? theme.accentSoft : theme.cardBgSoft,
                          border: `1px solid ${isCurrent ? theme.accent : theme.border}`,
                        }}
                      >
                        <div style={{ fontSize: 18, fontWeight: 800, color: theme.accent, textAlign: "center" }}>
                          {index + 1}
                        </div>
                        <div>
                          <div style={{ color: theme.text, fontWeight: 800, fontSize: 18 }}>
                            {shooter?.Name || shooterId}
                          </div>
                          <div style={{ color: theme.subtext, fontSize: 14 }}>
                            {result ? `Saved ${result.totalTime || "—"}s • ${result.passFail || "Scored"}` : isCurrent ? "Current shooter" : "Waiting"}
                          </div>
                        </div>
                        <div style={{ color: result ? theme.successText : isCurrent ? theme.accent : theme.subtext, fontWeight: 800 }}>
                          {result ? "Done" : isCurrent ? "Up" : "Queued"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
	            </div>
	          )}
	        </div>

	        <div
  style={{
    ...boxStyle,
    marginBottom: 20,
    display: activeTab === "recent" ? "block" : "none",
  }}
>
          <div style={sectionEyebrowStyle}>Browse</div>
          <h2 style={sectionTitleStyle}>Recent Runs</h2>
          <p style={sectionSubtitleStyle}>
            Filter by shooter, drill, session, or result to quickly find a past run and open its attached video inside the app.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
            <div style={filterCardStyle}>
            <select style={inputStyle} value={filterShooter} onChange={(e) => setFilterShooter(e.target.value)}>
              <option value="all">All Shooters</option>
              {shooters.map((s) => (
                <option key={s.ShooterID} value={s.ShooterID}>{s.Name}</option>
              ))}
            </select>
            </div>

            <div style={filterCardStyle}>
            <select style={inputStyle} value={filterDrill} onChange={(e) => setFilterDrill(e.target.value)}>
              <option value="all">All Drills</option>
              {drills.map((d) => (
                <option key={d.DrillID} value={d.DrillID}>{d.DrillName}</option>
              ))}
            </select>
            </div>

            <div style={filterCardStyle}>
            <select style={inputStyle} value={filterSession} onChange={(e) => setFilterSession(e.target.value)}>
              <option value="all">All Sessions</option>
              {sessions.map((s) => (
                <option key={s.SessionID} value={s.SessionID}>{s.SessionName}</option>
              ))}
            </select>
            </div>

            <div style={filterCardStyle}>
            <select style={inputStyle} value={filterPassFail} onChange={(e) => setFilterPassFail(e.target.value)}>
              <option value="all">All Results</option>
              <option value="Pass">Pass Only</option>
              <option value="Fail">Fail Only</option>
            </select>
            </div>
          </div>
          {Capacitor.isNativePlatform() ? (
            <div style={{ display: "grid", gap: 12 }}>
              {appRecentRunEntries.length === 0 ? (
                <div
                  style={{
                    padding: 18,
                    borderRadius: 18,
                    border: `1px solid ${theme.border}`,
                    background: theme.cardBgSoft,
                    color: theme.subtext,
                    textAlign: "center",
                  }}
                >
                  No runs matched the current filters.
                </div>
              ) : (
                appRecentRunEntries.map((entry) => {
                  const { run, shooter, drill, session, videoMeta } = entry;

	                  return (
	                    <button
	                      key={entry.id}
	                      type="button"
	                      onClick={() => setSelectedRecentRun(entry)}
	                      style={{
	                        textAlign: "left",
	                        display: "grid",
	                        gap: 10,
	                        padding: "14px 12px",
	                        borderRadius: 0,
	                        border: "none",
	                        borderBottom: `1px solid ${theme.border}`,
	                        background: "transparent",
	                        color: theme.text,
	                        cursor: "pointer",
	                      }}
	                    >
	                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
	                        <div style={{ minWidth: 0, flex: 1 }}>
	                          <div style={{ fontSize: 19, fontWeight: 800, color: theme.text, lineHeight: 1.15 }}>
	                            {shooter?.Name || run.ShooterID}
	                          </div>
	                          <div style={{ fontSize: 14, color: theme.subtext, marginTop: 3 }}>
	                            {(drill?.DrillName || run.DrillID) || "Drill"} • {session?.SessionName || run.SessionID || "Session"}
	                          </div>
	                        </div>
	                        <div style={{ fontSize: 14, color: theme.subtext, whiteSpace: "nowrap" }}>
	                          {formatDateOnly(getRunTimestamp(run))}
	                        </div>
	                      </div>

	                      <div
	                        style={{
	                          display: "grid",
	                          gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
	                          gap: 10,
	                        }}
	                      >
	                        {[
	                          { label: "Total", value: run.TotalTime || "—" },
	                          { label: "Shots", value: run.ShotCount || "—" },
	                          { label: "Result", value: run.PassFail || "—" },
	                          { label: "First", value: run.FirstShot || "—" },
	                          { label: "Avg", value: formatSplitForDisplay(run.AvgSplit) || "—" },
	                          { label: "Best", value: formatSplitForDisplay(run.BestSplit) || "—" },
	                        ].map((item) => (
	                          <div
	                            key={`${entry.id}-${item.label}`}
	                            style={{
	                              minWidth: 0,
	                            }}
	                          >
	                            <div
	                              style={{
	                                fontSize: 10,
	                                fontWeight: 800,
	                                color: theme.subtext,
	                                textTransform: "uppercase",
	                                letterSpacing: 0.4,
	                                marginBottom: 2,
	                              }}
	                            >
	                              {item.label}
	                            </div>
	                            <div
	                              style={{
	                                fontSize: 16,
	                                fontWeight: 700,
	                                color: theme.text,
	                                whiteSpace: "nowrap",
	                                overflow: "hidden",
	                                textOverflow: "ellipsis",
	                                fontVariantNumeric: "tabular-nums",
	                              }}
	                            >
	                              {item.value}
	                            </div>
	                          </div>
	                        ))}
	                      </div>
	                      {videoMeta ? (
	                        <div
	                          style={{
	                            display: "flex",
	                            justifyContent: "flex-start",
	                            marginTop: 2,
	                          }}
	                        >
	                          <button
	                            type="button"
	                            onClick={(event) => {
	                              event.stopPropagation();
	                              openRunVideoPlayer(
	                                videoMeta,
	                                `${shooter?.Name || "Shooter"} - ${drill?.DrillName || "Run"}`
	                              );
	                            }}
	                            style={{
	                              minWidth: 118,
	                              padding: "9px 14px",
	                              borderRadius: 12,
	                              border: `1px solid ${theme.accent}`,
	                              background: theme.accentSoft,
	                              color: theme.accent,
	                              fontSize: 13,
	                              fontWeight: 800,
	                              cursor: "pointer",
	                              whiteSpace: "nowrap",
	                            }}
	                          >
	                            Open Video
	                          </button>
	                        </div>
	                      ) : null}
	                    </button>
	                  );
	                })
              )}
            </div>
          ) : (
            <div style={{ ...tableContainerStyle, marginTop: 16 }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: 1080, borderCollapse: "separate", borderSpacing: "0 0", fontSize: 18 }}>
                  <thead>
                    <tr>
                      <th style={{ ...centeredTableHeaderFirstCellStyle, whiteSpace: "nowrap" }}>Date</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 110 }}>Shooter</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 110 }}>Drill</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 64 }}>Time</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 54 }}>Shots</th>
                      <th style={centeredCompactMetricHeaderCellStyle}>First</th>
                      <th style={centeredCompactMetricHeaderCellStyle}>Avg</th>
                      <th style={centeredCompactMetricHeaderCellStyle}>Best</th>
                      <th style={centeredCompactMetricHeaderCellStyle}>Worst</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 60 }}>Score</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 76 }}>Pass/Fail</th>
                      <th style={{ ...centeredTableHeaderCellStyle, whiteSpace: "nowrap", minWidth: 72 }}>Video</th>
                    </tr>
                  </thead>
                  <tbody>
                    {appRecentRunEntries.length === 0 ? (
                      <tr>
                        <td colSpan={12} style={{ padding: "18px 12px", color: theme.subtext, textAlign: "center" }}>
                          No runs matched the current filters.
                        </td>
                      </tr>
                    ) : appRecentRunEntries.map((entry, index) => {
                      const { run, shooter, drill, session, videoMeta } = entry;
                      const localVideoHref = videoMeta?.localFilePath
                        ? Capacitor.convertFileSrc(videoMeta.localFilePath)
                        : "";

                      return (
                        <tr
                          key={entry.id}
                          onClick={() => setSelectedRecentRun(entry)}
                          style={{
                            cursor: "pointer",
                            borderTop: index === 0 ? "none" : `1px solid ${theme.border}`,
                          }}
                        >
                          <td style={{ padding: "12px 10px 12px 0", color: theme.text, whiteSpace: "nowrap" }}>{formatDateOnly(getRunTimestamp(run))}</td>
                          <td style={{ padding: "12px 10px", color: theme.text, fontWeight: 700, whiteSpace: "nowrap", minWidth: 110 }}>{shooter?.Name || run.ShooterID}</td>
                          <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", minWidth: 110 }}>{drill?.DrillName || run.DrillID}</td>
                          <td style={{ padding: "12px 10px", color: theme.text, fontWeight: 700, whiteSpace: "nowrap", minWidth: 64, fontVariantNumeric: "tabular-nums" }}>{run.TotalTime}</td>
                          <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", minWidth: 54, fontVariantNumeric: "tabular-nums" }}>{run.ShotCount}</td>
                          <td style={compactMetricCellStyle}>{run.FirstShot || ""}</td>
                          <td style={compactMetricCellStyle}>{formatSplitForDisplay(run.AvgSplit)}</td>
                          <td style={compactMetricCellStyle}>{formatSplitForDisplay(run.BestSplit)}</td>
                          <td style={compactMetricCellStyle}>{formatSplitForDisplay(run.WorstSplit)}</td>
                          <td style={{ padding: "12px 10px", color: theme.text, whiteSpace: "nowrap", minWidth: 60, fontVariantNumeric: "tabular-nums" }}>{run.Score || ""}</td>
                          <td style={{ padding: "12px 10px", color: run.PassFail === "Pass" ? theme.successText : run.PassFail === "Fail" ? theme.dangerText : theme.subtext, fontWeight: 700, whiteSpace: "nowrap", minWidth: 76 }}>{run.PassFail || ""}</td>
                          <td style={{ padding: "12px 10px" }}>
                            {videoMeta?.url ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openRunVideoPlayer(
                                    videoMeta,
                                    `${shooter?.Name || "Shooter"} - ${drill?.DrillName || "Run"}`
                                  );
                                }}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: theme.accent,
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                  padding: 0,
                                  fontSize: 15,
                                  fontWeight: 700,
                                }}
                              >
                                Cloud Video
                              </button>
                            ) : localVideoHref && Capacitor.isNativePlatform() ? (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openRunVideoPlayer(
                                    {
                                      ...videoMeta,
                                      localFilePath: videoMeta?.localFilePath || "",
                                    },
                                    `${shooter?.Name || "Shooter"} - ${drill?.DrillName || "Run"}`
                                  );
                                }}
                                style={{
                                  background: "transparent",
                                  border: "none",
                                  color: theme.accent,
                                  textDecoration: "underline",
                                  cursor: "pointer",
                                  padding: 0,
                                  fontSize: 15,
                                  fontWeight: 700,
                                }}
                              >
                                Local Video
                              </button>
                            ) : videoMeta ? (
                              <span style={{ color: theme.subtext, fontSize: 14 }}>
                                Attached ({videoMeta.name || "video"})
                              </span>
                            ) : (
                              <span style={{ color: theme.subtext, fontSize: 14 }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  </PullToRefresh>
        <div
  style={{
    position: "fixed",
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    background: theme.tabBarBg,
    backdropFilter: "blur(20px)",
    WebkitBackdropFilter: "blur(20px)",
    border: `1px solid ${theme.tabBorder}`,
    borderRadius: 22,
    boxShadow: theme.shadow,
    padding: "8px 10px calc(12px + env(safe-area-inset-bottom))",
    transition: "background 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease",
  }}
>
  <div
    style={{
      display: "flex",
      justifyContent: "space-around",
      alignItems: "center",
    }}
  >
<button style={tabButtonStyle("timer")} onClick={() => setActiveTab("timer")}>
  <div style={tabIconStyle("timer")}>
    <Timer size={22} />
  </div>
  <div>Timer</div>
</button>

<button style={tabButtonStyle("match")} onClick={() => setActiveTab("match")}>
  <div style={tabIconStyle("match")}>
    <Users size={22} />
  </div>
  <div>Match</div>
</button>

<button style={tabButtonStyle("log")} onClick={() => setActiveTab("log")}>
  <div style={tabIconStyle("log")}>
    <PenLine size={22} />
  </div>
  <div>Log</div>
</button>

<button style={tabButtonStyle("progress")} onClick={() => setActiveTab("progress")}>
  <div style={tabIconStyle("progress")}>
    <TrendingUp size={22} />
  </div>
  <div>Progress</div>
</button>

<button style={tabButtonStyle("leaderboard")} onClick={() => setActiveTab("leaderboard")}>
  <div style={tabIconStyle("leaderboard")}>
    <Trophy size={22} />
  </div>
  <div>Leaders</div>
</button>

<button style={tabButtonStyle("recent")} onClick={() => setActiveTab("recent")}>
  <div style={tabIconStyle("recent")}>
    <Clock size={22} />
  </div>
  <div>Recent</div>
</button>

<button
  style={tabButtonStyle("course")}
  onClick={() => {
    setActiveTab("course");
    setActiveCourseId("");
    setCourseHomeToken((current) => current + 1);
  }}
>
  <div style={tabIconStyle("course")}>
    <BookOpen size={22} />
  </div>
  <div>Course</div>
</button>
  </div>
</div>

{selectorOpen
  ? createPortal(
      <div
        onClick={() => {
  setSelectorOpen(null);
  setShooterSearch("");
}}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.72)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "center",
          zIndex: 999999,
          padding: Capacitor.isNativePlatform() ? "88px 20px 20px 20px" : 20,
        }}
      >
    <div
  onClick={(e) => e.stopPropagation()}
  style={{
    width: "100%",
    maxWidth: 420,
    maxHeight: "72vh",
    overflow: "hidden",
    background: theme.cardBg,
    border: `1px solid ${theme.border}`,
    borderRadius: 22,
    boxShadow: theme.shadow,
    padding: 16,
    display: "flex",
    flexDirection: "column",
  }}
>

  {/* 🔥 TITLE + X ROW (START) */}
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 14,
    }}
  >
    <div
      style={{
        fontSize: 20,
        fontWeight: 800,
        color: theme.text,
      }}
    >
      Select {selectorOpen === "shooter" ? "Shooter" : selectorOpen === "drill" ? "Drill" : "Session"}
    </div>

    <button
      onClick={() => {
        setSelectorOpen(null);
        setShooterSearch("");
      }}
      style={{
        background: "transparent",
        border: "none",
        color: theme.subtext,
        fontSize: 22,
        cursor: "pointer",
        lineHeight: 1,
      }}
    >
      ×
    </button>
  </div>
  {/* 🔥 TITLE + X ROW (END) */}

  {/* 🔥 SEARCH BAR (NOW SEPARATE) */}
  {selectorOpen === "shooter" && (
    <input
      style={{
        ...inputStyle,
        width: "100%",
        boxSizing: "border-box",
        marginBottom: 14,
      }}
      placeholder="Search shooter..."
      value={shooterSearch}
      onChange={(e) => setShooterSearch(e.target.value)}
      type="text"
      onClick={(e) => e.stopPropagation()}
    />
  )}

  {/* 🔥 LIST START */}
  <div
    style={{
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      WebkitOverflowScrolling: "touch",
      paddingRight: 2,
    }}
  >
  {(() => {
    const list =
      selectorOpen === "shooter"
        ? filteredShooterList
        : selectorOpen === "drill"
        ? drills
        : sessions;

    if (selectorOpen === "shooter" && list.length === 0) {
      return (
        <div
          style={{
            padding: "16px 12px",
            borderRadius: 14,
            border: `1px solid ${theme.border}`,
            background: theme.cardBgSoft,
            color: theme.subtext,
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          No shooters found
        </div>
      );
    }

    return list.map((item) => {
      const key =
        selectorOpen === "shooter"
          ? item.ShooterID
          : selectorOpen === "drill"
          ? item.DrillID
          : item.SessionID;

      const label =
        selectorOpen === "shooter"
          ? `${item.Name}${item.Level ? ` (L${item.Level})` : ""}`
          : selectorOpen === "drill"
          ? item.DrillName
          : item.SessionName;

      return (
        <div
          key={key}
          onClick={() => {
            if (selectorOpen === "shooter") {
              setSelectedShooter(String(item.ShooterID));
              selectedShooterRef.current = String(item.ShooterID);
              setShooterSearch("");
            } else if (selectorOpen === "drill") {
              setSelectedDrill(String(item.DrillID));
              selectedDrillRef.current = String(item.DrillID);
            } else {
              setSelectedSession(String(item.SessionID));
              selectedSessionRef.current = String(item.SessionID);

              const sessionName = String(item.SessionName || "").trim().toUpperCase();

              if (isUspsaSessionName(sessionName)) {
                const courseDrill = drills.find(
                  (d) => String(d.DrillName || "").trim().toUpperCase() === "COURSE"
                );

                if (courseDrill) {
                  setSelectedDrill(String(courseDrill.DrillID));
                  selectedDrillRef.current = String(courseDrill.DrillID);
                }
              }
            }

            setSelectorOpen(null);
          }}
          style={{
            padding: "14px 12px",
            borderRadius: 14,
            border: `1px solid ${theme.border}`,
            background: theme.cardBgSoft,
            color: theme.text,
            marginBottom: 10,
            cursor: "pointer",
            fontWeight: 600,
          }}
        >
          {label}
        </div>
      );
    });
  })()}
  </div>
  {/* 🔥 LIST END */}

</div>
      </div>,
      document.body
    )
  : null}

{activeRunVideo
  ? createPortal(
      <div
        onClick={closeRunVideoPlayer}
        style={{
          position: "fixed",
          inset: 0,
          background: "#000",
          zIndex: 1000000,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          onTouchStart={handleRunVideoTouchStart}
          onTouchMove={handleRunVideoTouchMove}
          onTouchEnd={handleRunVideoTouchEnd}
          style={{
            position: "absolute",
            inset: 0,
            background: "#000",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              paddingTop: "max(54px, calc(env(safe-area-inset-top) + 18px))",
              paddingRight: 16,
              paddingBottom: 12,
              paddingLeft: 16,
              background: "linear-gradient(to bottom, rgba(0,0,0,0.72), rgba(0,0,0,0.18), transparent)",
              position: "relative",
              zIndex: 2,
            }}
          >
            <div
              style={{
                fontSize: 17,
                fontWeight: 800,
                color: "#fff",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {activeRunVideo.title || "Run Video"}
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeRunVideoPlayer();
              }}
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                background: "rgba(255,255,255,0.12)",
                border: "1px solid rgba(255,255,255,0.14)",
                color: "#fff",
                fontSize: 22,
                lineHeight: "40px",
                cursor: "pointer",
                padding: 0,
                position: "relative",
                zIndex: 5,
              }}
            >
              ×
            </button>
          </div>

          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 0,
              paddingTop: 8,
              paddingBottom: "max(12px, env(safe-area-inset-bottom))",
              position: "relative",
              zIndex: 1,
            }}
          >
            {activeRunVideo.mode === "iframe" ? (
              <iframe
                title={activeRunVideo.title || "Run Video"}
                src={activeRunVideo.fallbackUrl || activeRunVideo.externalUrl || activeRunVideo.url}
                allow="autoplay; fullscreen"
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "#000",
                }}
              />
            ) : (
              <video
                key={activeRunVideo.url}
                controls
                autoPlay
                playsInline
                preload="metadata"
                controlsList="nofullscreen noremoteplayback"
                disablePictureInPicture
                disableRemotePlayback
                src={activeRunVideo.url}
                onError={handleRunVideoPlaybackError}
                style={{
                  width: "100%",
                  maxHeight: "100%",
                  background: "#000",
                  objectFit: "contain",
                }}
              />
            )}
          </div>

          {activeRunVideo.errorMessage ? (
            <div
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                bottom: "max(48px, calc(env(safe-area-inset-bottom) + 46px))",
                zIndex: 2,
                textAlign: "center",
                color: "#f8d7da",
                fontSize: 13,
                fontWeight: 700,
                textShadow: "0 2px 12px rgba(0,0,0,0.55)",
              }}
            >
              {activeRunVideo.errorMessage}
            </div>
          ) : null}

          {activeRunVideo.externalUrl ? (
            <div
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                bottom: "max(14px, env(safe-area-inset-bottom))",
                zIndex: 2,
                textAlign: "center",
              }}
            >
              <button
                type="button"
                onClick={(event) =>
                  openRunVideoExternalLink(
                    event,
                    activeRunVideo.browserUrl || activeRunVideo.externalUrl
                  )
                }
                style={{
                  color: "#fff",
                  textDecoration: "underline",
                  fontSize: 14,
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textShadow: "0 2px 12px rgba(0,0,0,0.55)",
                }}
              >
                Open in browser instead
              </button>
            </div>
          ) : null}
        </div>
      </div>,
      document.body
    )
  : null}

{selectedRecentRun
  ? createPortal(
      <div
        onClick={closeRecentRunDetail}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.74)",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          zIndex: 1000000,
          padding: 16,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            maxWidth: 820,
            maxHeight: "84vh",
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            background: theme.cardBg,
            border: `1px solid ${theme.border}`,
            borderRadius: 24,
            boxShadow: theme.shadow,
            padding: 18,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              marginBottom: 14,
            }}
          >
            <div>
              <div style={sectionEyebrowStyle}>Run Detail</div>
              <div style={{ fontSize: 24, fontWeight: 900, color: theme.text }}>
                {selectedRecentRun.shooter?.Name || selectedRecentRun.run.ShooterID} · {selectedRecentRun.drill?.DrillName || selectedRecentRun.run.DrillID}
              </div>
            </div>
            <button
              type="button"
              onClick={closeRecentRunDetail}
              style={{
                background: "transparent",
                border: "none",
                color: theme.subtext,
                fontSize: 24,
                cursor: "pointer",
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
            <div style={infoPillStyle}><strong>Date:</strong><br />{formatDateOnly(getRunTimestamp(selectedRecentRun.run))}</div>
            <div style={infoPillStyle}><strong>Session:</strong><br />{selectedRecentRun.session?.SessionName || selectedRecentRun.run.SessionID || "—"}</div>
            <div style={infoPillStyle}><strong>Qual Level:</strong><br />{selectedRecentRun.run.QualificationLevel || "—"}</div>
            <div style={infoPillStyle}><strong>Pass/Fail:</strong><br />{selectedRecentRun.run.PassFail || "—"}</div>
            <div style={infoPillStyle}><strong>Score:</strong><br />{selectedRecentRun.run.Score || "—"}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
            <div style={infoPillStyle}><strong>Total:</strong><br />{selectedRecentRun.run.TotalTime || "—"}</div>
            <div style={infoPillStyle}><strong>Shots:</strong><br />{selectedRecentRun.run.ShotCount || "—"}</div>
            <div style={infoPillStyle}><strong>First:</strong><br />{selectedRecentRun.run.FirstShot || "—"}</div>
            <div style={infoPillStyle}><strong>Avg Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.AvgSplit) || "—"}</div>
            <div style={infoPillStyle}><strong>Best Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.BestSplit) || "—"}</div>
            <div style={infoPillStyle}><strong>Worst Split:</strong><br />{formatSplitForDisplay(selectedRecentRun.run.WorstSplit) || "—"}</div>
          </div>

          {[
            selectedRecentRun.run.AHits,
            selectedRecentRun.run.CHits,
            selectedRecentRun.run.DHits,
            selectedRecentRun.run.Misses,
            selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots,
            selectedRecentRun.run.SteelHits,
            selectedRecentRun.run.SteelMisses,
            selectedRecentRun.run.TotalPoints,
            selectedRecentRun.run.HitFactor,
            selectedRecentRun.run.PowerFactor,
          ].some((value) => String(value ?? "").trim() !== "") ? (
            <div
              style={{
                padding: 16,
                borderRadius: 18,
                border: `1px solid ${theme.border}`,
                background: theme.cardBgSoft,
                marginBottom: 16,
              }}
            >
              <div style={sectionEyebrowStyle}>Scoring</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10 }}>
                <div style={infoPillStyle}><strong>A Hits:</strong><br />{selectedRecentRun.run.AHits || "—"}</div>
                <div style={infoPillStyle}><strong>C Hits:</strong><br />{selectedRecentRun.run.CHits || "—"}</div>
                <div style={infoPillStyle}><strong>D Hits:</strong><br />{selectedRecentRun.run.DHits || "—"}</div>
                <div style={infoPillStyle}><strong>Misses:</strong><br />{selectedRecentRun.run.Misses || "—"}</div>
                <div style={infoPillStyle}><strong>No Shoot:</strong><br />{selectedRecentRun.run.NoShoot || selectedRecentRun.run.NoShoots || selectedRecentRun.run.noShoots || "—"}</div>
                <div style={infoPillStyle}><strong>Steel Hits:</strong><br />{selectedRecentRun.run.SteelHits || "—"}</div>
                <div style={infoPillStyle}><strong>Steel Misses:</strong><br />{selectedRecentRun.run.SteelMisses || "—"}</div>
                <div style={infoPillStyle}><strong>Total Points:</strong><br />{selectedRecentRun.run.TotalPoints || "—"}</div>
                <div style={infoPillStyle}><strong>Hit Factor:</strong><br />{selectedRecentRun.run.HitFactor || "—"}</div>
                <div style={infoPillStyle}><strong>Power Factor:</strong><br />{selectedRecentRun.run.PowerFactor || "—"}</div>
              </div>
            </div>
          ) : null}

          <div
            style={{
              padding: 16,
              borderRadius: 18,
              border: `1px solid ${theme.border}`,
              background: theme.cardBgSoft,
              marginBottom: 16,
            }}
          >
            <div style={sectionEyebrowStyle}>Notes</div>
            <div style={{ color: selectedRecentRun.displayNotes ? theme.text : theme.subtext, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
              {selectedRecentRun.displayNotes || "No notes added for this run."}
            </div>
          </div>

          {selectedRecentRun.videoMeta ? (
            <div
              style={{
                padding: 16,
                borderRadius: 18,
                border: `1px solid ${theme.border}`,
                background: theme.cardBgSoft,
              }}
            >
              <div style={sectionEyebrowStyle}>Video</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: theme.text, marginBottom: 10 }}>
                Attached Video
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 12 }}>
                <div style={infoPillStyle}><strong>Name:</strong><br />{selectedRecentRun.videoMeta.name || "Video"}</div>
                <div style={infoPillStyle}><strong>Status:</strong><br />{selectedRecentRun.videoMeta.status || "Attached"}</div>
                <div style={infoPillStyle}><strong>Storage:</strong><br />{selectedRecentRun.videoMeta.storage || "—"}</div>
                <div style={infoPillStyle}><strong>Uploaded:</strong><br />{selectedRecentRun.videoMeta.uploadedAt ? formatDate(selectedRecentRun.videoMeta.uploadedAt) : "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() =>
                    openRunVideoPlayer(
                      selectedRecentRun.videoMeta,
                      `${selectedRecentRun.shooter?.Name || "Shooter"} - ${selectedRecentRun.drill?.DrillName || "Run"}`
                    )
                  }
                >
                  Play Video
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>,
      document.body
    )
  : null}

        {activeTab === "course"
          ? createPortal(
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: Capacitor.isNativePlatform() ? 88 : 84,
                  zIndex: 40,
                  background: theme.pageBg,
                }}
              >
                <CourseLibrary
                  theme={theme}
                  drills={drills}
                  sessions={sessions}
                  activeCourseId={activeCourseId}
                  setActiveCourseId={setActiveCourseId}
                  courseHomeToken={courseHomeToken}
                  onUseCourse={handleUseCourse}
                  message={message}
                />
              </div>,
              document.body
            )
          : null}

  {showTimerPicker ? (
  <div
    onClick={() => setShowTimerPicker(false)}
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.72)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 999999,
      padding: 20,
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width: "100%",
        maxWidth: 420,
        background: theme.cardBg,
        border: `1px solid ${theme.border}`,
        borderRadius: 22,
        boxShadow: theme.shadow,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            color: theme.text,
          }}
        >
          Select Timer
        </div>

        <button
          onClick={() => setShowTimerPicker(false)}
          style={{
            background: "transparent",
            border: "none",
            color: theme.subtext,
            fontSize: 22,
            cursor: "pointer",
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {scanningTimers ? (
        <div
          style={{
            padding: "16px 12px",
            borderRadius: 14,
            border: `1px solid ${theme.border}`,
            background: theme.cardBgSoft,
            color: theme.subtext,
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          Searching for timers...
        </div>
      ) : availableTimers.length === 0 ? (
        <div
          style={{
            padding: "16px 12px",
            borderRadius: 14,
            border: `1px solid ${theme.border}`,
            background: theme.cardBgSoft,
            color: theme.subtext,
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          No timers found
        </div>
      ) : (
        availableTimers.map((timer) => (
          <div
            key={timer.id}
            onClick={() => connectToNativeTimer(timer)}
            style={{
              padding: "14px 12px",
              borderRadius: 14,
              border: `1px solid ${theme.border}`,
              background: theme.cardBgSoft,
              color: theme.text,
              marginBottom: 10,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {timer.name}
          </div>
        ))
      )}
    </div>
  </div>
) : null}

{showUspsaScoringModal && pendingUspsaRun ? (
  <div
  onClick={clearUspsaScoringState}
  style={{
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.75)",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    zIndex: 999999,
    padding: Capacitor.isNativePlatform() ? "24px 12px 24px 12px" : 20,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  }}
>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
  width: "100%",
  maxWidth: 420,
  marginTop: Capacitor.isNativePlatform() ? 24 : 40,
  marginBottom: Capacitor.isNativePlatform() ? 24 : 40,
  background: theme.pageBg,
  border: `1px solid ${theme.border}`,
  borderRadius: 22,
  padding: 18,
}}
    >
      <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  }}
>
  <div style={{ fontSize: 22, fontWeight: 800, color: theme.text }}>
    {pendingUspsaRun?.scoringType === "LEVEL_EVALUATION"
      ? "Level Evaluation Scoring"
      : "USPSA Scoring"}
  </div>

  <button
    onClick={clearUspsaScoringState}
    style={{
      background: "transparent",
      border: "none",
      color: theme.subtext,
      fontSize: 24,
      cursor: "pointer",
      lineHeight: 1,
      padding: 0,
    }}
  >
    ×
  </button>
</div>

{showTimerPicker && (
  <div
    onClick={() => setShowTimerPicker(false)}
    style={{
      position: "fixed",
      inset: 0,
      background: "rgba(0,0,0,0.72)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 999999,
      padding: 20,
    }}
  >
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        width: "100%",
        maxWidth: 420,
        background: theme.cardBg,
        border: `1px solid ${theme.border}`,
        borderRadius: 22,
        boxShadow: theme.shadow,
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 800, color: theme.text }}>
          Select Timer
        </div>

        <button
          onClick={() => setShowTimerPicker(false)}
          style={{
            background: "transparent",
            border: "none",
            color: theme.subtext,
            fontSize: 22,
            cursor: "pointer",
          }}
        >
          ×
        </button>
      </div>

      {scanningTimers ? (
        <div style={{ textAlign: "center", color: theme.subtext }}>
          Searching for timers...
        </div>
      ) : availableTimers.length === 0 ? (
        <div style={{ textAlign: "center", color: theme.subtext }}>
          No timers found
        </div>
      ) : (
        availableTimers.map((timer) => (
          <div
            key={timer.id}
            onClick={() => connectToNativeTimer(timer)}
            style={{
              padding: "14px 12px",
              borderRadius: 14,
              border: `1px solid ${theme.border}`,
              background: theme.cardBgSoft,
              color: theme.text,
              marginBottom: 10,
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {timer.name}
          </div>
        ))
      )}
    </div>
  </div>
)}

      <div style={{ marginBottom: 12, color: theme.text }}>
        Time: {pendingUspsaRun.totalTime ?? pendingUspsaRun.TotalTime}s
      </div>

      <input
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }}
        placeholder="Stage Name"
        value={stageName}
        onChange={(e) => setStageName(e.target.value)}
        type="text"
      />

      <select
        style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 10 }}
        value={powerFactor}
        onChange={(e) => setPowerFactor(e.target.value)}
      >
        <option value="minor">Minor</option>
        <option value="major">Major</option>
      </select>
      

      <div
      style={{
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 10,
    marginBottom: 12,
  }}
>
  {[
    { label: "+A", value: aHits, setter: setAHits },
    { label: "+C", value: cHits, setter: setCHits },
    { label: "+D", value: dHits, setter: setDHits },
    { label: "+M", value: misses, setter: setMisses },
    { label: "+NS", value: noShoots, setter: setNoShoots },
    { label: "+SH", value: steelHits, setter: setSteelHits },
    { label: "+SM", value: steelMisses, setter: setSteelMisses },
  ].map((item, i) => (
    <div
      key={i}
      style={{
        background: theme.cardBgSoft,
        borderRadius: 14,
        padding: 10,
        border: `1px solid ${theme.border}`,
      }}
    >
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => item.setter(String(Math.max(0, Number(item.value || 0) - 1)))}
          style={{
            width: 52,
            minWidth: 52,
            padding: "10px 0",
            borderRadius: 14,
            border: `1px solid ${theme.border}`,
            background: theme.cardBg,
            color: theme.text,
            fontWeight: 800,
            fontSize: 20,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          -
        </button>

        <input
          style={{
            ...inputStyle,
            textAlign: "center",
            margin: 0,
            minWidth: 0,
            flex: 1,
            padding: "10px 8px",
            fontSize: 18,
          }}
          value={item.value}
          onChange={(e) => item.setter(e.target.value)}
          type="number"
        />

        <button
          onClick={() => item.setter(String(Number(item.value || 0) + 1))}
          style={{
            width: 72,
            minWidth: 72,
            padding: "10px 0",
            borderRadius: 14,
            border: "none",
            background: "linear-gradient(135deg, #d4af37, #b8962e)",
            color: "#000",
            fontWeight: 800,
            fontSize: 16,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {item.label}
        </button>
      </div>
    </div>
  ))}
</div>

<div style={{ marginBottom: 6, color: theme.subtext }}>
  Total Points: {uspsaScore.points}
</div>

<div style={{ marginBottom: 12, color: theme.subtext }}>
  Hit Factor: {uspsaScore.hitFactor === "" ? "-" : uspsaScore.hitFactor}
</div>

<div style={{ height: 10 }} />

<button
  onClick={completeUspsaScoringAndLog}
  style={{
    width: "100%",
    padding: "18px 16px",
    borderRadius: 18,
    border: "none",
    background: "linear-gradient(135deg, #d4af37, #b8962e)",
    color: "#000",
    fontWeight: 800,
    fontSize: 18,
    cursor: "pointer",
  }}
>
  Complete Scoring & Log
</button>
    </div>
  </div>
) : null}

    </div>
  
);
}
