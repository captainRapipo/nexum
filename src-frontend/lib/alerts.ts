// Rust alert → frontend condition mapping and drive-forecast text (CONTRACT §4.5 lib/alerts.ts, §2.10, §2.11).

import type { DriveForecast, HealthAction, HealthAlert, HealthCondition } from "../types";

/** Action button per alert source (CONTRACT §4.5). */
function actionFor(a: HealthAlert): HealthAction {
  switch (a.source) {
    case "drive":
      return { label: "View drive", nav: a.subjectId ? { view: "storage", focus: a.subjectId } : { view: "storage" } };
    case "space":
      return { label: "View storage", nav: { view: "storage" } };
    case "cpu":
    case "gpu":
    default:
      return { label: "View sensors", nav: a.sensorId ? { view: "sensors", focus: a.sensorId } : { view: "sensors" } };
  }
}

/** A Rust-evaluated alert as a HealthCondition (texts are display-ready from Rust). */
export function alertToCondition(a: HealthAlert): HealthCondition {
  return {
    id: a.id,
    severity: a.severity,
    source: a.source,
    group: a.group,
    short: a.short,
    title: a.title,
    detail: a.detail,
    rule: a.rule,
    dismissKey: a.dismissKey,
    action: actionFor(a),
  };
}

/** Status texts for forecasts without a months figure (exact, CONTRACT §4.5). */
export const FORECAST_STATUS_TEXT = {
  notEnoughData: "Forecast after 7 days of history (2 weeks minimum).",
  noWear: "No measurable wear in the last year.",
  noLifeData: "This drive does not report remaining life.",
  beyondHorizon: "More than 50 years at the current rate.",
} as const;

const trim0 = (n: number, digits: number) => {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/** `<x> TB written per month`, or null when the slope is unknown. */
export function fmtWriteRate(tbPerMonth: number | null | undefined): string | null {
  if (tbPerMonth == null || !Number.isFinite(tbPerMonth)) return null;
  return `${trim0(tbPerMonth, 2)} TB written per month`;
}

/**
 * One line for the S.M.A.R.T. drawer: `About <n> months to 10% life at the current rate`
 * (plus the write rate when known), or the status text.
 */
export function fmtForecast(f: DriveForecast | null | undefined): string {
  if (!f) return FORECAST_STATUS_TEXT.notEnoughData;
  const rate = fmtWriteRate(f.tbPerMonth);
  let head: string;
  if (f.status === "ok" && f.monthsTo10Pct != null) {
    head =
      f.monthsTo10Pct <= 0
        ? "Already at or below 10% life"
        : `About ${trim0(f.monthsTo10Pct, 1)} months to 10% life at the current rate`;
  } else if (f.status === "ok") {
    head = rate ?? FORECAST_STATUS_TEXT.notEnoughData;
    return head;
  } else {
    head = FORECAST_STATUS_TEXT[f.status] ?? FORECAST_STATUS_TEXT.notEnoughData;
    // notEnoughData has no slope by definition; the others may still know the write rate.
    return rate && f.status !== "notEnoughData" ? `${head} ${rate}.` : head;
  }
  return rate ? `${head} · ${rate}` : head;
}
