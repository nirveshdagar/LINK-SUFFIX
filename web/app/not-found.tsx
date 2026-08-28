import Link from "next/link";

export default function NotFound() {
  return (
    <main className="not-found-page">
      <p className="eyebrow">TRAFFIC ARMOUR</p>
      <strong>404</strong>
      <h1>This route is outside the control plane.</h1>
      <p>The page may have moved, or the address may be incomplete.</p>
      <div><Link href="/">Return to control</Link><Link href="/dashboard">Open telemetry</Link></div>
    </main>
  );
}
