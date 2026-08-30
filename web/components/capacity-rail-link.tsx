"use client";

import Link from "next/link";
import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./capacity-rail-link.module.css";

const SUSTAINED_PRESSURE_MS = 2 * 60 * 1_000;

type CapacityAlert = {
  fingerprint?: string;
  component?: string;
  scope?: string;
  code?: string;
  status?: "observing" | "active" | "acknowledged" | "resolved";
  firstSeenAt?: string;
};

function isCapacityAlert(alert: CapacityAlert) {
  return alert.component === "host-capacity"
    || alert.scope === "capacity"
    || String(alert.fingerprint || "").startsWith("capacity:")
    || String(alert.code || "").startsWith("capacity_");
}

export default function CapacityRailLink({ active = false }: { active?: boolean }) {
  const [state, setState] = useState<"healthy" | "alert" | "loading">("loading");

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/alerts", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { alerts?: CapacityAlert[] };
        const now = Date.now();
        const sustainedPressure = (payload.alerts || []).some((alert) => {
          if (!isCapacityAlert(alert) || !["active", "acknowledged"].includes(String(alert.status))) return false;
          const firstSeenAt = Date.parse(String(alert.firstSeenAt || ""));
          return Number.isFinite(firstSeenAt) && now - firstSeenAt >= SUSTAINED_PRESSURE_MS;
        });
        if (!disposed) setState(sustainedPressure ? "alert" : "healthy");
      } catch {
        if (!disposed) setState("alert");
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const title = state === "healthy"
    ? "Capacity healthy: no server pressure sustained for two minutes"
    : state === "alert"
      ? "Capacity needs attention: sustained pressure or health status unavailable"
      : "Checking sustained server capacity";

  return (
    <Link
      className={`rail-link ${active ? "active" : ""} ${styles.link}`}
      href="/capacity"
      aria-current={active ? "page" : undefined}
      aria-label={title}
      title={title}
    >
      <span className={`${styles.icon} ${state === "healthy" ? styles.healthy : state === "alert" ? styles.alert : styles.loading}`}>
        <Gauge size={18} />
        <i aria-hidden="true" />
      </span>
      <span>Capacity</span>
    </Link>
  );
}
