import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, subscribe } from "../lib/api";
import type { AgentAck, AgentStatus, TelemetryPacket } from "../types";

/** Number of packets kept in the ring buffer (≈2 minutes at 1 Hz). */
export const TELEMETRY_HISTORY = 120;

export interface TelemetryContextValue {
  latest: TelemetryPacket | null;
  /** Oldest → newest, at most TELEMETRY_HISTORY packets. */
  history: TelemetryPacket[];
  agent: AgentStatus | null;
  /** Most recent `agent-ack` (new object identity per ack, so effects can react to repeats). */
  lastAck: AgentAck | null;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

/**
 * Defensive normalisation: the Rust core forwards sidecar JSON verbatim, so make
 * sure the array fields views iterate over always exist.
 */
function normalizePacket(raw: unknown): TelemetryPacket | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<TelemetryPacket>;
  if (!p.cpu || !p.ram || typeof p.ts !== "number") return null;
  return {
    ...(p as TelemetryPacket),
    type: "telemetry",
    cpu: { ...p.cpu, loadPerCore: Array.isArray(p.cpu.loadPerCore) ? p.cpu.loadPerCore : [] },
    gpu: p.gpu ?? null,
    gpus: Array.isArray(p.gpus) ? p.gpus : p.gpu ? [p.gpu] : [],
    fans: Array.isArray(p.fans) ? p.fans : [],
    disks: Array.isArray(p.disks) ? p.disks : [],
    network: p.network ?? null,
    fanPreset: p.fanPreset ?? "auto",
  };
}

interface StreamState {
  latest: TelemetryPacket | null;
  history: TelemetryPacket[];
}

export function TelemetryProvider({ children }: { children: ReactNode }) {
  const [stream, setStream] = useState<StreamState>({ latest: null, history: [] });
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [lastAck, setLastAck] = useState<AgentAck | null>(null);
  const buffer = useRef<TelemetryPacket[]>([]);
  const gotStatusEvent = useRef(false);

  useEffect(() => {
    let disposed = false;

    const offTelemetry = subscribe<unknown>("telemetry", (raw) => {
      const pkt = normalizePacket(raw);
      if (!pkt) return;
      const buf = buffer.current;
      const last = buf[buf.length - 1];
      // Drop exact duplicates only; a wall-clock step backwards must not stall the stream.
      if (last && pkt.ts === last.ts) return;
      const next = buf.length >= TELEMETRY_HISTORY ? buf.slice(buf.length - TELEMETRY_HISTORY + 1) : buf.slice();
      next.push(pkt);
      buffer.current = next;
      setStream({ latest: pkt, history: next });
    });

    const offStatus = subscribe<AgentStatus>("agent-status", (s) => {
      if (!s || typeof s !== "object") return;
      gotStatusEvent.current = true;
      setAgent({ ...s });
    });

    const offAck = subscribe<AgentAck>("agent-ack", (a) => {
      if (!a || typeof a !== "object") return;
      setLastAck({ ...a });
    });

    api
      .getAgentStatus()
      .then((s) => {
        // A pushed event is fresher than this initial query; don't overwrite it.
        if (!disposed && !gotStatusEvent.current) setAgent(s);
      })
      .catch((err) => {
        if (disposed || gotStatusEvent.current) return;
        setAgent({ running: false, isAdmin: false, message: errorMessage(err), lastPacketTs: null });
      });

    return () => {
      disposed = true;
      offTelemetry();
      offStatus();
      offAck();
    };
  }, []);

  const value = useMemo<TelemetryContextValue>(
    () => ({ latest: stream.latest, history: stream.history, agent, lastAck }),
    [stream, agent, lastAck],
  );

  return createElement(TelemetryContext.Provider, { value }, children);
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error("useTelemetry() must be used inside <TelemetryProvider>");
  return ctx;
}

/** Alias matching the file name, for callers that prefer it. */
export const useTelemetryStream = useTelemetry;
