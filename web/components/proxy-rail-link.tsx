"use client";

import Link from "next/link";
import { Network } from "lucide-react";
import { useEffect, useState } from "react";
import styles from "./proxy-rail-link.module.css";

export default function ProxyRailLink({ active = false }: { active?: boolean }) {
  const [state, setState] = useState<"healthy" | "alert" | "loading">("loading");

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch("/api/proxy-providers", { cache: "no-store", credentials: "same-origin" });
        const payload = await response.json() as { summary?: { openCircuits?: number; unhealthyProviders?: number } };
        if (!response.ok) throw new Error("unavailable");
        if (!disposed) setState((payload.summary?.openCircuits || payload.summary?.unhealthyProviders) ? "alert" : "healthy");
      } catch {
        if (!disposed) setState("alert");
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  const title = state === "healthy" ? "Proxy providers healthy" : state === "alert" ? "Proxy registry needs attention or is not configured" : "Checking proxy providers";
  return (
    <Link className={`rail-link ${active ? "active" : ""} ${styles.link}`} href="/proxies" aria-current={active ? "page" : undefined} aria-label={title} title={title}>
      <span className={`${styles.icon} ${state === "healthy" ? styles.healthy : state === "alert" ? styles.alert : styles.loading}`}><Network size={18} /><i aria-hidden="true" /></span>
      <span>Proxies</span>
    </Link>
  );
}
