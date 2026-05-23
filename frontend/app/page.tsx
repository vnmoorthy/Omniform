"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Webcam from "react-webcam";
import PoseOverlay, {
  type PoseMetrics,
  type OverlayPlanEntry,
} from "./components/PoseOverlay";

type Phase = "idle" | "recording" | "analyzing" | "result";

interface AnalysisResponse {
  analysisId?: string;
  agentAudioScript: string;
  omniVideoPrompt?: string;
  agentAudioUrl?: string | null;
  overlayPlan?: OverlayPlanEntry[];
  // Veo-ready prompt produced by the Director Agent; the frontend POSTs this
  // to /api/correction-clip to kick off the async reference-clip generation.
  correctionVideoPrompt?: string | null;
  model?: string;
  source?: string;
  latencyMs?: number;
}

interface ResultState extends AnalysisResponse {
  // Local object URL for the captured video — replayed from the client's
  // in-memory blob so the recording never leaves the device's storage.
  videoUrl: string;
  // JPEG data URL of the first frame, captured client-side and handed to Veo
  // as the image-to-video reference so the generated clip animates the same
  // athlete in the same setting.
  referenceImageDataUrl?: string | null;
}

// State of the long-running Veo "correct-form" reference clip.
type VeoState =
  | { status: "idle" }
  | { status: "kicking-off" }
  | { status: "pending"; opId: string; elapsedSec: number; model?: string }
  | { status: "ready"; videoUrl: string; model?: string; elapsedMs: number }
  | { status: "error"; message: string };

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api/analyze";

// Derive the /api/correction-clip URL from the analyze URL so a single
// NEXT_PUBLIC_API_URL env keeps everything pointed at the right backend.
const CORRECTION_CLIP_URL = API_URL.replace(/\/api\/analyze\/?$/, "/api/correction-clip");

// Optional shared token for hackathon demo gating. When set, the backend
// requires the matching X-Demo-Token header on every /api/analyze call.
const DEMO_TOKEN = process.env.NEXT_PUBLIC_DEMO_TOKEN ?? "";

// Stages match the real backend pipeline (Interactions API multimodal pass →
// ADK Director Agent → Cloud TTS). Boundaries roughly match observed Gemini
// 3.5 Flash latencies; the last stage holds until the API actually resolves
// so we never lie about being "done."
const ANALYSIS_STAGES = [
  {
    tick: "Pose",
    title: "Detecting pose landmarks",
    subtitle: "MediaPipe · on-device kinetic chain",
  },
  {
    tick: "Physics",
    title: "Computing force vectors",
    subtitle: "Gemini 3.5 Flash · Interactions API",
  },
  {
    tick: "Coach",
    title: "Composing coaching analysis",
    subtitle: "ADK Director Agent · structured JSON",
  },
  {
    tick: "Voice",
    title: "Synthesizing voice",
    subtitle: "Cloud Text-to-Speech · Chirp 3 HD",
  },
] as const;

// 4-second capture buffer
const RECORD_MS = 4000;

const VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];
const AUDIO_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
];

function pickMime(candidates: string[]): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return candidates.find((c) => MediaRecorder.isTypeSupported(c));
}

// Pull the first decoded frame out of a recorded video blob as a JPEG data
// URL. We pass this to Veo as the image-to-video reference so the generated
// clip animates the SAME athlete in the SAME setting. Capped at ~480px max
// dim and 0.8 quality so the base64 payload comfortably fits the backend's
// 800KB reference-image limit even on portrait-HD camera streams.
async function extractFirstFrameDataUrl(blob: Blob): Promise<string | null> {
  if (typeof document === "undefined") return null;
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const cleanup = () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* noop */
      }
    };
    const fail = () => {
      cleanup();
      resolve(null);
    };
    video.addEventListener("error", fail, { once: true });

    video.addEventListener(
      "loadeddata",
      () => {
        const MAX_DIM = 480;
        const w0 = video.videoWidth || 0;
        const h0 = video.videoHeight || 0;
        if (!w0 || !h0) {
          fail();
          return;
        }
        const scale = Math.min(1, MAX_DIM / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          fail();
          return;
        }
        try {
          ctx.drawImage(video, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          cleanup();
          resolve(dataUrl);
        } catch {
          fail();
        }
      },
      { once: true }
    );

    video.src = objectUrl;
  });
}

