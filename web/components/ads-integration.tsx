"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

interface AdsState {
  campaignId: string;
  customerId: string;
  loginCustomerId: string;
  clientId: string;
  clientSecret: string;
  developerToken: string;
  refreshToken: string;
  clientIdStored: boolean;
  clientSecretStored: boolean;
  developerTokenStored: boolean;
  refreshTokenStored: boolean;
  hasCredentials: boolean;
  currentSuffix: string;
  lastSuffix: string;
  lastPushedAt: string;
  lastError: string;
  pushHistory: Array<{ at: string; suffix: string; result?: string; error?: string }>;
}

interface CampaignCaptureState {
  campaignRecordId: string;
  campaignNumber: number;
  suffix: string;
  capturedAt?: string;
  campaignName: string;
  runStatus: string;
  customerId?: string;
  googleAdsCampaignId?: string;
  managerCustomerId?: string;
  meshVersion?: number;
  meshQueuedAt?: string;
  delivery: "mesh" | "direct" | "capture";
}

type AuthRoute = "ads";



function getStoredToken() {
  if (typeof window === "undefined") return "";
  try {
    return ""?.trim() ?? "";
  } catch {
    return "";
  }
}

function getEnvToken(route: AuthRoute) {
  void route;
  return "";
}

function buildAuthHeaders(route: AuthRoute, withJson = false) {
  const token = getStoredToken() || getEnvToken(route);
  const headers: Record<string, string> = {};
  if (withJson) headers["Content-Type"] = "application/json";
  if (!token) return headers;

  headers["x-api-key"] = token;
  headers.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  return headers;
}

const SUFFIXES_PER_PAGE = 10;

