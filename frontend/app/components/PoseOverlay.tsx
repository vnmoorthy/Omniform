"use client";

import { useEffect, useRef } from "react";
import type { NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";

export interface PoseMetrics {
  leftKneeAngle: number | null;
  rightKneeAngle: number | null;
  peakAngularVelocity: number | null; // deg/s
}

// Server-computed overlay directives (Director Agent output). Each entry
// targets a MediaPipe BlazePose landmark by name and tells the canvas how
// to decorate it — the frontend never invents joints, it only draws what
// the pipeline approved.
export type OverlayJoint =
  | "leftHip"
  | "rightHip"
  | "leftKnee"
  | "rightKnee"
  | "leftAnkle"
  | "rightAnkle";
export type OverlayTreatment = "highlight" | "warning" | "vector";
export type OverlayColor = "cyan" | "magenta" | "yellow";

export interface OverlayPlanEntry {
  joint: OverlayJoint;
  treatment: OverlayTreatment;
  color: OverlayColor;
  label?: string;
  // Optional corrective "ghost path": direction the joint should move, as a
  // fraction of frame size. Rendered as an animated arrow + target anchored to
  // the detected joint, so it shows the correct move without a generated video.
  correction?: { dx: number; dy: number; note?: string };
}

const JOINT_INDEX: Record<OverlayJoint, number> = {
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

const OVERLAY_COLORS: Record<OverlayColor, string> = {
  cyan: "rgba(67,229,255,1)",
  magenta: "rgba(255,67,229,1)",
  yellow: "rgba(255,229,67,1)",
};

interface PoseOverlayProps {
  /** Returns the <video> element to read frames from (camera or playback). */
  getVideo: () => HTMLVideoElement | null;
  /** Whether the overlay should be running. */
  active: boolean;
  /** Mirror horizontally to match a mirrored camera preview. */
  mirror?: boolean;
  /** Receives real, computed biomechanics metrics (throttled). */
  onMetrics?: (m: PoseMetrics) => void;
  /**
   * Server-computed render directives drawn on top of the detected skeleton.
   * Used on the result video to materialize Director Agent's overlay plan.
   */
  overlayPlan?: OverlayPlanEntry[];
}

const TASKS_VISION_VERSION = "0.10.35";
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// Lazily initialised, shared across mounts so we only download the model once.
let landmarkerPromise: Promise<PoseLandmarker> | null = null;
let poseConnections: Array<{ start: number; end: number }> = [];

async function getLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const { PoseLandmarker, FilesetResolver } = vision;
      poseConnections =
        (PoseLandmarker.POSE_CONNECTIONS as Array<{ start: number; end: number }>) ||
        [];
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      });
    })();
  }
  return landmarkerPromise;
}

/** Interior angle (degrees) at vertex `b` formed by points a-b-c. */
function angleAt(
  a: NormalizedLandmark | undefined,
  b: NormalizedLandmark | undefined,
  c: NormalizedLandmark | undefined,
  vw: number,
  vh: number
): number | null {
  if (!a || !b || !c) return null;
  const v1x = (a.x - b.x) * vw;
  const v1y = (a.y - b.y) * vh;
  const v2x = (c.x - b.x) * vw;
  const v2y = (c.y - b.y) * vh;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 === 0 || m2 === 0) return null;
  let cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
  cos = Math.max(-1, Math.min(1, cos));
  return (Math.acos(cos) * 180) / Math.PI;
}

