// Theme Management
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll(".theme-switcher button").forEach(btn => {
    const active = btn.dataset.theme === theme;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", active);
  });
}

function saveTheme(theme) {
  localStorage.setItem("theme", theme);
  setTheme(theme);
}

function loadTheme() {
  const saved = localStorage.getItem("theme") || "carbon";
  setTheme(saved);
}

// Initialize theme before anything else
loadTheme();

// Theme switcher event listeners
document.querySelectorAll(".theme-switcher button").forEach(btn => {
  btn.addEventListener("click", () => saveTheme(btn.dataset.theme));
});

// Live API Status Polling
async function updateSystemStatus() {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");

  try {
    const res = await fetch("/health");
    if (res.ok) {
      const data = await res.json();
      if (data.status === "ok") {
        dot.className = "status-dot online";
        text.className = "status-text online";
        text.textContent = "System: Operational";
        return;
      }
    }
    dot.className = "status-dot offline";
    text.className = "status-text";
    text.textContent = "System: Issues Detected";
  } catch (error) {
    dot.className = "status-dot offline";
    text.className = "status-text";
    text.textContent = "System: Offline";
  }
}

// Initial status check and periodic updates
updateSystemStatus();
setInterval(updateSystemStatus, 15000);

// Interactive Exchange Rate Calculator
const RATES = {
  NGN: { USDC: 0.000645, XLM: 0.00645, label: "NGN", rateStr: "1 NGN = 0.00065 USDC" },
  XAF: { USDC: 0.001667, XLM: 0.01667, label: "XAF", rateStr: "1 XAF = 0.00167 USDC" },
  KES: { USDC: 0.007692, XLM: 0.07692, label: "KES", rateStr: "1 KES = 0.00769 USDC" },
  GHS: { USDC: 0.066667, XLM: 0.66667, label: "GHS", rateStr: "1 GHS = 0.0667 USDC" },
  TZS: { USDC: 0.000385, XLM: 0.003846, label: "TZS", rateStr: "1 TZS = 0.00038 USDC" },
  ZMW: { USDC: 0.037037, XLM: 0.37037, label: "ZMW", rateStr: "1 ZMW = 0.0370 USDC" },
  RWF: { USDC: 0.000758, XLM: 0.007576, label: "RWF", rateStr: "1 RWF = 0.00076 USDC" }
};

const sendAmountInput = document.getElementById("calc-send-amount");
const sendCurrencySelect = document.getElementById("calc-send-currency");
const receiveAmountInput = document.getElementById("calc-receive-amount");
const receiveAssetSelect = document.getElementById("calc-receive-asset");

const rateDisplay = document.getElementById("rate-display");
const feeDisplay = document.getElementById("fee-display");
const finalDisplay = document.getElementById("final-display");

function calculateConversion() {
  if (!sendAmountInput || !sendCurrencySelect || !receiveAssetSelect) return;

  const sendAmt = parseFloat(sendAmountInput.value) || 0;
  const sendCurrency = sendCurrencySelect.value;
  const receiveAsset = receiveAssetSelect.value;

  const config = RATES[sendCurrency];
  if (!config) return;

  const rate = config[receiveAsset] || 0;

  // Operator fee (1.5%)
  const fee = sendAmt * 0.015;
  const netAmt = Math.max(0, sendAmt - fee);
  const receiveVal = netAmt * rate;

  // Format decimal display outputs to 2 decimal places
  const formattedFee = fee.toFixed(2);
  const formattedReceiveVal = receiveVal.toFixed(2);

  // Update DOM elements cleanly
  if (rateDisplay) {
    rateDisplay.textContent = config.rateStr.replace("USDC", receiveAsset);
  }
  if (feeDisplay) {
    feeDisplay.textContent = `${formattedFee} ${sendCurrency}`;
  }
  if (receiveAmountInput) {
    receiveAmountInput.value = formattedReceiveVal;
  }
  if (finalDisplay) {
    finalDisplay.textContent = `${formattedReceiveVal} ${receiveAsset}`;
  }
}

