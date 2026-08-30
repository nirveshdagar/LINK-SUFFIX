"use client";

import Link from "next/link";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./alert-rail-link.module.css";

export default function AlertRailLink({ active = false }: { active?: boolean }) {
  const [state, setState] = useState<"healthy" | "alert" | "loading">("loading");
  const [count, setCount] = useState(0);

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/alerts?summary=1", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json() as { state?: string; summary?: { open?: number } };
        if (!disposed) {
          setCount(Number(payload.summary?.open) || 0);
          setState(payload.state === "healthy" ? "healthy" : "alert");
        }
      } catch {
        if (!disposed) setState("alert");
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  return (
    <Link
      className={`rail-link ${active ? "active" : ""} ${styles.link}`}
      href="/alerts"
      aria-current={active ? "page" : undefined}
      aria-label={state === "healthy" ? "Alerts: all systems healthy" : `Alerts: ${count || "health check"} needs attention`}
      title={state === "healthy" ? "All monitored systems healthy" : `${count || "Health check"} needs attention`}
    >
      <span className={`${styles.icon} ${state === "healthy" ? styles.healthy : state === "alert" ? styles.alert : styles.loading}`}>
        <BellRing size={18} />
        <i aria-hidden="true" />
      </span>
      <span>Alerts</span>
      {count > 0 && <strong className={styles.count}>{count > 99 ? "99+" : count}</strong>}
    </Link>
  );
}