export default function AdsIntegration({ captures = [] }: { captures?: CampaignCaptureState[] }) {
  const [state, setState] = useState<AdsState>({
    campaignId: "", customerId: "", loginCustomerId: "", clientId: "", clientSecret: "",
    developerToken: "", refreshToken: "", clientIdStored: false, clientSecretStored: false, developerTokenStored: false, refreshTokenStored: false, hasCredentials: false,
    currentSuffix: "", lastSuffix: "", lastPushedAt: "", lastError: "", pushHistory: [],
  });

  // Proxy session state
  // UI state
  const [campaignId, setCampaignId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [loginCustomerId, setLoginCustomerId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [developerToken, setDeveloperToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [directApiAuth, setDirectApiAuth] = useState<"unknown" | "configured" | "missing">("unknown");
  const [suffixSearch, setSuffixSearch] = useState("");
  const [suffixPage, setSuffixPage] = useState(1);
  const SECRET_PLACEHOLDER = "••••••";

  const isMaskedSecret = (value: string) => /^•{4,}$/.test(value);

  const fetchState = useCallback(async () => {
    try {
      const adsRes = await fetch("/api/ads", { headers: buildAuthHeaders("ads") });
      if (adsRes.ok) {
        setDirectApiAuth("configured");
        const adsData = await adsRes.json();
        setState(adsData);
        setCampaignId((prev) => prev || adsData.campaignId || "");
        setCustomerId((prev) => prev || adsData.customerId || "");
        setLoginCustomerId((prev) => prev || adsData.loginCustomerId || "");
        setClientId((prev) => prev || (adsData.clientIdStored ? SECRET_PLACEHOLDER : ""));
        setClientSecret((prev) => prev || (adsData.clientSecretStored ? SECRET_PLACEHOLDER : ""));
        setDeveloperToken((prev) => prev || (adsData.developerTokenStored ? SECRET_PLACEHOLDER : ""));
        setRefreshToken((prev) => prev || (adsData.refreshTokenStored ? SECRET_PLACEHOLDER : ""));
      } else if (adsRes.status === 401) setDirectApiAuth("missing");
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchState();
    const i = setInterval(fetchState, 4000);
    return () => clearInterval(i);
  }, [fetchState]);

  const saveConfig = async () => {
    setLoading(true); setMessage(null);
    const payload: Record<string, string> = { action: "configure" };
    if (campaignId) payload.campaignId = campaignId;
    if (customerId) payload.customerId = customerId;
    if (loginCustomerId) payload.loginCustomerId = loginCustomerId;
    if (clientId && !isMaskedSecret(clientId)) payload.clientId = clientId;
    if (clientSecret && !isMaskedSecret(clientSecret)) payload.clientSecret = clientSecret;
    if (developerToken && !isMaskedSecret(developerToken)) payload.developerToken = developerToken;
    if (refreshToken && !isMaskedSecret(refreshToken)) payload.refreshToken = refreshToken;

    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: buildAuthHeaders("ads", true),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) setMessage({ type: "error", text: data.error ?? "Save failed" });
      else { setMessage({ type: "ok", text: `Saved — Campaign ${data.campaignId || "—"}` }); fetchState(); }
    } finally { setLoading(false); }
  };

  const refreshSuffix = async () => {
    setLoading(true); setMessage(null);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: buildAuthHeaders("ads", true),
        body: JSON.stringify({ action: "refresh_suffix" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) setMessage({ type: "error", text: data.error });
      else { setMessage({ type: "ok", text: `Suffix captured: "${data.suffix}"` }); fetchState(); }
    } finally { setLoading(false); }
  };

  const pushSuffix = async () => {
    setLoading(true); setMessage(null);
    try {
      const res = await fetch("/api/ads", {
        method: "POST",
        headers: buildAuthHeaders("ads", true),
        body: JSON.stringify({ action: "push_to_ads" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) setMessage({ type: "error", text: data.error });
      else if (data.skipped) { setMessage({ type: "ok", text: `Already up-to-date — pushed ${new Date(data.at).toLocaleTimeString()}` }); }
      else { setMessage({ type: "ok", text: `Pushed at ${new Date(data.at).toLocaleTimeString()}` }); }
      fetchState();
    } finally { setLoading(false); }
  };

  const campaignCaptures = useMemo(
    () => captures.filter((item) => Boolean(item.suffix)),
    [captures],
  );
  const filteredCaptures = useMemo(() => {
    const query = suffixSearch.trim().toLowerCase();
    if (!query) return campaignCaptures;
    return campaignCaptures.filter((item) => [
      item.campaignName,
      item.campaignRecordId,
      item.campaignNumber,
      item.customerId,
      item.googleAdsCampaignId,
      item.managerCustomerId,
    ].some((value) => String(value ?? "").toLowerCase().includes(query)));
  }, [campaignCaptures, suffixSearch]);
  const suffixPageCount = Math.max(1, Math.ceil(filteredCaptures.length / SUFFIXES_PER_PAGE));
  const visibleCaptures = filteredCaptures.slice(
    (Math.min(suffixPage, suffixPageCount) - 1) * SUFFIXES_PER_PAGE,
    Math.min(suffixPage, suffixPageCount) * SUFFIXES_PER_PAGE,
  );
  const latestCapture = campaignCaptures[0];
  const currentSuffix = latestCapture?.suffix || state.currentSuffix;
  const suffixStatus = currentSuffix ? "online" : "";

  return (
    <section id="ads" className="ads-page" aria-labelledby="ads-heading">
      <header className="ads-masthead">
        <div>
          <p className="ads-kicker">Traffic Armour / Ads Integration</p>
          <h1 id="ads-heading">Google Ads final_url_suffix sync</h1>
          <p className="ads-lede">Route real residential traffic through Royal Residential proxies and sync captured query strings into Google Ads.</p>
        </div>
        <div className={`ads-status ${suffixStatus}`}>
          <span className="status-dot" />
          <div>
            <b>{currentSuffix ? `${campaignCaptures.length || 1} campaign suffix${campaignCaptures.length === 1 ? "" : "es"}` : "No suffix yet"}</b>
            <small>{latestCapture?.delivery === "mesh" && latestCapture.meshVersion ? `Latest mesh capture · v${latestCapture.meshVersion}` : `${state.pushHistory.length} direct API pushes`}</small>
          </div>
        </div>
      </header>

      {message && (
        <div className={`ads-notice ${message.type}`}>
          {message.type === "ok" ? "✓" : "⚠"}
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="ads-notice-x">×</button>
        </div>
      )}

      {directApiAuth === "missing" && (
        <div className="ads-notice ok">
          <span>Direct Google Ads API authentication is not configured. This does not affect Rolling Apps Script Mesh; the captured campaign suffix remains available below.</span>
        </div>
      )}

      <div className="ads-layout">
        <div className="ads-form">
          {/* Step 1: Campaign Config */}
          <section className="ads-section">
            <div className="section-badge">01</div>
            <div className="section-body">
              <h2>Campaign configuration</h2>
              <p>Find these in Google Ads UI: Campaign Settings → ID, and top-level account menu → Customer ID.</p>
              <div className="field-row two">
                <label>Campaign ID<input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="e.g. 12345678901" /></label>
                <label>Customer ID<input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="e.g. 1234567890" /></label>
              </div>
              <div className="field-row two">
                <label>Manager account ID <span className="section-sub">(optional)</span><input value={loginCustomerId} onChange={(e) => setLoginCustomerId(e.target.value)} placeholder="MCC login customer ID" /></label>
              </div>
            </div>
          </section>

          <hr className="ads-divider" />

          {/* Step 2: OAuth Credentials */}
          <section className="ads-section">
            <div className="section-badge">02</div>
            <div className="section-body">
              <h2>OAuth2 credentials <span className="section-sub">(one-time setup)</span></h2>
              <p>Get these from Google Cloud Console, Google Ads API Center, and the OAuth Playground. Stored locally.</p>
              <div className="field-row two">
                <label>OAuth Client ID<input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="from Google Cloud Console" /></label>
                <label>Client Secret<input type={showSecrets ? "text" : "password"} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></label>
              </div>
              <div className="field-row two">
                <label>Developer Token<input value={developerToken} onChange={(e) => setDeveloperToken(e.target.value)} placeholder="from Google Ads API Center" /></label>
                <label>Refresh Token<input type={showSecrets ? "text" : "password"} value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} /></label>
              </div>
              <label className="ads-checkbox">
                <input type="checkbox" checked={showSecrets} onChange={(e) => setShowSecrets(e.target.checked)} />
                <span>Show secrets</span>
              </label>
              {state.hasCredentials && (
                <div className="ads-saved-ok">Credentials saved · Client: {state.clientId} · Token: {state.developerToken}</div>
              )}
              <button type="button" disabled={loading} onClick={saveConfig} className="ads-btn">
                {loading ? "Saving…" : "Save all config"}
              </button>
            </div>
          </section>

          <hr className="ads-divider" />

          {/* Step 3: Current Suffix */}
          <section className="ads-section">
            <div className="section-badge">03</div>
            <div className="section-body">
              <h2>Campaign final URL suffixes</h2>
              <p>Each bordered record is one saved campaign. Campaign cards scroll inside this panel, while every exact suffix stays on its own horizontal line.</p>
              {campaignCaptures.length > 0 ? (
                <>
                  <div className="ads-suffix-toolbar">
                    <span><strong>{campaignCaptures.length}</strong> captured campaign{campaignCaptures.length === 1 ? "" : "s"}</span>
                    <input
                      value={suffixSearch}
                      onChange={(event) => { setSuffixSearch(event.target.value); setSuffixPage(1); }}
                      placeholder="Find campaign name, number, customer, or campaign ID"
                      aria-label="Find captured campaign suffix"
                    />
                  </div>
                  <div className="ads-suffix-list">
                    {visibleCaptures.map((item, index) => (
                      <article className="ads-suffix-card" key={item.campaignRecordId}>
                        <header>
                          <div className="ads-suffix-identity">
                            <span>{String(item.campaignNumber).padStart(3, "0")}</span>
                            <div>
                              <strong>{item.campaignName}</strong>
                              <small>{item.campaignRecordId}</small>
                            </div>
                          </div>
                          <div className="ads-suffix-flags">
                            {suffixPage === 1 && index === 0 && !suffixSearch ? <span className="latest">Latest capture</span> : null}
                            <span className={`run-${item.runStatus}`}>{item.runStatus}</span>
                          </div>
                        </header>
                        <dl className="ads-suffix-targets">
                          <div><dt>Google Ads campaign</dt><dd>{item.googleAdsCampaignId || "Not configured"}</dd></div>
                          <div><dt>Customer account</dt><dd>{item.customerId || "Not configured"}</dd></div>
                          <div><dt>Manager account</dt><dd>{item.managerCustomerId || "Not configured"}</dd></div>
                        </dl>
                        <div className="ads-suffix-box">
                          <span className="suffix-icon">URL</span>
                          <code>{item.suffix}</code>
                        </div>
                        <div className="ads-meta-row">
                          <span>Captured: {item.capturedAt ? new Date(item.capturedAt).toLocaleString() : "—"}</span>
                          <span>Delivery: {item.delivery === "mesh" ? "Rolling Apps Script Fleet" : item.delivery === "direct" ? "Direct Google Ads API" : "Capture only"}</span>
                          {item.delivery === "mesh" ? <span>Mesh: {item.meshVersion ? `queued version ${item.meshVersion}` : "queued"}</span> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                  {suffixPageCount > 1 ? (
                    <div className="ads-suffix-pager">
                      <button type="button" disabled={suffixPage <= 1} onClick={() => setSuffixPage((page) => Math.max(1, page - 1))}>Previous</button>
                      <span>Page {Math.min(suffixPage, suffixPageCount)} of {suffixPageCount}</span>
                      <button type="button" disabled={suffixPage >= suffixPageCount} onClick={() => setSuffixPage((page) => Math.min(suffixPageCount, page + 1))}>Next</button>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="ads-suffix-card empty-suffix">
                  <div className="ads-suffix-box">
                    <span className="suffix-icon">00</span>
                    <code>{state.currentSuffix || "— run traffic to capture a redirect chain —"}</code>
                  </div>
                  <div className="ads-meta-row">
                    <span>Campaign: {state.campaignId || "Not associated with a saved campaign"}</span>
                    <span>Pushed: {state.lastPushedAt ? new Date(state.lastPushedAt).toLocaleString() : "—"}</span>
                  </div>
                </div>
              )}
              <button type="button" disabled={loading} onClick={refreshSuffix} className="ads-btn secondary">Refresh suffix</button>
            </div>
          </section>

          <hr className="ads-divider" />

          {/* Step 4: Push to Ads */}
          <section className="ads-section">
            <div className="section-badge">04</div>
            <div className="section-body">
              <h2>Push to Google Ads</h2>
              <p>Write the current suffix to the campaign&apos;s final_url_suffix field.</p>
              {state.lastError && <div className="ads-error">{state.lastError}</div>}
              <button type="button" disabled={loading || directApiAuth !== "configured" || !state.campaignId || !currentSuffix} onClick={pushSuffix} className="ads-btn">
                {loading ? "Pushing…" : `Push suffix to campaign ${state.campaignId || "—"}`}
              </button>
            </div>
          </section>

        </div>
      </div>
    </section>
  );
}