// Add event listeners for inputs (including keypress and keyup for live calculation)
if (sendAmountInput) {
  sendAmountInput.addEventListener("input", calculateConversion);
  sendAmountInput.addEventListener("keypress", calculateConversion);
  sendAmountInput.addEventListener("keyup", calculateConversion);
  sendAmountInput.addEventListener("change", calculateConversion);
}
if (sendCurrencySelect) {
  sendCurrencySelect.addEventListener("change", calculateConversion);
}
if (receiveAssetSelect) {
  receiveAssetSelect.addEventListener("change", calculateConversion);
}

// Initial calculation
calculateConversion();

// Fetch live rates from our backend proxy
async function loadLiveRates() {
  try {
    const res = await fetch("/api/live-rates");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.rates) {
        const rates = data.rates;
        for (const cur of Object.keys(RATES)) {
          if (rates[cur]) {
            const rawRate = rates[cur];
            RATES[cur].USDC = 1 / rawRate;
            RATES[cur].XLM = 10 / rawRate; // mock rate 1 USDC = 10 XLM
            RATES[cur].rateStr = `1 ${cur} = ${(1 / rawRate).toFixed(6)} USDC`;
          }
        }
        console.log("Live rates loaded successfully");
        calculateConversion();
      }
    }
  } catch (error) {
    console.warn("Failed to load live rates, using fallback:", error);
  }
}

loadLiveRates();

// API Explorer Tabs
const CODE_SNIPPETS = {
  deposit: `curl -X POST http://localhost:3000/api/transactions/deposit \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 2500,
    "phoneNumber": "+237670000000",
    "provider": "mtn",
    "stellarAddress": "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    "userId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "notes": "Savings Deposit"
  }'`,
  withdraw: `curl -X POST http://localhost:3000/api/transactions/withdraw \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 1500,
    "phoneNumber": "+255700000000",
    "provider": "airtel",
    "stellarAddress": "GBNGNTEDRBGZN2N7HQ3TUKA76U2YKRMTXPFPDPPJOSVDLQX5S4PXX7E3",
    "userId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "notes": "Remittance Payout"
  }'`,
  paylink: `curl -X POST http://localhost:3000/api/payment-links \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: dev-admin-key" \\
  -d '{
    "amount": 5000,
    "currency": "XAF",
    "merchantId": "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
    "description": "Invoice #88493"
  }'`,
  toml: `curl -X GET http://localhost:3000/.well-known/stellar.toml`,
  kyc: `curl -X POST http://localhost:3000/api/kyc/upload \\
  -H "X-API-Key: dev-admin-key" \\
  -F "file=@/path/to/passport.jpg" \\
  -F "type=id_card" \\
  -F "userId=a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"`,
  stats: `curl -X GET http://localhost:3000/api/v1/stats \\
  -H "X-API-Key: dev-admin-key"`
};

function selectTab(tabName) {
  // Update active classes on buttons
  const tabs = ["deposit", "withdraw", "paylink", "toml", "kyc", "stats"];
  tabs.forEach(t => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tabName) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });

  // Update code content
  document.getElementById("code-snippet").textContent = CODE_SNIPPETS[tabName];
}

// Copy Code Helper
function copyCode() {
  const codeText = document.getElementById("code-snippet").textContent;
  navigator.clipboard.writeText(codeText).then(() => {
    const btn = document.getElementById("btn-copy-code");
    const originalText = btn.textContent;
    btn.textContent = "Copied! ✓";
    btn.style.backgroundColor = "rgba(16, 185, 129, 0.2)";
    btn.style.color = "#10b981";
    btn.style.borderColor = "#10b981";
    
    setTimeout(() => {
      btn.textContent = originalText;
      btn.style.backgroundColor = "";
      btn.style.color = "";
      btn.style.borderColor = "";
    }, 2000);
  });
}

