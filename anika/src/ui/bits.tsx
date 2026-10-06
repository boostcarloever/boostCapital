/** Small shared pieces: toasts with a live region, time formatting, labels. */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Provenance, Rule, RunState } from "../core/types";
import { ApiError } from "./api";

interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
  recovery?: string | null;
}

const ToastCtx = createContext<{ say: (text: string, tone?: Toast["tone"], recovery?: string | null) => void; fail: (err: unknown) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const say = useCallback((text: string, tone: Toast["tone"] = "info", recovery?: string | null) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone, recovery }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 9000 : 4500);
  }, []);
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) say(err.message, "error", err.recovery);
      else say(err instanceof Error ? err.message : "Something went wrong.", "error");
    },
    [say],
  );
  const value = useMemo(() => ({ say, fail }), [say, fail]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toast-zone" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === "error" ? "error" : ""}`} role={t.tone === "error" ? "alert" : undefined}>
            <span>
              {t.text}
              {t.recovery ? <> {t.recovery}</> : null}
            </span>
            <button className="tbtn" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("ToastProvider missing");
  return ctx;
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function day(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return clock(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const PROVENANCE: Record<Provenance, { label: string; hint: string }> = {
  i_wrote: { label: "I wrote this", hint: "Evidence of your voice." },
  ai_assisted: { label: "AI-assisted and approved", hint: "Drafted with help, then approved by you." },
  client_authorized: { label: "Authorized client writing", hint: "Written for someone who permits its use." },
  inspiration: { label: "Inspiration only", hint: "Admired writing. Never treated as your voice." },
};

export function scopeText(rule: Rule, modes: { id: string; name: string }[]): string {
  if (rule.scope.kind === "core") return "Everything you write";
  return rule.scope.modeIds.map((id) => modes.find((m) => m.id === id)?.name ?? "Unknown mode").join(", ");
}

export const ORIGIN: Record<Rule["origin"], string> = {
  explicit_feedback: "From your correction",
  inferred_from_examples: "Inferred from your examples",
  user_written: "Written by you",
};

export const STAGE_ORDER: { state: RunState; label: string }[] = [
  { state: "PREFLIGHT", label: "Preflight" },
  { state: "CONTEXT_READY", label: "Context compiled" },
  { state: "MECHANICAL_CHECK", label: "Explicit rules" },
  { state: "VOICE_AND_MEANING_CHECKS", label: "Voice and meaning" },
  { state: "REPAIR", label: "Repair" },
  { state: "RECHECK", label: "Recheck" },
];

export function words(n: number): string {
  return `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
}

export function pad(n: number, size = 2): string {
  return String(n).padStart(size, "0");
}
