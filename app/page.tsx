"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type TimerStatus = "ready" | "running" | "paused" | "complete";

type Segment = {
  id: string;
  duration: number;
  power: number;
  extension?: boolean;
};

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

const EXTRA_WARMUP_SECONDS = 5 * 60;

function cloneSegments(segments: Segment[]) {
  return segments.map((segment) => ({ ...segment }));
}

function formatClock(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds,
    ).padStart(2, "0")}`;
  }
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatDuration(seconds: number) {
  return formatClock(seconds * 1000);
}

function formatPower(power: number) {
  return Number.isInteger(power) ? String(power) : power.toFixed(1);
}

function parseDelimitedLine(line: string, delimiter: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }

  values.push(value.trim());
  return values;
}

function parseProtocolCsv(text: string): Segment[] {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    throw new Error("The CSV needs a header and at least one data row.");
  }

  const delimiters = [",", ";", "\t"];
  const delimiter = delimiters.reduce((best, candidate) =>
    lines[0].split(candidate).length > lines[0].split(best).length
      ? candidate
      : best,
  );
  const headers = parseDelimitedLine(lines[0], delimiter).map((header) =>
    header.trim().toLowerCase(),
  );
  const timeIndex = headers.indexOf("time_s");
  const powerIndex = headers.indexOf("power_w");

  if (timeIndex < 0 || powerIndex < 0) {
    throw new Error("The CSV must contain time_s and power_W columns.");
  }

  const rows = lines.slice(1).map((line, rowIndex) => {
    const values = parseDelimitedLine(line, delimiter);
    const time = Number(values[timeIndex]);
    const power = Number(values[powerIndex]);
    if (!Number.isFinite(time) || !Number.isFinite(power)) {
      throw new Error(`Row ${rowIndex + 2} contains a nonnumeric time or power.`);
    }
    if (!Number.isInteger(time) || time !== rowIndex) {
      throw new Error(
        `time_s must run continuously from 0. Row ${rowIndex + 2} contains ${values[timeIndex]}.`,
      );
    }
    if (power < 0) {
      throw new Error(`Row ${rowIndex + 2} contains a negative power.`);
    }
    return power;
  });

  const segments: Segment[] = [];
  rows.forEach((power) => {
    const previous = segments.at(-1);
    if (previous && previous.power === power) {
      previous.duration += 1;
      return;
    }
    segments.push({
      id: `csv-${segments.length + 1}-${crypto.randomUUID()}`,
      duration: 1,
      power,
    });
  });

  return segments;
}

function detectMainSetStart(segments: Segment[]) {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.power <= 100 || segment.duration > 30) continue;

    const remaining = segments.slice(index);
    const shortEfforts = remaining.filter(
      (candidate) => candidate.power > 100 && candidate.duration <= 30,
    ).length;
    const shortRecoveries = remaining.filter(
      (candidate) => candidate.power <= 50 && candidate.duration <= 30,
    ).length;
    if (shortEfforts >= 3 && shortRecoveries >= 2) return index;
  }
  return segments.length;
}

function segmentPhase(
  segment: Segment,
  index: number,
  mainSetStart: number,
  segments: Segment[],
) {
  if (segment.extension) return "Extra warmup";
  if (index >= mainSetStart) {
    if (segment.power > 100) {
      const effortNumber = segments
        .slice(mainSetStart, index + 1)
        .filter((candidate) => candidate.power > 100).length;
      const totalEfforts = segments
        .slice(mainSetStart)
        .filter((candidate) => candidate.power > 100).length;
      return `Tabata effort ${effortNumber} of ${totalEfforts}`;
    }
    return "Recovery";
  }
  if (segment.power === 1 && segment.duration <= 10) return "Sprint marker";
  if (segment.power === 0) return "Pace practice";
  if (segment.power <= 50) return "Easy spin";
  return "Warmup";
}

function powerZone(segment: Segment, index: number, mainSetStart: number) {
  if (segment.extension) return "extension";
  if (index >= mainSetStart && segment.power > 100) return "effort";
  if (segment.power === 0) return "recovery";
  if (segment.power === 1 && segment.duration <= 10) return "marker";
  if (segment.power <= 50) return "easy";
  return "steady";
}

function nicePowerStep(maxPower: number) {
  const roughStep = Math.max(1, maxPower / 5);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function ProtocolLineChart({
  segments,
  currentIndex,
  remainingMs,
  status,
  mainSetStart,
}: {
  segments: Segment[];
  currentIndex: number;
  remainingMs: number;
  status: TimerStatus;
  mainSetStart: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || segments.length === 0) return;

    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * pixelRatio);
      canvas.height = Math.round(bounds.height * pixelRatio);

      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, bounds.width, bounds.height);

      const styles = getComputedStyle(canvas);
      const cssColor = (name: string, fallback: string) =>
        styles.getPropertyValue(name).trim() || fallback;
      const colors: Record<string, string> = {
        effort: cssColor("--red", "#ff6d77"),
        recovery: cssColor("--blue", "#74c7ff"),
        marker: cssColor("--amber", "#ffc35a"),
        easy: cssColor("--accent", "#79e3b2"),
        extension: cssColor("--accent", "#79e3b2"),
        steady: cssColor("--violet", "#bb9bff"),
      };
      const textColor = cssColor("--text", "#f7fbff");
      const mutedColor = cssColor("--muted", "#aebbc9");
      const gridColor = "rgba(255, 255, 255, 0.1)";

      const width = bounds.width;
      const height = bounds.height;
      const padding = {
        top: 18,
        right: 18,
        bottom: 44,
        left: width < 460 ? 48 : 58,
      };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      const plotBottom = padding.top + plotHeight;
      const totalSeconds = segments.reduce((sum, segment) => sum + segment.duration, 0);
      const highestPower = Math.max(100, ...segments.map((segment) => segment.power));
      const powerStep = nicePowerStep(highestPower);
      const maxPower = Math.ceil(highestPower / powerStep) * powerStep;
      const xForTime = (seconds: number) =>
        padding.left + (seconds / totalSeconds) * plotWidth;
      const yForPower = (power: number) =>
        padding.top + plotHeight - (power / maxPower) * plotHeight;

      context.font = "12px Inter, ui-sans-serif, system-ui, sans-serif";
      context.lineWidth = 1;
      context.textBaseline = "middle";

      for (let power = 0; power <= maxPower; power += powerStep) {
        const y = yForPower(power);
        context.strokeStyle = gridColor;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();

        context.fillStyle = mutedColor;
        context.textAlign = "right";
        context.fillText(`${power} W`, padding.left - 9, y);
      }

      const xTickCount = width < 520 ? 4 : 6;
      for (let index = 0; index <= xTickCount; index += 1) {
        const seconds = (totalSeconds * index) / xTickCount;
        const x = xForTime(seconds);
        context.strokeStyle = gridColor;
        context.beginPath();
        context.moveTo(x, padding.top);
        context.lineTo(x, plotBottom);
        context.stroke();

        context.fillStyle = mutedColor;
        context.textAlign = index === 0 ? "left" : index === xTickCount ? "right" : "center";
        context.textBaseline = "top";
        context.fillText(formatDuration(seconds), x, plotBottom + 10);
      }

      let startsAt = 0;
      segments.forEach((segment, index) => {
        const endsAt = startsAt + segment.duration;
        const x1 = xForTime(startsAt);
        const x2 = xForTime(endsAt);
        const y = yForPower(segment.power);
        const zone = powerZone(segment, index, mainSetStart);
        const color = colors[zone];

        context.globalAlpha = index === currentIndex && status !== "complete" ? 0.16 : 0.08;
        context.fillStyle = color;
        context.fillRect(x1, y, Math.max(1, x2 - x1), plotBottom - y);

        context.globalAlpha = 1;
        context.strokeStyle = color;
        context.lineWidth = index === currentIndex && status !== "complete" ? 5 : 3;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(x1, y);
        context.lineTo(x2, y);
        context.stroke();

        const nextSegment = segments[index + 1];
        if (nextSegment) {
          context.strokeStyle = colors[powerZone(nextSegment, index + 1, mainSetStart)];
          context.lineWidth = 2;
          context.beginPath();
          context.moveTo(x2, y);
          context.lineTo(x2, yForPower(nextSegment.power));
          context.stroke();
        }

        startsAt = endsAt;
      });

      const secondsBeforeCurrent = segments
        .slice(0, currentIndex)
        .reduce((sum, segment) => sum + segment.duration, 0);
      const currentSegment = segments[currentIndex] ?? segments.at(-1);
      const elapsedInCurrent = currentSegment
        ? currentSegment.duration - remainingMs / 1000
        : 0;
      const elapsedSeconds = status === "complete"
        ? totalSeconds
        : Math.max(0, Math.min(totalSeconds, secondsBeforeCurrent + elapsedInCurrent));
      const markerX = xForTime(elapsedSeconds);
      const markerY = yForPower(currentSegment?.power ?? 0);
      const markerColor = currentSegment
        ? colors[powerZone(currentSegment, currentIndex, mainSetStart)]
        : textColor;

      context.setLineDash([5, 5]);
      context.strokeStyle = textColor;
      context.globalAlpha = 0.8;
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(markerX, padding.top);
      context.lineTo(markerX, plotBottom);
      context.stroke();
      context.setLineDash([]);
      context.globalAlpha = 1;

      context.fillStyle = markerColor;
      context.strokeStyle = textColor;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(markerX, markerY, 6, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    };

    draw();
    const resizeObserver = new ResizeObserver(draw);
    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, [segments, currentIndex, remainingMs, status, mainSetStart]);

  return (
    <figure className="protocol-chart">
      <div className="chart-heading">
        <div>
          <p className="eyebrow">Full protocol</p>
          <h3>Power over time</h3>
        </div>
        <span>Live position shown in white</span>
      </div>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Protocol power line graph. The horizontal axis is time and the vertical axis is power in watts."
      >
        Protocol power over time.
      </canvas>
      <figcaption className="chart-legend">
        <span><i className="zone-dot zone-steady" />Warmup / steady</span>
        <span><i className="zone-dot zone-easy" />Easy spin</span>
        <span><i className="zone-dot zone-marker" />Sprint marker</span>
        <span><i className="zone-dot zone-recovery" />Recovery</span>
        <span><i className="zone-dot zone-effort" />Tabata effort</span>
      </figcaption>
    </figure>
  );
}

export default function Home() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [sourceName, setSourceName] = useState("No protocol loaded");
  const [participantInput, setParticipantInput] = useState("");
  const [lookupPending, setLookupPending] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [remainingMs, setRemainingMs] = useState(0);
  const [status, setStatus] = useState<TimerStatus>("ready");
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState(
    "Enter a participant ID to load its Day 4 file from the Zwift Files folder.",
  );
  const [theaterMode, setTheaterMode] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const participantInputRef = useRef<HTMLInputElement>(null);
  const segmentsRef = useRef(segments);
  const baseProtocolRef = useRef<Segment[]>([]);
  const currentIndexRef = useRef(0);
  const remainingMsRef = useRef(remainingMs);
  const statusRef = useRef<TimerStatus>(status);
  const endAtRef = useRef<number | null>(null);
  const countdownSecondRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundEnabledRef = useRef(soundEnabled);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);

  const hasProtocol = segments.length > 0;
  const mainSetStart = useMemo(() => detectMainSetStart(segments), [segments]);
  const activeSegment = segments[currentIndex] ?? null;
  const nextSegment = segments[currentIndex + 1] ?? null;
  const activePhase = activeSegment
    ? segmentPhase(activeSegment, currentIndex, mainSetStart, segments)
    : "Load a participant to begin";
  const activeZone = activeSegment
    ? powerZone(activeSegment, currentIndex, mainSetStart)
    : "steady";
  const totalSeconds = segments.reduce(
    (sum, segment) => sum + segment.duration,
    0,
  );
  const secondsBeforeCurrent = segments
    .slice(0, currentIndex)
    .reduce((sum, segment) => sum + segment.duration, 0);
  const elapsedInCurrent = Math.max(
    0,
    (activeSegment?.duration ?? 0) - remainingMs / 1000,
  );
  const elapsedSeconds =
    status === "complete"
      ? totalSeconds
      : secondsBeforeCurrent + elapsedInCurrent;
  const overallProgress = totalSeconds
    ? Math.min(100, (elapsedSeconds / totalSeconds) * 100)
    : 0;
  const workoutRemainingMs =
    status === "complete"
      ? 0
      : remainingMs +
        segments
          .slice(currentIndex + 1)
          .reduce((sum, segment) => sum + segment.duration * 1000, 0);
  const canAddWarmup =
    hasProtocol && status !== "complete" && currentIndex < mainSetStart;

  const setTimerStatus = useCallback((nextStatus: TimerStatus) => {
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const releaseWakeLock = useCallback(async () => {
    if (!wakeLockRef.current) return;
    try {
      await wakeLockRef.current.release();
    } catch {
      // The browser may have released it already.
    }
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    const wakeNavigator = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
    };
    if (!wakeNavigator.wakeLock || document.visibilityState !== "visible") return;
    try {
      wakeLockRef.current = await wakeNavigator.wakeLock.request("screen");
    } catch {
      // Wake Lock is optional; the timer remains accurate without it.
    }
  }, []);

  const ensureAudio = useCallback(async () => {
    if (!audioContextRef.current) {
      const AudioContextConstructor =
        window.AudioContext ||
        (
          window as typeof window & {
            webkitAudioContext?: typeof AudioContext;
          }
        ).webkitAudioContext;
      if (!AudioContextConstructor) return null;
      audioContextRef.current = new AudioContextConstructor();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const playTone = useCallback(
    async (frequency: number, duration = 0.12, volume = 0.12) => {
      if (!soundEnabledRef.current) return;
      try {
        const audio = await ensureAudio();
        if (!audio) return;
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const now = audio.currentTime;
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(now);
        oscillator.stop(now + duration + 0.02);
      } catch {
        // Audio cues are optional.
      }
    },
    [ensureAudio],
  );

  const resetToStart = useCallback(() => {
    endAtRef.current = null;
    currentIndexRef.current = 0;
    setCurrentIndex(0);
    const nextRemaining = (segmentsRef.current[0]?.duration ?? 0) * 1000;
    remainingMsRef.current = nextRemaining;
    setRemainingMs(nextRemaining);
    countdownSecondRef.current = null;
    setTimerStatus("ready");
    setNotice("Timer reset. The loaded protocol and warmup changes are preserved.");
    void releaseWakeLock();
  }, [releaseWakeLock, setTimerStatus]);

  const startTimer = useCallback(async () => {
    if (statusRef.current === "running") return;
    if (segmentsRef.current.length === 0) {
      setNotice("Load a participant protocol before starting the timer.");
      return;
    }

    if (statusRef.current === "complete") {
      currentIndexRef.current = 0;
      setCurrentIndex(0);
      remainingMsRef.current = (segmentsRef.current[0]?.duration ?? 0) * 1000;
      setRemainingMs(remainingMsRef.current);
    }

    await ensureAudio();
    endAtRef.current = performance.now() + remainingMsRef.current;
    countdownSecondRef.current = null;
    setTimerStatus("running");
    setNotice("Timer running. Keep the current power centered on the display.");
    void requestWakeLock();
  }, [ensureAudio, requestWakeLock, setTimerStatus]);

  const pauseTimer = useCallback(() => {
    if (statusRef.current !== "running") return;
    const nextRemaining = Math.max(
      0,
      (endAtRef.current ?? performance.now()) - performance.now(),
    );
    remainingMsRef.current = nextRemaining;
    setRemainingMs(nextRemaining);
    endAtRef.current = null;
    setTimerStatus("paused");
    setNotice("Paused. Start resumes from this exact point.");
    void releaseWakeLock();
  }, [releaseWakeLock, setTimerStatus]);

  const skipInterval = useCallback(() => {
    if (segmentsRef.current.length === 0) {
      setNotice("Load a participant protocol before using the timer controls.");
      return;
    }
    const nextIndex = currentIndexRef.current + 1;
    if (nextIndex >= segmentsRef.current.length) {
      remainingMsRef.current = 0;
      setRemainingMs(0);
      setTimerStatus("complete");
      setNotice("Protocol complete.");
      void playTone(1046, 0.45, 0.16);
      void releaseWakeLock();
      return;
    }

    currentIndexRef.current = nextIndex;
    setCurrentIndex(nextIndex);
    const nextRemaining = segmentsRef.current[nextIndex].duration * 1000;
    remainingMsRef.current = nextRemaining;
    setRemainingMs(nextRemaining);
    countdownSecondRef.current = null;
    if (statusRef.current === "running") {
      endAtRef.current = performance.now() + nextRemaining;
    }
    setNotice(`Moved to interval ${nextIndex + 1}.`);
    void playTone(880, 0.14, 0.13);
  }, [playTone, releaseWakeLock, setTimerStatus]);

  const applyProtocol = useCallback(
    (nextSegments: Segment[], name: string, message: string) => {
      const cleanSegments = cloneSegments(nextSegments);
      segmentsRef.current = cleanSegments;
      baseProtocolRef.current = cloneSegments(cleanSegments);
      setSegments(cleanSegments);
      setSourceName(name);
      currentIndexRef.current = 0;
      setCurrentIndex(0);
      remainingMsRef.current = cleanSegments[0].duration * 1000;
      setRemainingMs(remainingMsRef.current);
      endAtRef.current = null;
      countdownSecondRef.current = null;
      setTimerStatus("ready");
      setNotice(message);
      void releaseWakeLock();
    },
    [releaseWakeLock, setTimerStatus],
  );

  const loadCsvFile = useCallback(
    async (file: File) => {
      try {
        const parsed = parseProtocolCsv(await file.text());
        applyProtocol(
          parsed,
          file.name,
          `${file.name} loaded: ${parsed.length} power intervals, ${formatDuration(
            parsed.reduce((sum, segment) => sum + segment.duration, 0),
          )} total.`,
        );
      } catch (error) {
        setNotice(
          error instanceof Error ? `Could not load file: ${error.message}` : "Could not load file.",
        );
      }
    },
    [applyProtocol],
  );

  const loadParticipantProtocol = useCallback(async (submittedValue?: string) => {
    let participant = (
      submittedValue ?? participantInputRef.current?.value ?? participantInput
    )
      .trim()
      .toUpperCase();
    if (/^\d+(?:_\d+)?$/.test(participant)) participant = `P${participant}`;
    if (!/^P\d+(?:_\d+)?$/.test(participant)) {
      setNotice("Enter a participant such as P6 or P12.");
      return;
    }

    const isLocalLabPage =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (!isLocalLabPage) {
      setParticipantInput(participant);
      setNotice(
        `Choose ${participant} Day 4.csv from this device to load the protocol.`,
      );
      fileInputRef.current?.click();
      return;
    }

    setLookupPending(true);
    setNotice(`Looking for ${participant} Day 4.csv in the Zwift Files folder...`);
    try {
      const response = await fetch(
        `/api/local-protocol?participant=${encodeURIComponent(participant)}`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(result?.error ?? `The file lookup failed (${response.status}).`);
      }

      const parsed = parseProtocolCsv(await response.text());
      const fileName = `${participant} Day 4.csv`;
      setParticipantInput(participant);
      applyProtocol(
        parsed,
        fileName,
        `${fileName} loaded from Day 4/Zwift Files: ${parsed.length} power intervals, ${formatDuration(
          parsed.reduce((sum, segment) => sum + segment.duration, 0),
        )} total.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `Could not load participant: ${error.message}`
          : "Could not load the participant file.",
      );
    } finally {
      setLookupPending(false);
    }
  }, [applyProtocol, participantInput]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void loadCsvFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadCsvFile(file);
  };

  const addWarmup = useCallback(() => {
    const index = currentIndexRef.current;
    const currentSegments = segmentsRef.current;
    const detectedStart = detectMainSetStart(currentSegments);
    if (index >= detectedStart || statusRef.current === "complete") {
      setNotice("Extra warmup is locked once the participant-specific main set begins.");
      return;
    }

    const nextSegments = cloneSegments(currentSegments);
    const active = nextSegments[index];
    if (active.power === 50) {
      active.duration += EXTRA_WARMUP_SECONDS;
      if (statusRef.current === "running" && endAtRef.current !== null) {
        endAtRef.current += EXTRA_WARMUP_SECONDS * 1000;
      }
      remainingMsRef.current += EXTRA_WARMUP_SECONDS * 1000;
      setRemainingMs(remainingMsRef.current);
      setNotice("Added 5:00 to the current 50 W warmup interval.");
    } else {
      nextSegments.splice(index + 1, 0, {
        id: `extension-${crypto.randomUUID()}`,
        duration: EXTRA_WARMUP_SECONDS,
        power: 50,
        extension: true,
      });
      setNotice("Queued an extra 5:00 at 50 W immediately after this interval.");
    }

    segmentsRef.current = nextSegments;
    setSegments(nextSegments);
  }, []);

  const restoreLoadedProtocol = useCallback(() => {
    const restored = cloneSegments(baseProtocolRef.current);
    if (restored.length === 0) {
      setNotice("Load a participant protocol first.");
      return;
    }
    segmentsRef.current = restored;
    setSegments(restored);
    currentIndexRef.current = 0;
    setCurrentIndex(0);
    remainingMsRef.current = restored[0].duration * 1000;
    setRemainingMs(remainingMsRef.current);
    endAtRef.current = null;
    countdownSecondRef.current = null;
    setTimerStatus("ready");
    setNotice(`Restored ${sourceName} and removed all added warmup time.`);
    void releaseWakeLock();
  }, [releaseWakeLock, setTimerStatus, sourceName]);

  const toggleSound = useCallback(async () => {
    const nextValue = !soundEnabledRef.current;
    soundEnabledRef.current = nextValue;
    setSoundEnabled(nextValue);
    if (nextValue) {
      await ensureAudio();
      void playTone(740, 0.16, 0.12);
      setNotice("Sound cues enabled. You will hear beeps at 3, 2, and 1 seconds.");
    } else {
      setNotice("Sound cues disabled.");
    }
  }, [ensureAudio, playTone]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    if (appRef.current?.requestFullscreen) {
      try {
        await appRef.current.requestFullscreen();
        return;
      } catch {
        // Fall back to the in-page theater view below.
      }
    }
    setTheaterMode((value) => !value);
  }, []);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  useEffect(() => {
    if (status !== "running") return;

    const tick = () => {
      const now = performance.now();
      let nextRemaining = (endAtRef.current ?? now) - now;
      let index = currentIndexRef.current;

      while (nextRemaining <= 0) {
        if (index >= segmentsRef.current.length - 1) {
          remainingMsRef.current = 0;
          setRemainingMs(0);
          endAtRef.current = null;
          setTimerStatus("complete");
          setNotice("Protocol complete. Great work.");
          void playTone(1046, 0.5, 0.17);
          void releaseWakeLock();
          return;
        }

        index += 1;
        currentIndexRef.current = index;
        setCurrentIndex(index);
        const scheduledEnd =
          (endAtRef.current ?? now) + segmentsRef.current[index].duration * 1000;
        endAtRef.current = scheduledEnd;
        nextRemaining = scheduledEnd - now;
        countdownSecondRef.current = null;
        void playTone(880, 0.16, 0.14);
      }

      remainingMsRef.current = nextRemaining;
      setRemainingMs(nextRemaining);

      const countdownSecond = Math.ceil(nextRemaining / 1000);
      if (
        countdownSecond <= 3 &&
        countdownSecond > 0 &&
        countdownSecondRef.current !== countdownSecond
      ) {
        countdownSecondRef.current = countdownSecond;
        void playTone(countdownSecond === 1 ? 784 : 660, 0.11, 0.11);
      }
    };

    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [playTone, releaseWakeLock, setTimerStatus, status]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && statusRef.current === "running") {
        void requestWakeLock();
      }
    };
    const handleFullscreenChange = () => {
      if (document.fullscreenElement) setTheaterMode(false);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [requestWakeLock]);

  useEffect(() => {
    return () => {
      void releaseWakeLock();
      if (audioContextRef.current) void audioContextRef.current.close();
    };
  }, [releaseWakeLock]);

  return (
    <div
      ref={appRef}
      className={`app-frame ${theaterMode ? "theater-mode" : ""}`}
      data-zone={activeZone}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            D4
          </span>
          <div>
            <p className="eyebrow">Furman testing</p>
            <h1>Protocol Timer</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className="source-chip" title={sourceName}>
            {sourceName}
          </span>
          <button className="quiet-button" type="button" onClick={toggleSound} aria-pressed={soundEnabled}>
            {soundEnabled ? "Sound on" : "Sound off"}
          </button>
          <button className="quiet-button" type="button" onClick={toggleFullscreen}>
            Full screen
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="participant-panel" aria-label="Participant protocol lookup">
          <div>
            <p className="eyebrow">Day 4 / Zwift Files</p>
            <h2>Load participant protocol</h2>
            <p>
              On the lab computer, enter a participant ID to open its matching
              <code> P# Day 4.csv</code>. On the hosted webpage, choose that CSV
              from the device when prompted.
            </p>
          </div>
          <form
            className="participant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void loadParticipantProtocol(participantInputRef.current?.value);
            }}
          >
            <label htmlFor="participant-id">Participant</label>
            <div className="participant-input-row">
              <input
                ref={participantInputRef}
                id="participant-id"
                type="text"
                value={participantInput}
                onChange={(event) => setParticipantInput(event.target.value)}
                placeholder="P6"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="participant-path"
              />
              <button type="submit" disabled={lookupPending}>
                {lookupPending ? "Loading..." : "Load protocol"}
              </button>
            </div>
            <small id="participant-path">Local: Day 4/Zwift Files/[participant] Day 4.csv</small>
          </form>
        </section>

        <section className="timer-panel" aria-label="Current power interval">
          <div className="timer-status-row">
            <span className={`status-pill status-${status}`}>{status}</span>
            <span className="interval-count">
              {hasProtocol
                ? `Interval ${Math.min(currentIndex + 1, segments.length)} of ${segments.length}`
                : "No protocol loaded"}
            </span>
          </div>

          <div className="current-readout">
            <p className="readout-label">Time left at current power</p>
            <div className="timer-clock" aria-label={`${formatClock(remainingMs)} remaining`}>
              {hasProtocol ? formatClock(remainingMs) : "--:--"}
            </div>
            <div className="current-power">
              <span>{activeSegment ? formatPower(activeSegment.power) : "--"}</span>
              {activeSegment && <small>W</small>}
            </div>
            <p
              className={`phase-label ${activeZone === "effort" && status !== "complete" ? "tabata-effort-label" : ""}`}
            >
              {status === "complete" ? "Protocol complete" : activePhase}
            </p>
          </div>

          <div className="progress-wrap">
            <div className="progress-labels">
              <span>{Math.round(overallProgress)}% complete</span>
              <span>{formatClock(workoutRemainingMs)} workout left</span>
            </div>
            <div className="progress-track" aria-hidden="true">
              <span style={{ width: `${overallProgress}%` }} />
            </div>
          </div>

          <div className="timer-controls" aria-label="Timer controls">
            {status === "running" ? (
              <button className="primary-control" type="button" onClick={pauseTimer}>
                Pause
              </button>
            ) : (
              <button className="primary-control" type="button" onClick={startTimer} disabled={!hasProtocol}>
                {status === "paused" ? "Resume" : status === "complete" ? "Start over" : "Start"}
              </button>
            )}
            <button type="button" onClick={skipInterval} disabled={!hasProtocol || status === "complete"}>
              Skip interval
            </button>
            <button type="button" onClick={resetToStart} disabled={!hasProtocol}>
              Reset timer
            </button>
          </div>
        </section>

        <aside className="side-stack">
          <section className="next-panel" aria-label="Next power interval">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Coming up</p>
                <h2>Next interval</h2>
              </div>
              {nextSegment && (
                <span className="next-number">#{currentIndex + 2}</span>
              )}
            </div>

            {nextSegment ? (
              <div className="next-readout">
                <div>
                  <p>Power</p>
                  <strong>{formatPower(nextSegment.power)} W</strong>
                </div>
                <div>
                  <p>Time</p>
                  <strong>{formatDuration(nextSegment.duration)}</strong>
                </div>
                <p className="next-phase">
                  {segmentPhase(nextSegment, currentIndex + 1, mainSetStart, segments)}
                </p>
              </div>
            ) : hasProtocol ? (
              <div className="next-readout final-readout">
                <strong>Finish</strong>
                <p>No intervals remain after this one.</p>
              </div>
            ) : (
              <div className="next-readout final-readout waiting-readout">
                <strong>Waiting</strong>
                <p>Enter a participant ID above to load the first interval.</p>
              </div>
            )}
          </section>

          <section className="warmup-panel" aria-label="Warmup extension">
            <p className="eyebrow">On-the-fly control</p>
            <h2>Need more warmup?</h2>
            <p>
              Adds five minutes at 50 W. During a 50 W interval it extends the
              clock; otherwise it queues the block next.
            </p>
            <button
              className="warmup-button"
              type="button"
              onClick={addWarmup}
              disabled={!canAddWarmup}
            >
              <span aria-hidden="true">+</span>
              Add 5:00 at 50 W
            </button>
            {hasProtocol && !canAddWarmup && status !== "complete" && (
              <p className="lock-note">Locked during the participant-specific main set.</p>
            )}
          </section>

          <div className="notice" aria-live="polite">
            <span className="notice-dot" aria-hidden="true" />
            {notice}
          </div>
        </aside>

        <section className="protocol-panel">
          <div className="protocol-header">
            <div>
              <p className="eyebrow">Loaded schedule</p>
              <h2>Protocol overview</h2>
              <p className="protocol-summary">
                {hasProtocol
                  ? `${segments.length} intervals · ${formatDuration(totalSeconds)} total`
                  : "No protocol loaded"}
              </p>
            </div>
            <div className="file-actions">
              <button type="button" onClick={restoreLoadedProtocol} disabled={!hasProtocol}>
                Remove added warmup
              </button>
              <button type="button" onClick={() => fileInputRef.current?.click()}>
                Choose CSV
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={handleFileChange}
                hidden
              />
            </div>
          </div>

          <div
            className={`drop-zone ${dropActive ? "drop-active" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDropActive(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDropActive(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label="Load a protocol CSV"
          >
            <span className="drop-icon" aria-hidden="true">CSV</span>
            <span>
              <strong>Drop another protocol here</strong>
              <small>Any continuous time_s, power_W file</small>
            </span>
          </div>

          {hasProtocol && (
            <ProtocolLineChart
              segments={segments}
              currentIndex={currentIndex}
              remainingMs={remainingMs}
              status={status}
              mainSetStart={mainSetStart}
            />
          )}

          {hasProtocol ? <div className="schedule-table" role="table" aria-label="Power interval schedule">
            <div className="schedule-row schedule-head" role="row">
              <span role="columnheader">#</span>
              <span role="columnheader">Phase</span>
              <span role="columnheader">Power</span>
              <span role="columnheader">Duration</span>
              <span role="columnheader">Starts</span>
            </div>
            {segments.map((segment, index) => {
              const startsAt = segments
                .slice(0, index)
                .reduce((sum, candidate) => sum + candidate.duration, 0);
              const rowState =
                status === "complete" || index < currentIndex
                  ? "done"
                  : index === currentIndex
                    ? "current"
                    : "upcoming";
              return (
                <div
                  className={`schedule-row row-${rowState}`}
                  role="row"
                  key={`row-${segment.id}`}
                >
                  <span role="cell">{index + 1}</span>
                  <span role="cell">
                    <i className={`zone-dot zone-${powerZone(segment, index, mainSetStart)}`} />
                    {segmentPhase(segment, index, mainSetStart, segments)}
                  </span>
                  <strong role="cell">{formatPower(segment.power)} W</strong>
                  <span role="cell">{formatDuration(segment.duration)}</span>
                  <span role="cell">{formatDuration(startsAt)}</span>
                </div>
              );
            })}
          </div> : (
            <div className="empty-schedule">
              Enter a participant above or drop a CSV here to populate the schedule.
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