// Bind Event Listeners for CSP Compliance
document.getElementById("tab-btn-deposit").addEventListener("click", () => selectTab("deposit"));
document.getElementById("tab-btn-withdraw").addEventListener("click", () => selectTab("withdraw"));
document.getElementById("tab-btn-paylink").addEventListener("click", () => selectTab("paylink"));
document.getElementById("tab-btn-toml").addEventListener("click", () => selectTab("toml"));
document.getElementById("tab-btn-kyc").addEventListener("click", () => selectTab("kyc"));
document.getElementById("tab-btn-stats").addEventListener("click", () => selectTab("stats"));
document.getElementById("btn-copy-code").addEventListener("click", copyCode);

// SLA Dashboard
function formatDelay(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

async function loadSlaMetrics() {
  const fields = ["sla-total", "sla-compliance", "sla-avg", "sla-p95", "sla-minmax", "sla-breached"];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "Loading…";
  });

  try {
    const res = await fetch("/api/admin/monitoring/sla");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !data.metrics) throw new Error("Unexpected response");

    const m = data.metrics;
    document.getElementById("sla-total").textContent = m.total_deposits.toLocaleString();
    document.getElementById("sla-compliance").textContent =
      `${m.sla_compliance_rate.toFixed(1)}%`;
    document.getElementById("sla-avg").textContent = formatDelay(m.avg_delay_seconds);
    document.getElementById("sla-p95").textContent = formatDelay(m.p95_delay_seconds);
    document.getElementById("sla-minmax").textContent =
      `${formatDelay(m.min_delay_seconds)} / ${formatDelay(m.max_delay_seconds)}`;
    document.getElementById("sla-breached").textContent = m.sla_breached.toLocaleString();

    const breachCard = document.getElementById("sla-breach-card");
    if (breachCard) {
      breachCard.classList.toggle("sla-card-danger", m.sla_breached > 0);
      breachCard.classList.toggle("sla-card-alert", m.sla_breached === 0);
    }

    const updatedAt = document.getElementById("sla-updated-at");
    if (updatedAt) updatedAt.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    fields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = "—";
    });
    const updatedAt = document.getElementById("sla-updated-at");
    if (updatedAt) updatedAt.textContent = "unavailable";
  }
}

// Load on page start and refresh every 60 seconds
loadSlaMetrics();
setInterval(loadSlaMetrics, 60000);

const btnRefreshSla = document.getElementById("btn-refresh-sla");
if (btnRefreshSla) btnRefreshSla.addEventListener("click", loadSlaMetrics);

// Transaction Error Mapping (#1551)
const MTN_ERROR_MAP = {
  "4005": "Insufficient Balance",
  "4001": "Invalid Request",
  "4002": "Invalid Phone Number",
  "4003": "Transaction Not Allowed",
  "4004": "Daily Limit Exceeded",
  "4006": "Duplicate Transaction",
  "4007": "Transaction Timed Out",
  "4008": "Service Unavailable",
  "4009": "Invalid Amount",
  "4010": "Authentication Failed",
  "4011": "Account Suspended",
  "4012": "PIN Required",
  "4013": "Invalid PIN",
  "4014": "PIN Attempts Exceeded",
  "4015": "Recipient Not Registered",
  "4016": "Merchant Not Found",
  "4017": "Invalid Reference",
  "4018": "System Busy - Retry Later",
  "5001": "Internal Server Error",
  "5002": "Provider Network Error",
  "5003": "Database Error",
  "5004": "Timeout Error",
  "5005": "Unknown Error",
  "TECHNICAL_ERROR": "Technical Error - Please Try Again",
  "PAYER_NOT_FOUND": "Payer Account Not Found",
  "PAYEE_NOT_FOUND": "Recipient Account Not Found",
  "NOT_ALLOWED": "Transaction Type Not Allowed",
  "NOT_ENOUGH_FUNDS": "Insufficient Funds",
  "LIMIT_EXCEEDED": "Transaction Limit Exceeded",
  "DUPLICATE_REFERENCE": "Duplicate Transaction Reference",
  "INVALID_CALLBACK_URL": "Invalid Callback URL Configuration",
  "TOKEN_EXPIRED": "Session Expired - Please Retry"
};