export default function PoseOverlay({
  getVideo,
  active,
  mirror = false,
  onMetrics,
  overlayPlan,
}: PoseOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastTsRef = useRef(-1);
  const prevAngleRef = useRef<{ t: number; left: number | null; right: number | null }>(
    { t: 0, left: null, right: null }
  );
  const peakRef = useRef(0);
  const lastReportRef = useRef(0);

  // Ref-sync the overlay plan so the rAF loop reads the latest value without
  // tearing down + restarting MediaPipe every time the plan changes.
  const planRef = useRef<OverlayPlanEntry[]>(overlayPlan ?? []);
  useEffect(() => {
    planRef.current = overlayPlan ?? [];
  }, [overlayPlan]);

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let rafId: number | null = null;
    let landmarker: PoseLandmarker | null = null;

    // Reset per-session accumulators.
    peakRef.current = 0;
    prevAngleRef.current = { t: 0, left: null, right: null };

    const loop = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(loop);

      const video = getVideo();
      const canvas = canvasRef.current;
      if (!video || !canvas || !landmarker) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(rect.width * dpr);
      const H = Math.round(rect.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // MediaPipe requires strictly increasing timestamps.
      let ts = performance.now();
      if (ts <= lastTsRef.current) ts = lastTsRef.current + 1;
      lastTsRef.current = ts;

      let result: { landmarks?: NormalizedLandmark[][] } | undefined;
      try {
        result = landmarker.detectForVideo(video, ts);
      } catch {
        // Cross-origin / GPU hiccup — skip this frame, keep the video playing.
        return;
      }

      ctx.clearRect(0, 0, W, H);
      const lms = result?.landmarks?.[0];
      if (!lms || lms.length === 0) return;

      // Map normalised landmarks through an object-cover transform.
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.max(W / vw, H / vh);
      const offX = (W - vw * scale) / 2;
      const offY = (H - vh * scale) / 2;
      const mapX = (x: number) => {
        const px = offX + x * vw * scale;
        return mirror ? W - px : px;
      };
      const mapY = (y: number) => offY + y * vh * scale;
      const visible = (p?: NormalizedLandmark) => (p?.visibility ?? 1) >= 0.3;

      // Glowing vector lines between joints.
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(2, 3 * dpr);
      ctx.shadowBlur = 14 * dpr;
      ctx.shadowColor = "rgba(67,229,255,0.9)";
      ctx.strokeStyle = "rgba(67,229,255,0.95)";
      ctx.beginPath();
      for (const c of poseConnections) {
        const a = lms[c.start];
        const b = lms[c.end];
        if (!visible(a) || !visible(b)) continue;
        ctx.moveTo(mapX(a.x), mapY(a.y));
        ctx.lineTo(mapX(b.x), mapY(b.y));
      }
      ctx.stroke();

      // Joint nodes.
      ctx.shadowBlur = 10 * dpr;
      ctx.fillStyle = "rgba(56,249,215,0.95)";
      for (const p of lms) {
        if (!visible(p)) continue;
        ctx.beginPath();
        ctx.arc(mapX(p.x), mapY(p.y), Math.max(2.5, 3.5 * dpr), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // --- Real, computed biomechanics (grounding) ---
      const leftKnee = angleAt(lms[23], lms[25], lms[27], vw, vh);
      const rightKnee = angleAt(lms[24], lms[26], lms[28], vw, vh);

      const prev = prevAngleRef.current;
      if (prev.t > 0) {
        const dt = (ts - prev.t) / 1000;
        if (dt > 0) {
          const pairs: Array<[number | null, number | null]> = [
            [leftKnee, prev.left],
            [rightKnee, prev.right],
          ];
          for (const [cur, pr] of pairs) {
            if (cur != null && pr != null) {
              const angularVelocity = Math.abs(cur - pr) / dt;
              if (isFinite(angularVelocity) && angularVelocity < 3000) {
                peakRef.current = Math.max(peakRef.current, angularVelocity);
              }
            }
          }
        }
      }
      prevAngleRef.current = { t: ts, left: leftKnee, right: rightKnee };

      if (onMetrics && ts - lastReportRef.current > 200) {
        lastReportRef.current = ts;
        onMetrics({
          leftKneeAngle: leftKnee != null ? Math.round(leftKnee) : null,
          rightKneeAngle: rightKnee != null ? Math.round(rightKnee) : null,
          peakAngularVelocity:
            peakRef.current > 0 ? Math.round(peakRef.current) : null,
        });
      }

      // --- Server-computed overlay plan ---
      // Drawn at the detected joint position every frame so it tracks motion.
      const plan = planRef.current;
      for (const entry of plan) {
        const idx = JOINT_INDEX[entry.joint];
        const lm = idx == null ? undefined : lms[idx];
        if (!lm || !visible(lm)) continue;
        const x = mapX(lm.x);
        const y = mapY(lm.y);
        const color = OVERLAY_COLORS[entry.color];

        ctx.save();
        ctx.shadowBlur = 18 * dpr;
        ctx.shadowColor = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2.5, 3.5 * dpr);

        if (entry.treatment === "highlight") {
          ctx.beginPath();
          ctx.arc(x, y, 14 * dpr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(x, y, 7 * dpr, 0, Math.PI * 2);
          ctx.stroke();
        } else if (entry.treatment === "warning") {
          const s = 13 * dpr;
          ctx.beginPath();
          ctx.moveTo(x, y - s);
          ctx.lineTo(x - s, y + s);
          ctx.lineTo(x + s, y + s);
          ctx.closePath();
          ctx.stroke();
          ctx.lineWidth = Math.max(2, 3 * dpr);
          ctx.beginPath();
          ctx.moveTo(x, y - s * 0.4);
          ctx.lineTo(x, y + s * 0.2);
          ctx.stroke();
        } else {
          // vector — short arrow pointing forward (down the limb)
          const dy = 26 * dpr;
          const head = 7 * dpr;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + dy);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x, y + dy);
          ctx.lineTo(x - head, y + dy - head);
          ctx.moveTo(x, y + dy);
          ctx.lineTo(x + head, y + dy - head);
          ctx.stroke();
        }

        if (entry.label) {
          ctx.shadowBlur = 0;
          ctx.fillStyle = color;
          ctx.font = `600 ${Math.max(11, 12 * dpr)}px system-ui, -apple-system, sans-serif`;
          ctx.textAlign = "left";
          ctx.fillText(entry.label, x + 18 * dpr, y + 4 * dpr);
        }

        // Corrective "ghost path": animated dashed arrow from the detected
        // joint toward where it should move. Anchored to the real landmark, so
        // it shows the correct move without a generated video or guessed pixels.
        if (entry.correction) {
          const cdx = Math.max(-0.2, Math.min(0.2, entry.correction.dx || 0));
          const cdy = Math.max(-0.2, Math.min(0.2, entry.correction.dy || 0));
          const tx = x + cdx * vw * scale;
          const ty = y + cdy * vh * scale;
          const guide = "rgba(93,255,155,1)";
          ctx.shadowBlur = 12 * dpr;
          ctx.shadowColor = guide;
          ctx.strokeStyle = guide;
          ctx.fillStyle = guide;
          ctx.lineWidth = Math.max(2, 2.6 * dpr);
          ctx.setLineDash([7 * dpr, 6 * dpr]);
          ctx.lineDashOffset = -((ts / 28) % (13 * dpr));
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          ctx.setLineDash([]);
          const ang = Math.atan2(ty - y, tx - x);
          const h = 8 * dpr;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - h * Math.cos(ang - 0.5), ty - h * Math.sin(ang - 0.5));
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - h * Math.cos(ang + 0.5), ty - h * Math.sin(ang + 0.5));
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(tx, ty, 6 * dpr, 0, Math.PI * 2);
          ctx.stroke();
          if (entry.correction.note) {
            ctx.shadowBlur = 0;
            ctx.font = `500 ${Math.max(11, 11 * dpr)}px system-ui, -apple-system, sans-serif`;
            ctx.textAlign = "left";
            ctx.fillText(entry.correction.note, tx + 9 * dpr, ty + 3 * dpr);
          }
        }

        ctx.restore();
      }
    };

    getLandmarker()
      .then((lm) => {
        if (cancelled) return;
        landmarker = lm;
        loop();
      })
      .catch((err) => {
        console.warn("[OmniForm] Pose model unavailable, overlay disabled:", err);
      });

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [active, mirror, getVideo, onMetrics]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