export default function Home() {
  const webcamRef = useRef<Webcam>(null);
  const resultVideoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const videoRecorderRef = useRef<MediaRecorder | null>(null);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const videoChunksRef = useRef<Blob[]>([]);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingActiveRef = useRef(false);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest live metrics from on-device pose estimation (grounding source).
  const metricsRef = useRef<PoseMetrics | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<ResultState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(RECORD_MS / 1000);
  const [liveMetrics, setLiveMetrics] = useState<PoseMetrics | null>(null);
  const [capturedMetrics, setCapturedMetrics] = useState<PoseMetrics | null>(null);
  // Tracks whether the user has completed at least one capture so we can
  // hide the first-time-only onboarding tip on subsequent uses.
  const [hasRecordedOnce, setHasRecordedOnce] = useState(false);
  // Streaming-style progress while the multi-agent pipeline runs (~11s).
  // Each stage maps to a real backend phase so the UI tells the truth.
  const [analysisStage, setAnalysisStage] = useState(0);
  // Veo "correct-form" reference clip state. Kicked off after the main
  // /api/analyze response lands; polled every ~5s until ready.
  const [veo, setVeo] = useState<VeoState>({ status: "idle" });
  // window.setInterval returns a number in browser typings.
  const veoPollRef = useRef<number | null>(null);
  const veoTickRef = useRef<number | null>(null);

  // Browser text-to-speech — fallback when Google Cloud TTS isn't configured.
  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    window.speechSynthesis.speak(utterance);
  }, []);

  // Play the coaching: prefer the Google Cloud TTS audio, else browser speech.
  const playCoaching = useCallback(
    (data: { agentAudioScript: string; agentAudioUrl?: string | null }) => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (data.agentAudioUrl) {
        const audio = new Audio(data.agentAudioUrl);
        audioRef.current = audio;
        audio.play().catch(() => speak(data.agentAudioScript));
      } else {
        speak(data.agentAudioScript);
      }
    },
    [speak]
  );

  // Stable accessors / handlers for the pose overlay.
  const getLiveVideo = useCallback(
    () =>
      (webcamRef.current as (Webcam & { video?: HTMLVideoElement | null }) | null)
        ?.video ?? null,
    []
  );
  const getResultVideo = useCallback(() => resultVideoRef.current, []);
  const handleLiveMetrics = useCallback((m: PoseMetrics) => {
    metricsRef.current = m;
    setLiveMetrics(m);
  }, []);

  const uploadAnalysis = useCallback(
    async (
      videoBlob: Blob | null,
      audioBlob: Blob | null,
      metrics: PoseMetrics | null
    ) => {
      try {
        const form = new FormData();
        if (videoBlob && videoBlob.size > 0) {
          form.append("video", videoBlob, "motion.webm");
        }
        if (audioBlob && audioBlob.size > 0) {
          form.append("audio", audioBlob, "voice.webm");
        }
        // Send measured biomechanics so the model is grounded, not guessing.
        if (metrics) {
          form.append("metrics", JSON.stringify(metrics));
        }

        const headers: Record<string, string> = {};
        if (DEMO_TOKEN) headers["X-Demo-Token"] = DEMO_TOKEN;

        const res = await fetch(API_URL, {
          method: "POST",
          body: form,
          headers,
        });
        if (!res.ok) {
          throw new Error(`Analyzer responded with ${res.status}`);
        }

        const data = (await res.json()) as AnalysisResponse;
        // Replay the user's own captured clip — the recording never leaves the
        // browser. Revoke any previous object URL to avoid leaks.
        const videoUrl = videoBlob ? URL.createObjectURL(videoBlob) : "";
        // Extract the first frame on the same blob so Veo can animate the same
        // person + setting via image-to-video. Best-effort; if it fails Veo
        // falls back to text-to-video.
        const referenceImageDataUrl = videoBlob
          ? await extractFirstFrameDataUrl(videoBlob).catch(() => null)
          : null;
        setResult((prev) => {
          if (prev?.videoUrl) URL.revokeObjectURL(prev.videoUrl);
          return { ...data, videoUrl, referenceImageDataUrl };
        });
        setPhase("result");
        playCoaching(data);
      } catch (err) {
        console.error(err);
        setError(
          err instanceof Error
            ? err.message
            : "Could not reach the analyzer. Is the backend running on :8080?"
        );
        setPhase("idle");
      }
    },
    [playCoaching]
  );

  const stopAndCollect = (
    recorder: MediaRecorder | null,
    chunksRef: React.MutableRefObject<Blob[]>,
    mimeType: string
  ): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: mimeType }));
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });

  const stopRecording = useCallback(async () => {
    if (!recordingActiveRef.current) return;
    recordingActiveRef.current = false;
    setHasRecordedOnce(true);

    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }

    setPhase("analyzing");

    // Snapshot the measured biomechanics at the moment of release.
    const measured = metricsRef.current;
    setCapturedMetrics(measured);

    const videoMime =
      videoRecorderRef.current?.mimeType?.split(";")[0] || "video/webm";
    const audioMime =
      audioRecorderRef.current?.mimeType?.split(";")[0] || "audio/webm";

    const [videoBlob, audioBlob] = await Promise.all([
      stopAndCollect(videoRecorderRef.current, videoChunksRef, videoMime),
      stopAndCollect(audioRecorderRef.current, audioChunksRef, audioMime),
    ]);

    await uploadAnalysis(videoBlob, audioBlob, measured);
  }, [uploadAnalysis]);

  const startRecording = useCallback(() => {
    if (recordingActiveRef.current) return;
    setError(null);

    const webcam = webcamRef.current as
      | (Webcam & { stream?: MediaStream })
      | null;
    const stream = webcam?.stream;

    if (!stream) {
      setError("Camera is still warming up — give it a moment and try again.");
      return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (!videoTrack) {
      setError("No camera track available.");
      return;
    }

    videoChunksRef.current = [];
    audioChunksRef.current = [];

    // --- Video recorder (video track only) ---
    const videoStream = new MediaStream([videoTrack]);
    const videoMime = pickMime(VIDEO_MIME_CANDIDATES);
    const videoRecorder = new MediaRecorder(
      videoStream,
      videoMime ? { mimeType: videoMime } : undefined
    );
    videoRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) videoChunksRef.current.push(e.data);
    };
    videoRecorderRef.current = videoRecorder;
    videoRecorder.start();

    // --- Audio recorder (microphone track only) ---
    if (audioTrack) {
      const audioStream = new MediaStream([audioTrack]);
      const audioMime = pickMime(AUDIO_MIME_CANDIDATES);
      const audioRecorder = new MediaRecorder(
        audioStream,
        audioMime ? { mimeType: audioMime } : undefined
      );
      audioRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      audioRecorderRef.current = audioRecorder;
      audioRecorder.start();
    } else {
      audioRecorderRef.current = null;
    }

    recordingActiveRef.current = true;
    setPhase("recording");
    setCountdown(RECORD_MS / 1000);

    // Auto-stop once the 4-second buffer is full.
    autoStopRef.current = setTimeout(() => {
      void stopRecording();
    }, RECORD_MS);
  }, [stopRecording]);

  // Countdown ticker while recording
  useEffect(() => {
    if (phase !== "recording") return;
    const id = setInterval(() => {
      setCountdown((c) => Math.max(0, +(c - 0.1).toFixed(1)));
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  // Stage ticker while analyzing — advances through real backend phases.
  // 0 → 1 → 2 → 3 stays put until the API resolves.
  useEffect(() => {
    if (phase !== "analyzing") {
      setAnalysisStage(0);
      return;
    }
    const advance = [2700, 5400, 8100]; // ms boundaries between stages
    const timers = advance.map((ms, i) =>
      setTimeout(() => setAnalysisStage(i + 1), ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [phase]);

  // ---- Veo "correct-form" reference clip orchestration --------------------
  // Cleared on unmount / reset. Both intervals get cleared together.
  const stopVeoPolling = useCallback(() => {
    if (veoPollRef.current) {
      clearInterval(veoPollRef.current);
      veoPollRef.current = null;
    }
    if (veoTickRef.current) {
      clearInterval(veoTickRef.current);
      veoTickRef.current = null;
    }
  }, []);

  // Whenever a result lands with a non-empty correctionVideoPrompt, kick off
  // Veo and start polling. The frontend never sees the raw Veo operation
  // name — backend hands us a short opId.
  useEffect(() => {
    if (!result?.correctionVideoPrompt) return;
    if (veo.status !== "idle") return;

    let cancelled = false;
    setVeo({ status: "kicking-off" });

    (async () => {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (DEMO_TOKEN) headers["X-Demo-Token"] = DEMO_TOKEN;
        // Already guarded by the useEffect's early-return above.
        const promptText = result.correctionVideoPrompt as string;
        const body: { prompt: string; referenceImage?: string } = {
          prompt: promptText,
        };
        // Pass the first-frame reference for image-to-video when we have one.
        if (result.referenceImageDataUrl) {
          body.referenceImage = result.referenceImageDataUrl;
        }
        const res = await fetch(CORRECTION_CLIP_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        if (cancelled) return;
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`Veo kickoff ${res.status}: ${detail.slice(0, 200)}`);
        }
        const data = (await res.json()) as { opId: string; model?: string };
        if (cancelled) return;

        const startedAt = Date.now();
        setVeo({
          status: "pending",
          opId: data.opId,
          elapsedSec: 0,
          model: data.model,
        });

        // Live elapsed-time ticker (cheap UI affordance while we wait).
        veoTickRef.current = window.setInterval(() => {
          setVeo((prev) =>
            prev.status === "pending"
              ? { ...prev, elapsedSec: Math.floor((Date.now() - startedAt) / 1000) }
              : prev
          );
        }, 1000);

        // Status poll — every 5s.
        const pollOnce = async () => {
          try {
            const pollUrl = `${CORRECTION_CLIP_URL}?id=${encodeURIComponent(data.opId)}`;
            const pollHeaders: Record<string, string> = {};
            if (DEMO_TOKEN) pollHeaders["X-Demo-Token"] = DEMO_TOKEN;
            const pr = await fetch(pollUrl, { headers: pollHeaders });
            if (cancelled) return;
            const pd = await pr.json();
            if (pd.status === "done" && pd.videoUrl) {
              stopVeoPolling();
              setVeo({
                status: "ready",
                videoUrl: pd.videoUrl,
                model: pd.model,
                elapsedMs: pd.elapsedMs ?? 0,
              });
            } else if (pd.status === "error") {
              stopVeoPolling();
              setVeo({
                status: "error",
                message: pd.error || "Veo generation failed",
              });
            }
            // status === "pending" → ticker keeps running, next poll fires
          } catch (err) {
            if (cancelled) return;
            // Transient network errors: keep polling, don't blow up the UI.
            console.warn("[Veo] poll error", err);
          }
        };
        veoPollRef.current = window.setInterval(pollOnce, 5000);
        // First poll immediately so we don't wait the full 5s for nothing.
        void pollOnce();
      } catch (err) {
        if (cancelled) return;
        stopVeoPolling();
        setVeo({
          status: "error",
          message: err instanceof Error ? err.message : "Veo kickoff failed",
        });
      }
    })();

    return () => {
      cancelled = true;
      stopVeoPolling();
    };
  }, [result, veo.status, stopVeoPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      stopVeoPolling();
    };
  }, [stopVeoPolling]);

  // Restore the "seen onboarding before" flag from localStorage so returning
  // users don't see the first-time tip again.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("omniform.hasRecordedOnce") === "1") {
      setHasRecordedOnce(true);
    }
  }, []);
  useEffect(() => {
    if (hasRecordedOnce && typeof window !== "undefined") {
      window.localStorage.setItem("omniform.hasRecordedOnce", "1");
    }
  }, [hasRecordedOnce]);

  const reset = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setResult((prev) => {
      if (prev?.videoUrl) URL.revokeObjectURL(prev.videoUrl);
      return null;
    });
    setError(null);
    setCapturedMetrics(null);
    metricsRef.current = null;
    stopVeoPolling();
    setVeo({ status: "idle" });
    setPhase("idle");
  }, [stopVeoPolling]);

  const isRecording = phase === "recording";
  const isAnalyzing = phase === "analyzing";
  const showResult = phase === "result" && Boolean(result);
  const liveOverlayActive = !showResult && phase !== "analyzing";

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-omni-bg">
      {/* Live camera layer */}
      {!showResult && (
        <>
          <Webcam
            ref={webcamRef}
            audio
            muted
            mirrored
            videoConstraints={{ facingMode: "user" }}
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* Real-time skeleton: proof the agent literally "sees" you */}
          <PoseOverlay
            getVideo={getLiveVideo}
            active={liveOverlayActive}
            mirror
            onMetrics={handleLiveMetrics}
          />
        </>
      )}

      {/* Cinematic vignette */}
      {!showResult && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/75" />
      )}

      {/* Header */}
      {!showResult && (
        <div className="pointer-events-none absolute left-0 right-0 top-0 flex flex-col items-center pt-8">
          <h1 className="text-sm font-semibold uppercase tracking-[0.4em] text-omni-accent">
            OmniForm
          </h1>
          <p className="mt-1 text-[0.65rem] uppercase tracking-[0.3em] text-white/50">
            Ambient Biomechanics Lab
          </p>
        </div>
      )}

      {/* Live measured-angle HUD */}
      {!showResult && liveMetrics && (liveMetrics.leftKneeAngle != null || liveMetrics.rightKneeAngle != null) && (
        <div className="pointer-events-none absolute right-4 top-20 z-20 rounded-lg border border-white/10 bg-black/45 px-3 py-2 text-right backdrop-blur">
          <p className="text-[0.6rem] uppercase tracking-[0.25em] text-omni-accent">
            Measured
          </p>
          {liveMetrics.leftKneeAngle != null && (
            <p className="text-xs text-white/80">
              L knee {liveMetrics.leftKneeAngle}&deg;
            </p>
          )}
          {liveMetrics.rightKneeAngle != null && (
            <p className="text-xs text-white/80">
              R knee {liveMetrics.rightKneeAngle}&deg;
            </p>
          )}
          {liveMetrics.peakAngularVelocity != null && (
            <p className="text-xs text-white/80">
              peak {liveMetrics.peakAngularVelocity}&deg;/s
            </p>
          )}
        </div>
      )}

      {/* Recording indicator */}
      {isRecording && (
        <div className="absolute left-0 right-0 top-24 z-20 flex justify-center">
          <div className="flex items-center gap-2 rounded-full bg-red-500/20 px-4 py-1.5 backdrop-blur">
            <span className="h-2.5 w-2.5 animate-ping rounded-full bg-red-500" />
            <span className="text-sm font-medium text-red-100">
              Capturing motion · {countdown.toFixed(1)}s
            </span>
          </div>
        </div>
      )}

      {/* Error toast — dismissible */}
      {error && !isAnalyzing && (
        <div className="absolute left-1/2 top-1/3 z-40 flex w-[90%] max-w-md -translate-x-1/2 items-start gap-3 rounded-xl border border-red-400/40 bg-red-950/85 px-5 py-3 text-left text-sm text-red-100 shadow-2xl backdrop-blur">
          <span className="mt-0.5 text-base leading-none">!</span>
          <p className="flex-1">{error}</p>
          <button
            type="button"
            onClick={() => setError(null)}
            className="-mr-1 ml-1 rounded-full px-2 py-0.5 text-base leading-none text-red-200/80 transition hover:bg-red-400/10 hover:text-red-50"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* First-time onboarding hint — shown until the user records once. */}
      {!showResult && !isRecording && !isAnalyzing && !hasRecordedOnce && !error && (
        <div className="pointer-events-none absolute left-1/2 top-1/3 z-20 w-[90%] max-w-md -translate-x-1/2 rounded-2xl border border-white/10 bg-black/40 px-5 py-4 text-center text-sm text-white/85 backdrop-blur-md">
          <p className="mb-1 font-semibold text-omni-accent">Welcome to OmniForm</p>
          <p className="text-white/70">
            Stand in frame so the camera can see your full body, then{" "}
            <span className="text-white">hold the capture button</span> and perform
            your motion. Release to get instant kinematic coaching.
          </p>
        </div>
      )}

      {/* "Position yourself in frame" hint — only shown after onboarding,
          while we have a camera feed but no pose detection yet. */}
      {!showResult &&
        !isRecording &&
        !isAnalyzing &&
        hasRecordedOnce &&
        !error &&
        !liveMetrics && (
          <div className="pointer-events-none absolute left-1/2 top-1/3 z-10 w-[90%] max-w-sm -translate-x-1/2 rounded-xl border border-white/10 bg-black/30 px-4 py-2 text-center text-xs text-white/65 backdrop-blur">
            Step into frame so the pose estimator can lock on…
          </div>
        )}

      {/* Loading overlay — stages map to the real ADK pipeline phases. */}
      {isAnalyzing && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-black/85 backdrop-blur-md">
          <div className="swarm-ring h-20 w-20 animate-swarm-spin rounded-full" />
          <div className="w-[80%] max-w-sm text-center">
            <p className="bg-gradient-to-r from-omni-accent to-omni-accent2 bg-clip-text text-lg font-semibold text-transparent">
              {ANALYSIS_STAGES[analysisStage]?.title ?? ANALYSIS_STAGES[3].title}
            </p>
            <p className="mt-2 text-[0.65rem] uppercase tracking-[0.3em] text-white/40">
              {ANALYSIS_STAGES[analysisStage]?.subtitle ?? ANALYSIS_STAGES[3].subtitle}
            </p>
            <div className="mx-auto mt-5 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-omni-accent to-omni-accent2 transition-all duration-700"
                style={{
                  width: `${((analysisStage + 1) / ANALYSIS_STAGES.length) * 100}%`,
                }}
              />
            </div>
            <ol className="mt-4 flex justify-between text-[0.55rem] uppercase tracking-[0.2em] text-white/30">
              {ANALYSIS_STAGES.map((stage, i) => (
                <li
                  key={stage.title}
                  className={
                    i <= analysisStage ? "text-omni-accent" : "text-white/30"
                  }
                >
                  {stage.tick}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      {/* Result layer */}
      {showResult && result && (
        <div className="absolute inset-0 z-30 flex flex-col bg-omni-bg">
          <video
            ref={resultVideoRef}
            key={result.videoUrl}
            src={result.videoUrl}
            autoPlay
            loop
            muted
            playsInline
            className="absolute inset-0 h-full w-full object-cover"
          />
          {/* Glowing vector overlay + server-computed treatment markers */}
          <PoseOverlay
            getVideo={getResultVideo}
            active
            mirror={false}
            overlayPlan={result.overlayPlan}
          />

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/90 via-black/10 to-black/50" />

          <div className="relative z-10 mt-auto flex flex-col gap-4 p-6 pb-10">
            <div className="rounded-2xl border border-white/10 bg-black/50 p-5 backdrop-blur">
              <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-omni-accent">
                Coaching Feedback
              </p>
              <p className="text-base leading-relaxed text-white/90">
                {result.agentAudioScript}
              </p>

              {capturedMetrics &&
                (capturedMetrics.leftKneeAngle != null ||
                  capturedMetrics.rightKneeAngle != null ||
                  capturedMetrics.peakAngularVelocity != null) && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t border-white/10 pt-3">
                    {capturedMetrics.leftKneeAngle != null && (
                      <span className="rounded-full bg-omni-accent/15 px-3 py-1 text-xs text-omni-accent">
                        L knee {capturedMetrics.leftKneeAngle}&deg;
                      </span>
                    )}
                    {capturedMetrics.rightKneeAngle != null && (
                      <span className="rounded-full bg-omni-accent/15 px-3 py-1 text-xs text-omni-accent">
                        R knee {capturedMetrics.rightKneeAngle}&deg;
                      </span>
                    )}
                    {capturedMetrics.peakAngularVelocity != null && (
                      <span className="rounded-full bg-omni-accent2/15 px-3 py-1 text-xs text-omni-accent2">
                        peak {capturedMetrics.peakAngularVelocity}&deg;/s
                      </span>
                    )}
                    <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/40">
                      measured on-device
                    </span>
                  </div>
                )}

              {result.omniVideoPrompt && (
                <p className="mt-3 border-t border-white/10 pt-3 text-xs italic text-white/40">
                  Overlay plan: {result.omniVideoPrompt}
                </p>
              )}

              {/* Pipeline footer — model, source, latency, and the session UID
                  that ties this analysis to the BigQuery row. */}
              {(result.analysisId || result.model || result.latencyMs != null) && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-white/10 pt-3 text-[0.6rem] uppercase tracking-[0.18em] text-white/35">
                  {result.model && <span>{result.model}</span>}
                  {result.source && (
                    <>
                      <span className="text-white/15">·</span>
                      <span>{result.source.replace(/-/g, " ")}</span>
                    </>
                  )}
                  {result.latencyMs != null && (
                    <>
                      <span className="text-white/15">·</span>
                      <span>{(result.latencyMs / 1000).toFixed(1)}s</span>
                    </>
                  )}
                  {result.analysisId && (
                    <>
                      <span className="text-white/15">·</span>
                      <span className="font-mono normal-case tracking-normal text-white/30">
                        UID {result.analysisId.slice(0, 8)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Veo "correct-form" reference clip tile. Auto-fires after the
                main result lands; embeds the mp4 when ready. */}
            {result.correctionVideoPrompt && veo.status !== "idle" && (
              <div className="rounded-2xl border border-white/10 bg-black/55 p-4 backdrop-blur">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[0.65rem] font-semibold uppercase tracking-[0.3em] text-omni-accent2">
                    Correct-Form Reference
                  </p>
                  <p className="text-[0.55rem] uppercase tracking-[0.2em] text-white/35">
                    {veo.status === "ready" || veo.status === "pending"
                      ? `Veo · ${("model" in veo && veo.model) || "video"}`
                      : "Veo"}
                  </p>
                </div>

                {veo.status === "kicking-off" && (
                  <p className="text-xs text-white/55">Requesting reference clip from Google Veo…</p>
                )}

                {veo.status === "pending" && (
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 shrink-0 animate-spin rounded-full border-2 border-omni-accent2/30 border-t-omni-accent2" />
                    <div className="flex-1">
                      <p className="text-xs text-white/75">
                        Generating reference clip of the corrected technique…
                      </p>
                      <p className="mt-0.5 text-[0.6rem] uppercase tracking-[0.2em] text-white/35">
                        Veo typically takes 20–90s · {veo.elapsedSec}s elapsed
                      </p>
                    </div>
                  </div>
                )}

                {veo.status === "ready" && (
                  <>
                    <video
                      src={veo.videoUrl}
                      controls
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="aspect-[9/16] w-full rounded-lg border border-white/10 bg-black/60 object-cover"
                    />
                    <p className="mt-2 text-[0.6rem] uppercase tracking-[0.2em] text-white/35">
                      Generated in {(veo.elapsedMs / 1000).toFixed(1)}s · play side-by-side with your clip above
                    </p>
                  </>
                )}

                {veo.status === "error" && (
                  <p className="text-xs text-white/55">
                    Reference clip unavailable: {veo.message}
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => playCoaching(result)}
                className="rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20"
              >
                Replay Audio
              </button>
              <button
                onClick={reset}
                className="rounded-full bg-gradient-to-r from-omni-accent to-omni-accent2 px-6 py-2.5 text-sm font-semibold text-black transition hover:opacity-90"
              >
                Analyze Again
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Capture button */}
      {!showResult && (
        <div className="absolute bottom-12 left-0 right-0 z-30 flex flex-col items-center gap-3">
          <button
            type="button"
            disabled={isAnalyzing}
            onContextMenu={(e) => e.preventDefault()}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              startRecording();
            }}
            onPointerUp={() => void stopRecording()}
            onPointerCancel={() => void stopRecording()}
            className={[
              "h-24 w-24 touch-none select-none rounded-full",
              "bg-gradient-to-br from-omni-accent to-omni-accent2",
              "text-sm font-bold uppercase leading-tight tracking-wide text-black",
              "whitespace-pre-line transition-transform duration-150",
              isRecording ? "scale-110" : "scale-100",
              "animate-pulse-glow",
              "disabled:animate-none disabled:opacity-40",
            ].join(" ")}
          >
            {isRecording ? "Recording" : "Analyze\nMotion"}
          </button>
          <p className="text-[0.65rem] uppercase tracking-[0.25em] text-white/40">
            {isAnalyzing ? "Processing…" : "Hold to capture · release to analyze"}
          </p>
        </div>
      )}
    </main>
  );
}