const AIRTEL_ERROR_MAP = {
  "DP_REQUEST_FAILED": "Payment Request Failed - Please Retry",
  "DP_PENDING": "Transaction Pending - Awaiting Confirmation",
  "DP_SUCCESS": "Transaction Successful",
  "DP_INVALID_MSISDN": "Invalid Phone Number",
  "DP_INVALID_AMOUNT": "Invalid Transaction Amount",
  "DP_INVALID_REFERENCE": "Invalid Transaction Reference",
  "DP_INSUFFICIENT_BALANCE": "Insufficient Balance",
  "DP_SERVICE_UNAVAILABLE": "Service Temporarily Unavailable",
  "DP_LIMIT_EXCEEDED": "Daily Transaction Limit Exceeded",
  "DP_DUPLICATE_REFERENCE": "Duplicate Transaction Reference",
  "DP_AUTH_FAILED": "Authentication Failed",
  "DP_TIMEOUT": "Transaction Timed Out",
  "DP_SYSTEM_ERROR": "System Error - Please Retry",
  "DS_SUCCESS": "Disbursement Successful",
  "DS_REQUEST_FAILED": "Disbursement Failed - Please Retry",
  "DS_PENDING": "Disbursement Pending"
};

const unmappedErrors = [];

function mapProviderError(errorCode, provider) {
  if (errorCode === null || errorCode === undefined) return "Unknown Error";
  const code = String(errorCode).trim();
  let mapped;
  if (provider === "mtn" || !provider) {
    mapped = MTN_ERROR_MAP[code];
    if (mapped) return mapped;
  }
  if (provider === "airtel") {
    mapped = AIRTEL_ERROR_MAP[code];
    if (mapped) return mapped;
  }
  unmappedErrors.push({ code, provider, timestamp: new Date().toISOString() });
  console.warn("[errorMapper] Unmapped error code:", code, "for provider:", provider);
  return "Error: " + code;
}

function getTransactionErrorMessage(error, provider) {
  if (!error) return "Unknown Error";
  if (typeof error === "string") {
    if (/^\d{4}$/.test(error) || /^[A-Z_]/.test(error)) {
      return mapProviderError(error, provider);
    }
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const code = error.code || error.errorCode || error.status || error.message;
    if (code) return mapProviderError(String(code), provider);
  }
  return "Unknown Error";
}

// Provider Failover Dashboard (#1550)
async function toggleProvider(provider, currentlyEnabled) {
  const token = window.prompt(
    "Admin auth token required to change provider state:",
  );
  if (!token) return;

  const reason = currentlyEnabled
    ? window.prompt("Reason for disabling this provider (optional):", "") || undefined
    : undefined;

  try {
    const res = await fetch(
      `/api/admin/monitoring/provider-maintenance/${encodeURIComponent(provider)}/toggle`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: !currentlyEnabled, reason }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to toggle ${provider}: ${body.message || res.status}`);
      return;
    }

    await loadProviderMaintenance();
  } catch (err) {
    alert(`Failed to toggle ${provider}: ${err.message || "network error"}`);
  }
}

function renderProviderCard(p) {
  const statusClass = p.enabled ? "failover-online" : "failover-offline";
  const statusText = p.enabled ? "Online" : "Offline";
  const reasonHtml =
    !p.enabled && p.disabledReason
      ? `<div class="failover-reason">Reason: ${p.disabledReason}</div>`
      : "";

  const card = document.createElement("div");
  card.className = `failover-card glass ${statusClass}`;
  card.innerHTML = `
    <div class="failover-provider-name">${p.provider.toUpperCase()}</div>
    <div class="failover-status">${statusText}</div>
    ${reasonHtml}
    <button class="btn-toggle-provider" data-provider="${p.provider}" data-enabled="${p.enabled}">
      ${p.enabled ? "Take Offline" : "Bring Online"}
    </button>
  `;
  card
    .querySelector(".btn-toggle-provider")
    .addEventListener("click", () => toggleProvider(p.provider, p.enabled));
  return card;
}

async function loadProviderMaintenance() {
  const grid = document.getElementById("failover-grid");
  const updatedAt = document.getElementById("failover-updated-at");
  if (!grid) return;

  try {
    const res = await fetch("/api/monitoring/provider-maintenance");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.providers)) {
      throw new Error("Unexpected response");
    }

    grid.innerHTML = "";
    if (data.providers.length === 0) {
      grid.innerHTML = '<p class="failover-loading">No providers configured yet.</p>';
    } else {
      data.providers.forEach((p) => grid.appendChild(renderProviderCard(p)));
    }

    if (updatedAt) updatedAt.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    grid.innerHTML = '<p class="failover-loading">Failed to load provider states.</p>';
    if (updatedAt) updatedAt.textContent = "unavailable";
  }
}

loadProviderMaintenance();
setInterval(loadProviderMaintenance, 60000);

const btnRefreshFailover = document.getElementById("btn-refresh-failover");
if (btnRefreshFailover)
  btnRefreshFailover.addEventListener("click", loadProviderMaintenance);

// Compliance Overrides Dashboard (#1574)
async function overrideKycDecision(applicantRecordId, overrideStatus) {
  const token = window.prompt(
    "Admin auth token required to override this KYC decision:",
  );
  if (!token) return;

  const reason =
    window.prompt(`Reason for marking as ${overrideStatus} (optional):`, "") ||
    undefined;

  try {
    const res = await fetch(
      `/api/admin/monitoring/compliance/overrides/${encodeURIComponent(applicantRecordId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ overrideStatus, reason }),
      },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(`Failed to override decision: ${body.message || res.status}`);
      return;
    }

    await loadComplianceOverrides();
  } catch (err) {
    alert(`Failed to override decision: ${err.message || "network error"}`);
  }
}

function renderComplianceCard(a) {
  const effectiveStatus = a.override_status || a.verification_status;
  const statusClass =
    effectiveStatus === "approved"
      ? "failover-online"
      : effectiveStatus === "rejected"
        ? "failover-offline"
        : "";
  const overrideHtml = a.override_status
    ? `<div class="failover-reason">Manually overridden to "${a.override_status}"${a.override_reason ? `: ${a.override_reason}` : ""}</div>`
    : "";

  const card = document.createElement("div");
  card.className = `failover-card glass ${statusClass}`;
  card.innerHTML = `
    <div class="failover-provider-name">${a.phone_number || a.applicant_id}</div>
    <div class="failover-status">${effectiveStatus}</div>
    ${overrideHtml}
    <button class="btn-toggle-provider" data-action="approved">Approve</button>
    <button class="btn-toggle-provider" data-action="rejected">Reject</button>
  `;
  card
    .querySelector('[data-action="approved"]')
    .addEventListener("click", () => overrideKycDecision(a.id, "approved"));
  card
    .querySelector('[data-action="rejected"]')
    .addEventListener("click", () => overrideKycDecision(a.id, "rejected"));
  return card;
}

async function loadComplianceOverrides() {
  const grid = document.getElementById("compliance-grid");
  const updatedAt = document.getElementById("compliance-updated-at");
  if (!grid) return;

  try {
    const res = await fetch("/api/admin/monitoring/compliance/overrides");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.applicants)) {
      throw new Error("Unexpected response");
    }

    grid.innerHTML = "";
    if (data.applicants.length === 0) {
      grid.innerHTML = '<p class="failover-loading">No KYC applicants found.</p>';
    } else {
      data.applicants.forEach((a) => grid.appendChild(renderComplianceCard(a)));
    }

    if (updatedAt) updatedAt.textContent = new Date().toLocaleTimeString();
  } catch (err) {
    grid.innerHTML = '<p class="failover-loading">Failed to load compliance overrides.</p>';
    if (updatedAt) updatedAt.textContent = "unavailable";
  }
}

loadComplianceOverrides();

const btnRefreshCompliance = document.getElementById("btn-refresh-compliance");
if (btnRefreshCompliance)
  btnRefreshCompliance.addEventListener("click", loadComplianceOverrides);
