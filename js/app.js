/**
 * UpDown — mobile multi-portfolio crypto tracker (CMC-style)
 * All user data persisted in localStorage.
 */

const STORAGE_KEY = "updown.app.v2";
const LEGACY_KEY = "updown.addresses.v1";
const SNAPSHOT_KEY = "updown.market.v1";
const NIGHT_POLICY_ID = "0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa";
const NIGHT_ASSET_NAME = "4e49474854";

// ── Coin config ────────────────────────────────────────────────────────────

const COINS = [
  {
    id: "btc",
    name: "Bitcoin",
    symbol: "BTC",
    geckoId: "bitcoin",
    decimals: 8,
    color: "#f7931a",
    placeholder: "bc1… / 1… / 3…",
    note: "Native BTC address (SegWit, Legacy, or Taproot).",
    explorer: (a) => `https://mempool.space/address/${a}`,
    fetchBalance: fetchBtcBalance,
  },
  {
    id: "xrp",
    name: "XRP",
    symbol: "XRP",
    geckoId: "ripple",
    decimals: 6,
    color: "#23292f",
    placeholder: "r…",
    note: "Classic XRPL address starting with r.",
    explorer: (a) => `https://livenet.xrpl.org/accounts/${a}`,
    fetchBalance: fetchXrpBalance,
  },
  {
    id: "xlm",
    name: "Stellar",
    symbol: "XLM",
    geckoId: "stellar",
    decimals: 7,
    color: "#000000",
    placeholder: "G…",
    note: "Public key starting with G.",
    explorer: (a) => `https://stellarchain.io/accounts/${a}`,
    fetchBalance: fetchXlmBalance,
  },
  {
    id: "hbar",
    name: "Hedera",
    symbol: "HBAR",
    geckoId: "hedera-hashgraph",
    decimals: 8,
    color: "#8259ef",
    placeholder: "0.0.12345",
    note: "Account ID (0.0.x).",
    explorer: (a) => `https://hashscan.io/mainnet/account/${a}`,
    fetchBalance: fetchHbarBalance,
  },
  {
    id: "ada",
    name: "Cardano",
    symbol: "ADA",
    geckoId: "cardano",
    decimals: 6,
    color: "#0033ad",
    placeholder: "addr1…",
    note: "Payment address (addr1…).",
    explorer: (a) => `https://cardanoscan.io/address/${a}`,
    fetchBalance: fetchAdaBalance,
  },
  {
    id: "night",
    name: "Midnight",
    symbol: "NIGHT",
    geckoId: "midnight-3",
    decimals: 6,
    color: "#0a0a0a",
    placeholder: "addr1… holding NIGHT",
    note: "NIGHT as a Cardano native asset — use the Cardano address that holds NIGHT.",
    explorer: (a) => `https://cardanoscan.io/address/${a}`,
    fetchBalance: fetchNightBalance,
  },
  {
    id: "doge",
    name: "Dogecoin",
    symbol: "DOGE",
    geckoId: "dogecoin",
    decimals: 8,
    color: "#c2a633",
    placeholder: "D…",
    note: "Dogecoin mainnet address.",
    explorer: (a) => `https://dogechain.info/address/${a}`,
    fetchBalance: fetchDogeBalance,
  },
  {
    id: "ltc",
    name: "Litecoin",
    symbol: "LTC",
    geckoId: "litecoin",
    decimals: 8,
    color: "#345d9d",
    placeholder: "ltc1… / L… / M…",
    note: "Litecoin address.",
    explorer: (a) => `https://litecoinspace.org/address/${a}`,
    fetchBalance: fetchLtcBalance,
  },
];

const COIN_BY_ID = Object.fromEntries(COINS.map((c) => [c.id, c]));

// ── App state ──────────────────────────────────────────────────────────────

/** @type {{ version: number, activePortfolioId: string|null, exchangeFeePct: number, portfolios: Portfolio[] }} */
let store = loadStore();

/** When true, don't overwrite manual price field with live market price. */
let manualPriceDirty = false;
/** Last coinId we prefilled price for (reset dirty on coin change). */
let manualPriceCoinId = null;

/** @type {Record<string, { usd: number, change24h: number }>} */
let prices = {};

/**
 * Cached CoinGecko market charts: `${coinId}:${days}` → { fetchedAt, points }
 * @type {Record<string, { fetchedAt: number, points: [number, number][] }>}
 */
let chartCache = {};

/** Selected dashboard chart range (CoinGecko days param). */
let chartRange = "1";

/** Last holdings used for the chart (for range tab / retry reloads). */
let lastChartHoldings = [];

/**
 * balanceCache[portfolioId][coinId][address] = { balance, error, loading }
 * @type {Record<string, Record<string, Record<string, { balance: number|null, error: string|null, loading: boolean }>>>}
 */
let balanceCache = {};

/** Chart fetch in progress (for global header spinner). */
let chartLoading = false;

/**
 * Load last-known prices + on-chain balances so the UI never flashes $0 on refresh.
 */
function loadMarketSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data?.prices && typeof data.prices === "object") {
      prices = data.prices;
    }
    if (data?.balances && typeof data.balances === "object") {
      // Restore balances but never restore as "loading"
      for (const pfId of Object.keys(data.balances)) {
        balanceCache[pfId] = balanceCache[pfId] || {};
        for (const coinId of Object.keys(data.balances[pfId] || {})) {
          balanceCache[pfId][coinId] = balanceCache[pfId][coinId] || {};
          for (const addr of Object.keys(data.balances[pfId][coinId] || {})) {
            const row = data.balances[pfId][coinId][addr];
            if (!row || typeof row !== "object") continue;
            balanceCache[pfId][coinId][addr] = {
              balance: row.balance != null && Number.isFinite(Number(row.balance)) ? Number(row.balance) : null,
              error: row.error || null,
              loading: false,
            };
          }
        }
      }
    }
  } catch {
    /* ignore corrupt snapshot */
  }
}

/** Persist prices + successful balances for the next page load / mid-refresh display. */
function saveMarketSnapshot() {
  try {
    const balances = {};
    for (const pfId of Object.keys(balanceCache)) {
      balances[pfId] = {};
      for (const coinId of Object.keys(balanceCache[pfId] || {})) {
        balances[pfId][coinId] = {};
        for (const addr of Object.keys(balanceCache[pfId][coinId] || {})) {
          const row = balanceCache[pfId][coinId][addr];
          if (!row) continue;
          // Keep last good balance even if currently errored
          if (row.balance != null && Number.isFinite(row.balance)) {
            balances[pfId][coinId][addr] = {
              balance: row.balance,
              error: null,
              loading: false,
            };
          }
        }
      }
    }
    localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({
        prices,
        balances,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* quota / private mode */
  }
}

function anyBalancesLoading() {
  for (const pfId of Object.keys(balanceCache)) {
    for (const coinId of Object.keys(balanceCache[pfId] || {})) {
      for (const addr of Object.keys(balanceCache[pfId][coinId] || {})) {
        if (balanceCache[pfId][coinId][addr]?.loading) return true;
      }
    }
  }
  return false;
}

/** Show/hide the global top-right spinner while any network work is in flight. */
function updateGlobalSpinner() {
  const el = document.getElementById("global-spinner");
  if (!el) return;
  const busy = refreshInFlight || chartLoading || anyBalancesLoading();
  el.hidden = !busy;
  el.setAttribute("aria-hidden", busy ? "false" : "true");
  document.body.classList.toggle("is-data-loading", busy);
}

/** Navigation stack state */
let nav = {
  view: "home", // home | portfolio | asset | add-coin | settings
  portfolioId: null,
  coinId: null,
};

let modalMode = null; // 'create' | 'rename' | null
let toastTimer = null;

// ── Storage ────────────────────────────────────────────────────────────────

function uid() {
  return crypto.randomUUID?.() || `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @returns {{
 *   addresses: string[],
 *   manual: { id: string, amount: number, label: string, unitPrice: number|null }[],
 *   costBasisUsd: number
 * }}
 */
function emptyCoinHolding() {
  return { addresses: [], manual: [], costBasisUsd: 0 };
}

function emptyHoldings() {
  const h = {};
  for (const c of COINS) h[c.id] = emptyCoinHolding();
  return h;
}

function parseOptionalUsd(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[$,\s]/g, "").trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** Normalize legacy array or partial object → { addresses, manual, costBasisUsd } */
function normalizeCoinHolding(raw) {
  // Legacy: string[] of addresses only
  if (Array.isArray(raw)) {
    return {
      addresses: raw.map(String).filter(Boolean),
      manual: [],
      costBasisUsd: 0,
    };
  }
  if (raw && typeof raw === "object") {
    const addresses = Array.isArray(raw.addresses)
      ? raw.addresses.map(String).filter(Boolean)
      : [];
    let manual = [];
    if (Array.isArray(raw.manual)) {
      manual = raw.manual
        .map((m) => {
          const unitPrice =
            m.unitPrice != null && Number.isFinite(Number(m.unitPrice)) && Number(m.unitPrice) >= 0
              ? Number(m.unitPrice)
              : m.pricePaid != null && Number.isFinite(Number(m.pricePaid)) && Number(m.pricePaid) >= 0
                ? Number(m.pricePaid)
                : null;
          const feePct = normalizeExchangeFeePct(m.feePct);
          let costUsd = Number(m.costUsd);
          if (!Number.isFinite(costUsd) || costUsd < 0) {
            costUsd = unitPrice != null ? manualLotCost(Number(m.amount), unitPrice, feePct) : null;
          }
          return {
            id: m.id || uid(),
            amount: Number(m.amount),
            label: String(m.label || "").slice(0, 40),
            unitPrice,
            feePct,
            costUsd: costUsd != null && Number.isFinite(costUsd) ? costUsd : null,
          };
        })
        .filter((m) => Number.isFinite(m.amount) && m.amount > 0);
    } else if (raw.manual != null && Number(raw.manual) > 0) {
      // Single number form
      manual = [{ id: uid(), amount: Number(raw.manual), label: "", unitPrice: null, feePct: 0, costUsd: null }];
    }

    let costBasisUsd = Number(raw.costBasisUsd);
    if (!Number.isFinite(costBasisUsd) || costBasisUsd < 0) {
      // Derive from avgBuyPrice if present (legacy/export field)
      const avg = Number(raw.avgBuyPrice);
      costBasisUsd = 0;
      if (Number.isFinite(avg) && avg > 0) {
        const qty = manual.reduce((s, m) => s + m.amount, 0);
        if (qty > 0) costBasisUsd = avg * qty;
      } else {
        // Sum known manual lots (include fee when stored)
        costBasisUsd = manual.reduce((s, m) => {
          if (m.costUsd != null) return s + m.costUsd;
          if (m.unitPrice != null) return s + (manualLotCost(m.amount, m.unitPrice, m.feePct) || 0);
          return s;
        }, 0);
      }
    }

    return { addresses, manual, costBasisUsd };
  }
  return emptyCoinHolding();
}

function normalizePortfolio(pf) {
  const holdings = emptyHoldings();
  const src = pf.holdings || {};
  for (const c of COINS) {
    holdings[c.id] = normalizeCoinHolding(src[c.id]);
  }
  return {
    id: pf.id || uid(),
    name: pf.name || "Portfolio",
    createdAt: pf.createdAt || Date.now(),
    // When true, this portfolio is counted in the home “Current balance”
    includeInTotal: pf.includeInTotal !== false,
    holdings,
  };
}

function getCoinHolding(pf, coinId) {
  if (!pf.holdings[coinId] || Array.isArray(pf.holdings[coinId])) {
    pf.holdings[coinId] = normalizeCoinHolding(pf.holdings[coinId]);
  }
  const h = pf.holdings[coinId];
  if (!Array.isArray(h.addresses)) h.addresses = [];
  if (!Array.isArray(h.manual)) h.manual = [];
  if (!Number.isFinite(h.costBasisUsd) || h.costBasisUsd < 0) h.costBasisUsd = 0;
  return h;
}

function normalizeExchangeFeePct(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, Math.round(n * 10000) / 10000);
}

function getExchangeFeePct() {
  return normalizeExchangeFeePct(store.exchangeFeePct);
}

function setExchangeFeePct(raw) {
  store.exchangeFeePct = normalizeExchangeFeePct(raw);
  saveStore();
  return store.exchangeFeePct;
}

/** Effective lot cost including exchange fee (%). */
function manualLotCost(amount, unitPrice, feePct) {
  if (unitPrice == null || !Number.isFinite(unitPrice)) return null;
  const fee = normalizeExchangeFeePct(feePct);
  return amount * unitPrice * (1 + fee / 100);
}

function defaultStore() {
  const id = uid();
  return {
    version: 2,
    activePortfolioId: id,
    exchangeFeePct: 0,
    portfolios: [
      {
        id,
        name: "Main",
        createdAt: Date.now(),
        includeInTotal: true,
        holdings: emptyHoldings(),
      },
    ],
  };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.portfolios?.length) {
        parsed.portfolios = parsed.portfolios.map(normalizePortfolio);
        parsed.exchangeFeePct = normalizeExchangeFeePct(parsed.exchangeFeePct);
        return parsed;
      }
    }
  } catch {
    /* fall through */
  }

  // Migrate legacy single-address map
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const map = JSON.parse(legacy);
      const id = uid();
      const holdings = emptyHoldings();
      for (const c of COINS) {
        if (Array.isArray(map[c.id])) {
          holdings[c.id] = {
            addresses: map[c.id].map(String).filter(Boolean),
            manual: [],
            costBasisUsd: 0,
          };
        }
      }
      const migrated = {
        exchangeFeePct: 0,
        version: 2,
        activePortfolioId: id,
        portfolios: [{ id, name: "Main", createdAt: Date.now(), includeInTotal: true, holdings }],
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch {
    /* fall through */
  }

  const s = defaultStore();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  return s;
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function getPortfolio(id) {
  return store.portfolios.find((p) => p.id === id) || null;
}

function getActivePortfolio() {
  if (nav.portfolioId) return getPortfolio(nav.portfolioId);
  if (store.activePortfolioId) return getPortfolio(store.activePortfolioId);
  return store.portfolios[0] || null;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatUsd(n, digits) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  let max = digits;
  if (max == null) {
    max = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: max,
  }).format(n);
}

function formatAmt(n, symbol) {
  if (n == null || Number.isNaN(n)) return `— ${symbol}`;
  const abs = Math.abs(n);
  let digits = 8;
  if (abs >= 1000) digits = 2;
  else if (abs >= 1) digits = 4;
  else if (abs >= 0.01) digits = 6;
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(n)} ${symbol}`;
}

function formatPct(pct) {
  if (pct == null || Number.isNaN(pct)) return { text: "—", cls: "neutral" };
  const sign = pct > 0 ? "+" : "";
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "neutral";
  return { text: `${sign}${pct.toFixed(2)}%`, cls };
}

function formatChangeUsd(usd, pct) {
  if (usd == null || Number.isNaN(usd)) return { text: "—", cls: "neutral" };
  const sign = usd > 0 ? "+" : usd < 0 ? "" : "";
  const pctPart = pct != null && !Number.isNaN(pct) ? ` (${usd >= 0 ? "+" : ""}${pct.toFixed(2)}%)` : "";
  const cls = usd > 0 ? "up" : usd < 0 ? "down" : "neutral";
  return { text: `${sign}${formatUsd(usd)}${pctPart}`, cls };
}

function iconContrast(hex) {
  const c = hex.replace("#", "");
  if (c.length < 6) return "#fff";
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.55 ? "#fff" : "#0d1421";
}

/** HTML for a coin avatar using official brand color + symbol. */
function coinAvatarHtml(coin, { lg = false } = {}) {
  const cls = lg ? "coin-avatar lg" : "coin-avatar";
  const bg = coin?.color || "#3861fb";
  const fg = iconContrast(bg);
  return `<div class="${cls}" style="background:${bg};color:${fg}" title="${escapeHtml(coin?.symbol || "")}">${escapeHtml((coin?.symbol || "?").slice(0, 4))}</div>`;
}

/** Fill an existing avatar element with brand color + symbol. */
function setCoinAvatarEl(el, coin) {
  if (!el || !coin) return;
  el.classList.add("coin-avatar");
  el.classList.remove("has-logo", "logo-fill");
  el.innerHTML = "";
  el.style.background = coin.color || "#3861fb";
  el.style.color = iconContrast(coin.color || "#3861fb");
  el.textContent = coin.symbol.slice(0, 4);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── HTTP / balances ────────────────────────────────────────────────────────

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 100)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonRetry(url, options = {}, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchJson(url, options);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (!/HTTP 5\d\d|Failed to fetch|NetworkError|aborted/i.test(msg) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function satsToCoin(sats, decimals) {
  return Number(sats) / 10 ** decimals;
}

async function fetchBtcBalance(address) {
  const data = await fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(address)}`);
  const funded = data?.chain_stats?.funded_txo_sum ?? 0;
  const spent = data?.chain_stats?.spent_txo_sum ?? 0;
  const memFunded = data?.mempool_stats?.funded_txo_sum ?? 0;
  const memSpent = data?.mempool_stats?.spent_txo_sum ?? 0;
  return satsToCoin(funded - spent + memFunded - memSpent, 8);
}

async function fetchLtcBalance(address) {
  try {
    const data = await fetchJson(`https://litecoinspace.org/api/address/${encodeURIComponent(address)}`);
    const funded = data?.chain_stats?.funded_txo_sum ?? 0;
    const spent = data?.chain_stats?.spent_txo_sum ?? 0;
    return satsToCoin(funded - spent, 8);
  } catch {
    const data = await fetchJson(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${encodeURIComponent(address)}/balance`
    );
    return satsToCoin(data.balance ?? data.final_balance ?? 0, 8);
  }
}

async function fetchDogeBalance(address) {
  try {
    const data = await fetchJson(
      `https://api.blockcypher.com/v1/doge/main/addrs/${encodeURIComponent(address)}/balance`
    );
    return satsToCoin(data.balance ?? data.final_balance ?? 0, 8);
  } catch {
    const data = await fetchJson(
      `https://dogechain.info/api/v1/address/balance/${encodeURIComponent(address)}`
    );
    if (data?.success === 0) throw new Error(data.error || "DOGE lookup failed");
    return Number(data.balance);
  }
}

async function fetchXrpBalance(address) {
  const data = await fetchJson("https://xrplcluster.com/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated", strict: true }],
    }),
  });
  if (data?.result?.error === "actNotFound") return 0;
  if (data?.result?.error) throw new Error(data.result.error_message || data.result.error);
  const drops = data?.result?.account_data?.Balance;
  if (drops == null) throw new Error("No XRP balance");
  return Number(drops) / 1e6;
}

async function fetchXlmBalance(address) {
  try {
    const data = await fetchJson(`https://horizon.stellar.org/accounts/${encodeURIComponent(address)}`);
    const native = (data.balances || []).find((b) => b.asset_type === "native");
    return Number(native?.balance ?? 0);
  } catch (err) {
    if (String(err.message).includes("404")) return 0;
    throw err;
  }
}

async function fetchHbarBalance(address) {
  const data = await fetchJsonRetry(
    `https://mainnet-public.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(address)}`
  );
  const tinybars = data?.balance?.balance ?? data?.balance ?? 0;
  return Number(tinybars) / 1e8;
}

async function fetchAdaBalance(address) {
  const data = await fetchJsonRetry("https://api.koios.rest/api/v1/address_info", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ _addresses: [address] }),
  });
  if (!Array.isArray(data) || data.length === 0) return 0;
  return Number(data[0].balance ?? 0) / 1e6;
}

async function fetchNightBalance(address) {
  const data = await fetchJsonRetry("https://api.koios.rest/api/v1/address_assets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ _addresses: [address] }),
  });
  if (!Array.isArray(data) || data.length === 0) return 0;
  let raw = 0;
  let decimals = 6;
  for (const row of data) {
    const assets = Array.isArray(row.asset_list) ? row.asset_list : [row];
    for (const asset of assets) {
      const policy = String(asset.policy_id || "").toLowerCase();
      const nameHex = String(asset.asset_name || "").toLowerCase();
      if (policy === NIGHT_POLICY_ID && (nameHex === NIGHT_ASSET_NAME || nameHex === "night")) {
        raw += Number(asset.quantity || 0);
        if (asset.decimals != null) decimals = Number(asset.decimals);
      }
    }
  }
  return raw / 10 ** decimals;
}

async function fetchPrices() {
  const ids = COINS.map((c) => c.geckoId).join(",");
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`
  );
  const next = { ...prices };
  let any = false;
  for (const coin of COINS) {
    const row = data[coin.geckoId];
    if (row && row.usd != null && Number.isFinite(Number(row.usd))) {
      next[coin.id] = {
        usd: Number(row.usd),
        change24h: Number(row.usd_24h_change) || 0,
      };
      any = true;
    }
    // If this coin is missing from the response, keep previous price
  }
  if (any) prices = next;
}

const CHART_CACHE_MS = 5 * 60 * 1000;

const CHART_RANGES = {
  "1": { label: "24H", days: "1", spanMs: 24 * 3600 * 1000 },
  "7": { label: "7D", days: "7", spanMs: 7 * 24 * 3600 * 1000 },
  "30": { label: "30D", days: "30", spanMs: 30 * 24 * 3600 * 1000 },
  "90": { label: "90D", days: "90", spanMs: 90 * 24 * 3600 * 1000 },
  max: { label: "ALL", days: "max", spanMs: 10 * 365 * 24 * 3600 * 1000 },
};

function chartCacheKey(coinId, days) {
  return `${coinId}:${days}`;
}

function rangeSpanMs(days) {
  return CHART_RANGES[days]?.spanMs ?? 24 * 3600 * 1000;
}

/** Fetch (or reuse) price series for a coin from CoinGecko for the given days. */
async function fetchCoinChart(coinId, days = "1") {
  const coin = COIN_BY_ID[coinId];
  if (!coin) return [];
  const key = chartCacheKey(coinId, days);
  const cached = chartCache[key];
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_MS && cached.points?.length) {
    return cached.points;
  }

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = await fetchJson(
        `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.geckoId)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`,
        {},
        20000
      );
      const points = Array.isArray(data?.prices)
        ? data.prices
            .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
            .map((p) => /** @type {[number, number]} */ ([p[0], p[1]]))
        : [];
      if (points.length) {
        chartCache[key] = { fetchedAt: Date.now(), points };
        return points;
      }
      lastErr = new Error("Empty chart data");
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      if (/429/.test(msg)) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      else if (attempt === 0) await new Promise((r) => setTimeout(r, 300));
    }
  }
  // Stale cache is better than nothing
  if (cached?.points?.length) return cached.points;
  throw lastErr || new Error("Chart fetch failed");
}

/**
 * Build a portfolio USD value series using current balances × historical prices.
 * @param {{ coinId: string, balance: number }[]} holdings
 * @param {string} days
 * @returns {Promise<{ series: { t: number, v: number }[], partial: boolean, failed: number }>}
 */
async function buildPortfolioSeries(holdings, days = "1") {
  const active = (holdings || []).filter((h) => h.balance > 0 && COIN_BY_ID[h.coinId]);
  if (!active.length) return { series: [], partial: false, failed: 0 };

  const seriesByCoin = {};
  let failed = 0;
  await runPool(
    active.map((h) => async () => {
      try {
        seriesByCoin[h.coinId] = await fetchCoinChart(h.coinId, days);
      } catch {
        const stale = chartCache[chartCacheKey(h.coinId, days)]?.points;
        if (stale?.length) seriesByCoin[h.coinId] = stale;
        else {
          seriesByCoin[h.coinId] = [];
          failed += 1;
        }
      }
    }),
    2
  );

  // Common timeline from the densest successful series
  let timeline = [];
  for (const h of active) {
    const pts = seriesByCoin[h.coinId] || [];
    if (pts.length > timeline.length) timeline = pts.map((p) => p[0]);
  }

  if (timeline.length < 2) {
    if (failed === active.length) {
      return { series: [], partial: false, failed };
    }
    // Soft fallback only when we have prices but empty charts
    const total = active.reduce((s, h) => s + h.balance * (prices[h.coinId]?.usd || 0), 0);
    const now = Date.now();
    return {
      series: [
        { t: now - rangeSpanMs(days), v: total },
        { t: now, v: total },
      ],
      partial: failed > 0,
      failed,
    };
  }

  function priceAt(points, ts) {
    if (!points?.length) return null;
    let lo = 0;
    let hi = points.length - 1;
    if (ts <= points[0][0]) return points[0][1];
    if (ts >= points[hi][0]) return points[hi][1];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const mt = points[mid][0];
      if (mt === ts) return points[mid][1];
      if (mt < ts) lo = mid + 1;
      else hi = mid - 1;
    }
    const i = Math.max(0, Math.min(points.length - 1, lo));
    const a = points[Math.max(0, i - 1)];
    const b = points[i];
    if (!a || !b) return b?.[1] ?? a?.[1] ?? null;
    if (b[0] === a[0]) return b[1];
    const w = (ts - a[0]) / (b[0] - a[0]);
    return a[1] + (b[1] - a[1]) * w;
  }

  const out = [];
  for (const t of timeline) {
    let v = 0;
    let ok = false;
    for (const h of active) {
      const px = priceAt(seriesByCoin[h.coinId], t);
      if (px == null) continue;
      v += h.balance * px;
      ok = true;
    }
    if (ok) out.push({ t, v });
  }
  return { series: out, partial: failed > 0, failed };
}

/**
 * Draw an area chart into an SVG element.
 * @param {SVGElement} svg
 * @param {{ t: number, v: number }[]} series
 */
function renderSparkline(svg, series) {
  if (!svg) return false;
  if (!series || series.length < 2) {
    svg.innerHTML = "";
    return false;
  }

  const W = 320;
  const H = 96;
  const padX = 0;
  const padY = 6;
  const vals = series.map((p) => p.v);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min *= 0.99;
    max *= 1.01;
    if (min === 0 && max === 0) {
      min = -1;
      max = 1;
    }
  }
  const first = series[0].v;
  const last = series[series.length - 1].v;
  const up = last >= first;
  const stroke = up ? "#16c784" : "#ea3943";
  const fillId = `chartFill_${svg.id || "main"}`;

  const xAt = (i) => padX + (i / (series.length - 1)) * (W - padX * 2);
  const yAt = (v) => padY + (1 - (v - min) / (max - min)) * (H - padY * 2);

  let line = "";
  for (let i = 0; i < series.length; i++) {
    const x = xAt(i);
    const y = yAt(series[i].v);
    line += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  const yBase = H;
  const area =
    line +
    ` L ${xAt(series.length - 1).toFixed(2)} ${yBase} L ${xAt(0).toFixed(2)} ${yBase} Z`;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${fillId})" />
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  `;
  return true;
}

let chartRenderToken = 0;

/** @param {"loading"|"error"|"empty"|"ok"|"partial"} state */
function setChartOverlay(state, message) {
  const overlay = document.getElementById("home-chart-overlay");
  const spinner = document.getElementById("home-chart-spinner");
  const status = document.getElementById("home-chart-status");
  const retry = document.getElementById("home-chart-retry");
  const wrap = document.getElementById("home-chart-wrap");
  if (!overlay) return;

  const show = state !== "ok";
  overlay.hidden = !show;
  overlay.classList.toggle("is-error", state === "error");
  overlay.classList.toggle("is-loading", state === "loading");
  overlay.classList.toggle("is-partial", state === "partial");
  if (wrap) {
    wrap.classList.toggle("is-loading", state === "loading");
    wrap.classList.toggle("has-error", state === "error" || state === "empty");
  }

  if (spinner) spinner.hidden = state !== "loading";
  if (retry) retry.hidden = state !== "error";
  if (status) status.textContent = message || "";
}

function syncChartTabs() {
  document.querySelectorAll("#home-chart-tabs .chart-tab").forEach((btn) => {
    const active = btn.dataset.range === chartRange;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

/** Load and paint the dashboard portfolio chart for the selected range. */
async function updateHomeChart(allocRows, { force } = {}) {
  const svg = document.getElementById("home-chart");
  if (!svg) return;

  const holdings =
    allocRows != null
      ? (allocRows || [])
          .filter((r) => r.balance > 0)
          .map((r) => ({ coinId: r.coinId, balance: r.balance }))
      : lastChartHoldings;

  lastChartHoldings = holdings;
  syncChartTabs();

  if (!holdings.length) {
    svg.innerHTML = "";
    chartLoading = false;
    updateGlobalSpinner();
    setChartOverlay("empty", "Add holdings to see the chart");
    return;
  }

  const token = ++chartRenderToken;
  const rangeLabel = CHART_RANGES[chartRange]?.label || "24H";
  chartLoading = true;
  updateGlobalSpinner();
  setChartOverlay("loading", `Loading ${rangeLabel} chart…`);
  // Keep previous SVG visible under dimmed overlay while loading (unless forced clear)
  if (force) svg.innerHTML = "";

  try {
    const { series, partial, failed } = await buildPortfolioSeries(holdings, chartRange);
    if (token !== chartRenderToken) return;

    const ok = renderSparkline(svg, series);
    if (!ok) {
      setChartOverlay("error", "Chart didn’t load. Pull to refresh or retry.");
      return;
    }
    if (partial && failed > 0) {
      setChartOverlay(
        "partial",
        failed === 1 ? "Partial data — 1 coin missing" : `Partial data — ${failed} coins missing`
      );
      // Auto-hide partial banner after a moment so chart stays readable
      setTimeout(() => {
        if (token === chartRenderToken) setChartOverlay("ok");
      }, 2200);
    } else {
      setChartOverlay("ok");
    }
  } catch (err) {
    if (token !== chartRenderToken) return;
    // Keep previous SVG if we had one; only clear when empty
    if (!svg.innerHTML.trim()) svg.innerHTML = "";
    const msg = /429|Rate/.test(String(err?.message || err))
      ? "Rate limited — try again in a moment"
      : "Chart didn’t load. Tap retry.";
    setChartOverlay("error", msg);
  } finally {
    if (token === chartRenderToken) {
      chartLoading = false;
      updateGlobalSpinner();
    }
  }
}

function humanizeError(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError|TypeError/i.test(msg)) return "Network error";
  if (/aborted|AbortError/i.test(msg)) return "Timed out";
  if (/404/.test(msg)) return "Not found";
  if (/429/.test(msg)) return "Rate limited";
  return msg.slice(0, 100);
}

// ── Portfolio math ─────────────────────────────────────────────────────────

function ensureCacheSlot(pfId, coinId, addr) {
  if (!balanceCache[pfId]) balanceCache[pfId] = {};
  if (!balanceCache[pfId][coinId]) balanceCache[pfId][coinId] = {};
  if (!balanceCache[pfId][coinId][addr]) {
    balanceCache[pfId][coinId][addr] = { balance: null, error: null, loading: false };
  }
  return balanceCache[pfId][coinId][addr];
}

/**
 * Combined balance for a coin in a portfolio:
 * on-chain address balances + all manual amounts.
 */
function coinBalanceInPortfolio(pf, coinId) {
  const holding = getCoinHolding(pf, coinId);
  const addrs = holding.addresses;
  const manualEntries = holding.manual;

  let onchain = 0;
  let onchainLoaded = false;
  let onchainPending = false;
  for (const addr of addrs) {
    const st = balanceCache[pf.id]?.[coinId]?.[addr];
    if (st?.loading) onchainPending = true;
    if (st && st.balance != null && !st.error) {
      onchain += st.balance;
      onchainLoaded = true;
    }
  }

  const manual = manualEntries.reduce((s, m) => s + (Number(m.amount) || 0), 0);
  const hasManual = manual > 0;
  const hasAddresses = addrs.length > 0;

  // Total uses loaded on-chain data when available; if addresses exist but none loaded yet, still include manual
  const onchainPart = onchainLoaded ? onchain : 0;
  const balance = onchainPart + manual;
  const hasData = onchainLoaded || hasManual;
  const sourceCount = addrs.length + manualEntries.length;

  return {
    balance,
    onchain: onchainPart,
    manual,
    hasData,
    hasManual,
    hasAddresses,
    onchainLoaded,
    onchainPending,
    addrCount: addrs.length,
    manualCount: manualEntries.length,
    sourceCount,
  };
}

function portfolioHasCoin(pf, coinId) {
  const h = getCoinHolding(pf, coinId);
  return h.addresses.length > 0 || h.manual.length > 0;
}

/**
 * Cost basis / avg buy / unrealized P/L for a coin in a portfolio.
 * Avg buy = costBasisUsd / current balance (when both set).
 */
function costBasisInfo(pf, coinId) {
  const holding = getCoinHolding(pf, coinId);
  const balInfo = coinBalanceInPortfolio(pf, coinId);
  const balance = balInfo.hasData ? balInfo.balance : 0;
  const cost = Number(holding.costBasisUsd) || 0;
  const avg = balance > 0 && cost > 0 ? cost / balance : null;
  const px = prices[coinId]?.usd ?? 0;
  const market = balance * px;
  const pl = cost > 0 ? market - cost : null;
  const plPct = cost > 0 && Number.isFinite(pl) ? (pl / cost) * 100 : null;
  return { cost, avg, market, pl, plPct, balance };
}

/** Set average buy price → cost basis = avg × current holdings. */
function setAvgBuyPrice(pf, coinId, avgRaw) {
  const holding = getCoinHolding(pf, coinId);
  const avg = parseOptionalUsd(avgRaw);
  if (avg == null || avg <= 0) {
    toast("Enter a valid average buy price", "error");
    return false;
  }
  const bal = coinBalanceInPortfolio(pf, coinId);
  const qty = bal.hasData ? bal.balance : 0;
  if (qty <= 0) {
    toast("Add a holding amount first", "error");
    return false;
  }
  holding.costBasisUsd = avg * qty;
  saveStore();
  return true;
}

/** Set total cost basis USD → implies avg = cost / holdings. */
function setCostBasisUsd(pf, coinId, costRaw) {
  const holding = getCoinHolding(pf, coinId);
  const cost = parseOptionalUsd(costRaw);
  if (cost == null) {
    toast("Enter a valid cost basis", "error");
    return false;
  }
  holding.costBasisUsd = cost;
  saveStore();
  return true;
}

/** Clear cost basis for a coin. */
function clearCostBasis(pf, coinId) {
  const holding = getCoinHolding(pf, coinId);
  holding.costBasisUsd = 0;
  saveStore();
}

function portfolioTotals(pf) {
  let totalUsd = 0;
  let totalPrev = 0;
  let assets = 0;
  let sourceCount = 0;
  /** @type {{ coinId: string, balance: number, usd: number, change24h: number, alloc: number }[]} */
  const rows = [];

  for (const coin of COINS) {
    if (!portfolioHasCoin(pf, coin.id)) continue;
    const info = coinBalanceInPortfolio(pf, coin.id);
    sourceCount += info.sourceCount;
    assets += 1;
    const px = prices[coin.id]?.usd ?? 0;
    const ch = prices[coin.id]?.change24h ?? 0;
    const usd = (info.hasData ? info.balance : 0) * px;
    totalUsd += usd;
    const prev = ch === -100 ? 0 : usd / (1 + ch / 100);
    totalPrev += Number.isFinite(prev) ? prev : usd;
    rows.push({
      coinId: coin.id,
      balance: info.hasData ? info.balance : 0,
      usd,
      change24h: ch,
      alloc: 0,
    });
  }

  for (const r of rows) {
    r.alloc = totalUsd > 0 ? (r.usd / totalUsd) * 100 : 0;
  }
  rows.sort((a, b) => b.usd - a.usd);

  const changeUsd = totalUsd - totalPrev;
  const changePct = totalPrev > 0 ? (changeUsd / totalPrev) * 100 : null;

  return { totalUsd, changeUsd, changePct, assets, addrCount: sourceCount, sourceCount, rows };
}

function isIncludedInTotal(pf) {
  return pf.includeInTotal !== false;
}

function allPortfoliosTotals() {
  let totalUsd = 0;
  let changeUsd = 0;
  let weightedPrev = 0;
  let includedCount = 0;
  let excludedCount = 0;

  const perPf = store.portfolios.map((pf) => {
    const t = portfolioTotals(pf);
    const included = isIncludedInTotal(pf);
    if (included) {
      totalUsd += t.totalUsd;
      changeUsd += t.changeUsd;
      weightedPrev += t.totalUsd - t.changeUsd;
      includedCount += 1;
    } else {
      excludedCount += 1;
    }
    return { pf, included, ...t };
  });

  const changePct = weightedPrev > 0 ? (changeUsd / weightedPrev) * 100 : null;

  // Allocation + coin balances only from portfolios included in the main total
  const byCoin = {};
  for (const item of perPf) {
    if (!item.included) continue;
    for (const r of item.rows) {
      if (!byCoin[r.coinId]) byCoin[r.coinId] = { usd: 0, balance: 0 };
      byCoin[r.coinId].usd += r.usd;
      byCoin[r.coinId].balance += r.balance;
    }
  }
  const allocRows = Object.entries(byCoin)
    .map(([coinId, { usd, balance }]) => ({
      coinId,
      usd,
      balance,
      alloc: totalUsd > 0 ? (usd / totalUsd) * 100 : 0,
    }))
    .sort((a, b) => b.usd - a.usd);

  return { totalUsd, changeUsd, changePct, perPf, allocRows, includedCount, excludedCount };
}

// ── Refresh ────────────────────────────────────────────────────────────────

async function refreshBalance(pfId, coinId, addr) {
  const coin = COIN_BY_ID[coinId];
  const slot = ensureCacheSlot(pfId, coinId, addr);
  // Keep previous balance visible while refreshing (don't zero out)
  slot.loading = true;
  updateGlobalSpinner();
  try {
    const bal = await coin.fetchBalance(addr);
    if (bal != null && Number.isFinite(Number(bal))) {
      slot.balance = Number(bal);
      slot.error = null;
    } else {
      // Keep last good balance; surface a soft error
      slot.error = slot.balance != null ? null : "No balance";
    }
  } catch (err) {
    // On failure keep last known balance so totals don't flash to $0
    slot.error = humanizeError(err);
  } finally {
    slot.loading = false;
    updateGlobalSpinner();
  }
}

async function runPool(fns, concurrency = 4) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, fns.length) }, async () => {
      while (i < fns.length) {
        const fn = fns[i++];
        await fn();
      }
    })
  );
}

let refreshInFlight = false;

async function refreshAll({ fromPull } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  updateGlobalSpinner();

  if (fromPull) {
    setPtrOffset(PTR.holdOffset, { mode: "refreshing" });
  }

  try {
    try {
      await fetchPrices();
      // Re-render with new prices while balances still show last known values
      render();
    } catch (err) {
      toast(`Prices: ${humanizeError(err)}`, "error");
      // Keep prior prices — do not wipe to zero
    }

    // Allow pull-to-refresh to pull fresh 24h series
    chartCache = {};

    const jobs = [];
    for (const pf of store.portfolios) {
      for (const coin of COINS) {
        const holding = getCoinHolding(pf, coin.id);
        for (const addr of holding.addresses) {
          // Mark loading but keep existing balance for display
          const slot = ensureCacheSlot(pf.id, coin.id, addr);
          slot.loading = true;
          jobs.push(() => refreshBalance(pf.id, coin.id, addr));
        }
      }
    }

    updateGlobalSpinner();
    if (jobs.length) {
      render(); // loading flags on, values still from last snapshot
      await runPool(jobs, 4);
    }

    saveMarketSnapshot();
    render();
    toast("Updated", "success");
  } finally {
    refreshInFlight = false;
    updateGlobalSpinner();
    // Always fully settle PTR so the screen never stays half-scrolled
    resetPtrVisual({ animate: fromPull });
  }
}

// ── Pull to refresh (CMC-style) ────────────────────────────────────────────
// Scroll is the default. PTR only engages when:
//   1) content is already at the top, AND
//   2) the finger pulls DOWN past an activation dead-zone.
// Normal scroll (finger up / content move) is never stolen.

const PTR = {
  /** Finger must pull this far past top before we claim the gesture (px). */
  activateAt: 18,
  /** Finger pull distance to arm refresh on release (px). */
  threshold: 90,
  /** Visual hold while refreshing (px). */
  holdOffset: 52,
  /** Max visual pull (px). */
  maxVisual: 120,
  startY: 0,
  startX: 0,
  /** Touch began at top of list — candidate for PTR. */
  canPull: false,
  /** We've claimed this gesture (preventDefault + rubber band). */
  active: false,
  armed: false,
  distance: 0,
  offset: 0,
};

function getViewsEl() {
  return document.getElementById("views");
}

function isAtScrollTop(el) {
  // Allow 1px of iOS subpixel / bounce noise
  return !!el && el.scrollTop <= 1;
}

/** Rubber-band visual distance from finger travel (diminishing). */
function ptrVisualFromPull(pullPx) {
  if (pullPx <= 0) return 0;
  // Soft spring: never jumps to max instantly
  const v = PTR.maxVisual * (1 - Math.exp(-pullPx / 95));
  return Math.min(PTR.maxVisual, v);
}

function setPtrCssOffset(px) {
  const views = getViewsEl();
  const val = `${Math.max(0, px || 0)}px`;
  document.documentElement.style.setProperty("--ptr-offset", val);
  if (views) views.style.setProperty("--ptr-offset", val);
}

function setPtrOffset(px, { mode } = {}) {
  const ptr = document.getElementById("ptr-indicator");
  const ptrIcon = document.getElementById("ptr-icon");
  const ptrLabel = document.getElementById("ptr-label");
  if (!ptr) return;

  const offset = Math.max(0, px || 0);
  PTR.offset = offset;
  setPtrCssOffset(offset);

  const show = offset > 1 || mode === "refreshing";
  ptr.classList.toggle("visible", show);
  ptr.classList.toggle("refreshing", mode === "refreshing");
  ptr.setAttribute("aria-hidden", show ? "false" : "true");

  if (mode === "refreshing") {
    ptr.classList.remove("armed");
    PTR.armed = false;
    if (ptrIcon) ptrIcon.textContent = "↻";
    if (ptrLabel) ptrLabel.textContent = "Refreshing…";
    return;
  }

  PTR.armed = PTR.distance >= PTR.threshold;
  ptr.classList.toggle("armed", PTR.armed && !refreshInFlight);

  if (!refreshInFlight) {
    if (ptrIcon) ptrIcon.textContent = "↓";
    if (ptrLabel) {
      ptrLabel.textContent = PTR.armed ? "Release to refresh" : "Pull to refresh";
    }
  }
}

function clearPtrStateFlags() {
  PTR.canPull = false;
  PTR.active = false;
  PTR.armed = false;
  PTR.distance = 0;
}

function resetPtrVisual({ animate } = {}) {
  const views = getViewsEl();
  const ptr = document.getElementById("ptr-indicator");
  const current = PTR.offset || 0;

  clearPtrStateFlags();
  PTR.offset = 0;

  const finishClear = () => {
    if (views) {
      views.classList.remove("ptr-animating", "ptr-active");
      views.style.transform = "";
      views.style.removeProperty("--ptr-offset");
      // Hard-settle scroll if iOS left a rubber-band
      if (views.scrollTop < 0) views.scrollTop = 0;
    }
    document.documentElement.style.removeProperty("--ptr-offset");
    if (ptr) {
      ptr.classList.remove("visible", "armed", "refreshing");
      ptr.style.transform = "";
      ptr.setAttribute("aria-hidden", "true");
      const ptrIcon = document.getElementById("ptr-icon");
      const ptrLabel = document.getElementById("ptr-label");
      if (ptrIcon) ptrIcon.textContent = "↓";
      if (ptrLabel) ptrLabel.textContent = "Pull to refresh";
    }
  };

  if (animate && current > 1) {
    if (views) views.classList.add("ptr-animating");
    setPtrCssOffset(current);
    void (views && views.offsetHeight);
    setPtrCssOffset(0);
    let done = false;
    const onEnd = () => {
      if (done) return;
      done = true;
      finishClear();
    };
    if (views) views.addEventListener("transitionend", onEnd, { once: true });
    setTimeout(onEnd, 280);
  } else {
    finishClear();
  }
}

function abandonPullGesture() {
  if (PTR.active || PTR.offset > 0) {
    resetPtrVisual({ animate: false });
  } else {
    clearPtrStateFlags();
  }
}

function wirePullToRefresh() {
  const views = getViewsEl();
  if (!views) return;

  views.addEventListener(
    "touchstart",
    (e) => {
      if (refreshInFlight) {
        abandonPullGesture();
        return;
      }
      const t = e.touches[0];
      PTR.startY = t.clientY;
      PTR.startX = t.clientX;
      PTR.distance = 0;
      PTR.armed = false;
      PTR.active = false;
      // Only candidates at the very top — otherwise pure scroll
      PTR.canPull = isAtScrollTop(views);
      if (!PTR.canPull) PTR.offset = 0;
    },
    { passive: true }
  );

  views.addEventListener(
    "touchmove",
    (e) => {
      if (!PTR.canPull || refreshInFlight) return;

      const t = e.touches[0];
      const dy = t.clientY - PTR.startY; // >0 = finger down = overscroll at top
      const dx = t.clientX - PTR.startX;

      // Already scrolled away before we claimed the gesture → pure scroll
      if (!PTR.active && !isAtScrollTop(views)) {
        PTR.canPull = false;
        return;
      }

      // Horizontal pan — don't steal
      if (!PTR.active && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.1) {
        PTR.canPull = false;
        return;
      }

      // Finger moving up (content scrolls down the list) — never PTR
      if (dy <= 0) {
        if (PTR.active) {
          // User reversed; drop pull visual and release claim so scroll can resume
          setPtrOffset(0);
          PTR.active = false;
          PTR.distance = 0;
          PTR.armed = false;
          views.classList.remove("ptr-active");
        }
        return;
      }

      // Still in dead-zone: allow browser/native scroll handling, don't preventDefault
      if (!PTR.active) {
        if (dy < PTR.activateAt) return;
        // Activate only if still glued to the top
        if (!isAtScrollTop(views)) {
          PTR.canPull = false;
          return;
        }
        PTR.active = true;
        views.classList.add("ptr-active");
      }

      // Claimed pull: block scroll rubber-band, show PTR UI
      if (e.cancelable) e.preventDefault();

      // Distance past activation (pulling "way down")
      PTR.distance = dy;
      const visual = ptrVisualFromPull(Math.max(0, dy - PTR.activateAt * 0.35));
      setPtrOffset(visual);
    },
    { passive: false }
  );

  const endPull = () => {
    if (!PTR.canPull && !PTR.active) return;

    const shouldRefresh = PTR.active && PTR.armed && !refreshInFlight;
    views.classList.remove("ptr-active");

    if (shouldRefresh) {
      PTR.canPull = false;
      PTR.active = false;
      setPtrOffset(PTR.holdOffset, { mode: "refreshing" });
      refreshAll({ fromPull: true });
      return;
    }

    // Snap back; normal scroll was never blocked unless we had activated
    if (PTR.active || PTR.offset > 0) {
      resetPtrVisual({ animate: true });
    } else {
      clearPtrStateFlags();
    }
  };

  views.addEventListener("touchend", endPull, { passive: true });
  views.addEventListener("touchcancel", endPull, { passive: true });

  // If the user scrolls with wheel/trackpad, never leave a stuck pull
  views.addEventListener(
    "scroll",
    () => {
      if (!PTR.active && !isAtScrollTop(views) && PTR.canPull) {
        PTR.canPull = false;
      }
    },
    { passive: true }
  );
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function toast(msg, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? ` ${kind}` : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function renderAllocBar(el, rows) {
  el.innerHTML = "";
  if (!rows.length) return;
  for (const r of rows) {
    if (r.alloc < 0.5 && rows.length > 1) continue;
    const seg = document.createElement("div");
    seg.className = "alloc-seg";
    const coin = COIN_BY_ID[r.coinId];
    seg.style.width = `${Math.max(r.alloc, 1)}%`;
    seg.style.background = coin?.color || "#3861fb";
    seg.title = `${coin?.symbol || r.coinId}: ${r.alloc.toFixed(1)}%`;
    el.appendChild(seg);
  }
}

function setChangePill(container, changeUsd, changePct) {
  const { text, cls } = formatChangeUsd(changeUsd, changePct);
  container.innerHTML = `<span class="pill ${cls}">${text}</span><span class="muted">24h</span>`;
}

// ── Navigation ─────────────────────────────────────────────────────────────

function showView(view, { portfolioId, coinId } = {}) {
  nav.view = view;
  if (portfolioId !== undefined) nav.portfolioId = portfolioId;
  if (coinId !== undefined) nav.coinId = coinId;
  render();
}

function render() {
  // View visibility
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("view-active", v.dataset.view === nav.view);
  });

  const back = document.getElementById("btn-back");
  const settingsBtn = document.getElementById("btn-settings");
  const brand = document.getElementById("topbar-brand");
  const title = document.getElementById("topbar-title");
  const switchBtn = document.getElementById("btn-portfolio-switch");
  const topbarRight = document.querySelector(".topbar-right");

  // Same top-left slot: Settings on home only; Back everywhere else
  const isHome = nav.view === "home";
  if (settingsBtn) settingsBtn.hidden = !isHome;
  if (back) back.hidden = isHome;

  // Portfolio switch sits far right of the header (not under the brand)
  const showPfSwitch =
    nav.view === "portfolio" || nav.view === "asset" || nav.view === "add-coin";
  if (switchBtn) {
    switchBtn.hidden = !showPfSwitch;
    if (showPfSwitch) {
      const pf = getPortfolio(nav.portfolioId) || getActivePortfolio();
      document.getElementById("active-portfolio-label").textContent = pf?.name || "Portfolio";
    }
  }
  if (topbarRight) topbarRight.classList.toggle("has-switch", showPfSwitch);

  // Center: UpDown brand on home/portfolio; page title elsewhere
  if (nav.view === "home") {
    if (brand) brand.hidden = false;
    title.hidden = true;
    renderHome();
  } else if (nav.view === "portfolio") {
    if (brand) brand.hidden = false;
    title.hidden = true;
    renderPortfolio();
  } else if (nav.view === "asset") {
    if (brand) brand.hidden = true;
    title.hidden = false;
    title.textContent = COIN_BY_ID[nav.coinId]?.symbol || "Asset";
    renderAsset();
  } else if (nav.view === "add-coin") {
    if (brand) brand.hidden = true;
    title.hidden = false;
    title.textContent = "Add holding";
    renderAddCoin();
  } else if (nav.view === "settings") {
    if (brand) brand.hidden = true;
    title.hidden = false;
    title.textContent = "Settings";
    renderSettings();
  }
}

/** Dashboard: aggregated coin holdings from portfolios included in the total. */
function renderHome() {
  const { totalUsd, changeUsd, changePct, allocRows } = allPortfoliosTotals();
  document.getElementById("home-total").textContent = formatUsd(totalUsd);
  setChangePill(document.getElementById("home-change"), changeUsd, changePct);
  renderAllocBar(document.getElementById("home-alloc-bar"), allocRows);
  updateHomeChart(allocRows);

  const list = document.getElementById("home-holdings-list");
  const empty = document.getElementById("home-empty");
  list.innerHTML = "";

  const rows = (allocRows || []).filter((r) => r.balance > 0 || r.usd > 0);
  if (!rows.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const r of rows) {
    const coin = COIN_BY_ID[r.coinId];
    if (!coin) continue;
    const px = prices[coin.id]?.usd;
    const ch = prices[coin.id]?.change24h;
    const pct = formatPct(ch);

    // Loading if any included portfolio still fetching this coin
    let anyLoading = false;
    for (const pf of store.portfolios) {
      if (!isIncludedInTotal(pf)) continue;
      const holding = getCoinHolding(pf, coin.id);
      if (holding.addresses.some((a) => balanceCache[pf.id]?.[coin.id]?.[a]?.loading)) {
        anyLoading = true;
        break;
      }
    }

    const row = document.createElement("div");
    row.className = "holding-row";
    row.setAttribute("role", "row");
    row.innerHTML = `
      <div class="holding-left">
        ${coinAvatarHtml(coin)}
        <div>
          <div class="holding-name">${escapeHtml(coin.name)}</div>
          <div class="holding-symbol">${coin.symbol}</div>
        </div>
      </div>
      <div class="holding-mid">
        <div class="holding-price">${px != null ? formatUsd(px) : "—"}</div>
        <div class="holding-pct ${pct.cls}">${pct.text}</div>
      </div>
      <div class="holding-right">
        <div class="holding-value">${anyLoading && r.balance === 0 ? "…" : formatUsd(r.usd)}</div>
        <div class="holding-amount">${r.balance > 0 ? formatAmt(r.balance, coin.symbol) : "—"}</div>
      </div>
    `;
    list.appendChild(row);
  }
}

/** Settings: portfolio list + include toggles (management lives here, not on Dashboard). */
function renderSettings() {
  const feeInput = document.getElementById("settings-fee-input");
  if (feeInput && document.activeElement !== feeInput) {
    const fee = getExchangeFeePct();
    feeInput.value = fee > 0 ? String(fee) : "";
  }

  const { perPf } = allPortfoliosTotals();
  const list = document.getElementById("portfolio-list");
  const empty = document.getElementById("settings-pf-empty");
  list.innerHTML = "";

  if (!store.portfolios.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const item of perPf) {
    const { pf, totalUsd: v, changePct: cp, assets, sourceCount, included } = item;
    const pct = formatPct(cp);
    const card = document.createElement("div");
    card.className = "pf-card" + (included ? "" : " pf-card-excluded");

    card.innerHTML = `
      <button type="button" class="pf-card-main" data-open>
        <div class="pf-card-top">
          <div class="pf-card-text">
            <div class="pf-card-name">${escapeHtml(pf.name)}</div>
            <div class="pf-card-meta">${assets} asset${assets === 1 ? "" : "s"} · ${sourceCount} source${sourceCount === 1 ? "" : "s"}</div>
          </div>
          <div class="pf-card-figures">
            <div class="pf-card-value">${formatUsd(v)}</div>
            <div class="pf-card-change ${pct.cls}">${pct.text}</div>
          </div>
        </div>
      </button>
      <div class="pf-card-toggle-row">
        <span class="pf-toggle-label">${included ? "In total" : "Excluded"}</span>
        <label class="switch" title="Include in Dashboard total">
          <input type="checkbox" class="pf-include-toggle" ${included ? "checked" : ""} aria-label="Include ${escapeHtml(pf.name)} in Dashboard total" />
          <span class="switch-track" aria-hidden="true"></span>
        </label>
      </div>
    `;

    card.querySelector("[data-open]").addEventListener("click", () => {
      store.activePortfolioId = pf.id;
      saveStore();
      showView("portfolio", { portfolioId: pf.id });
    });

    card.querySelector(".pf-include-toggle").addEventListener("change", (e) => {
      e.stopPropagation();
      pf.includeInTotal = e.target.checked;
      saveStore();
      renderSettings();
      toast(e.target.checked ? `“${pf.name}” included in total` : `“${pf.name}” excluded from total`);
    });

    card.querySelector(".switch").addEventListener("click", (e) => e.stopPropagation());
    list.appendChild(card);
  }
}

function renderPortfolio() {
  const pf = getPortfolio(nav.portfolioId);
  if (!pf) {
    showView("home");
    return;
  }

  const t = portfolioTotals(pf);
  document.getElementById("pf-name-label").textContent = pf.name;
  document.getElementById("pf-total").textContent = formatUsd(t.totalUsd);
  setChangePill(document.getElementById("pf-change"), t.changeUsd, t.changePct);
  renderAllocBar(document.getElementById("pf-alloc-bar"), t.rows);
  document.getElementById("pf-asset-count").textContent = String(t.assets);
  document.getElementById("pf-addr-count").textContent = String(t.sourceCount);
  document.getElementById("pf-updated").textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  const list = document.getElementById("holdings-list");
  const empty = document.getElementById("pf-empty");
  list.innerHTML = "";

  const coinsTracked = COINS.filter((c) => portfolioHasCoin(pf, c.id));

  if (!coinsTracked.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const sorted = [...coinsTracked].sort((a, b) => {
    const ba = coinBalanceInPortfolio(pf, a.id);
    const bb = coinBalanceInPortfolio(pf, b.id);
    const ua = (ba.hasData ? ba.balance : 0) * (prices[a.id]?.usd || 0);
    const ub = (bb.hasData ? bb.balance : 0) * (prices[b.id]?.usd || 0);
    return ub - ua;
  });

  for (const coin of sorted) {
    const info = coinBalanceInPortfolio(pf, coin.id);
    const px = prices[coin.id]?.usd;
    const ch = prices[coin.id]?.change24h;
    const usd = info.hasData ? info.balance * (px || 0) : null;
    const pct = formatPct(ch);
    const holding = getCoinHolding(pf, coin.id);
    const anyLoading = holding.addresses.some(
      (a) => balanceCache[pf.id]?.[coin.id]?.[a]?.loading
    );

    const parts = [];
    if (info.manualCount) parts.push(`${info.manualCount} manual`);
    if (info.addrCount) parts.push(`${info.addrCount} wallet${info.addrCount === 1 ? "" : "s"}`);
    const cb = costBasisInfo(pf, coin.id);
    if (cb.avg != null) parts.push(`avg ${formatUsd(cb.avg)}`);
    const sub = parts.length ? ` · ${parts.join(" · ")}` : "";

    let plLine = "";
    if (cb.pl != null) {
      const sign = cb.pl > 0 ? "+" : "";
      const cls = cb.pl > 0 ? "up" : cb.pl < 0 ? "down" : "neutral";
      plLine = `<div class="holding-pl ${cls}">${sign}${formatUsd(cb.pl)}</div>`;
    }

    const row = document.createElement("button");
    row.type = "button";
    row.className = "holding-row";
    row.innerHTML = `
      <div class="holding-left">
        ${coinAvatarHtml(coin)}
        <div>
          <div class="holding-name">${escapeHtml(coin.name)}</div>
          <div class="holding-symbol">${coin.symbol}${sub}</div>
        </div>
      </div>
      <div class="holding-mid">
        <div class="holding-price">${px != null ? formatUsd(px) : "—"}</div>
        <div class="holding-pct ${pct.cls}">${pct.text}</div>
      </div>
      <div class="holding-right">
        <div class="holding-value">${anyLoading && !info.hasManual ? "…" : usd != null ? formatUsd(usd) : "$0.00"}</div>
        <div class="holding-amount">${info.hasData ? formatAmt(info.balance, coin.symbol) : "—"}</div>
        ${plLine}
      </div>
    `;
    row.addEventListener("click", () => showView("asset", { coinId: coin.id }));
    list.appendChild(row);
  }
}

function renderAsset() {
  const pf = getPortfolio(nav.portfolioId);
  const coin = COIN_BY_ID[nav.coinId];
  if (!pf || !coin) {
    showView("home");
    return;
  }

  setCoinAvatarEl(document.getElementById("asset-avatar"), coin);

  document.getElementById("asset-name").textContent = coin.name;
  const px = prices[coin.id]?.usd;
  const ch = prices[coin.id]?.change24h;
  const pct = formatPct(ch);
  document.getElementById("asset-price-line").innerHTML =
    `${px != null ? formatUsd(px) : "—"} · <span class="holding-pct ${pct.cls}">${pct.text}</span>`;

  const info = coinBalanceInPortfolio(pf, coin.id);
  const usd = info.hasData ? info.balance * (px || 0) : 0;
  document.getElementById("asset-total").textContent = formatUsd(usd);
  document.getElementById("asset-amount").textContent = formatAmt(
    info.hasData ? info.balance : 0,
    coin.symbol
  );

  // Breakdown: on-chain + manual = total
  const bd = document.getElementById("asset-breakdown");
  const onchainUsd = info.onchain * (px || 0);
  const manualUsd = info.manual * (px || 0);
  bd.innerHTML = `
    <div class="breakdown-row">
      <span>On-chain (wallets)</span>
      <strong>${formatAmt(info.onchain, coin.symbol)} · ${formatUsd(onchainUsd)}</strong>
    </div>
    <div class="breakdown-row">
      <span>Manual entries</span>
      <strong>${formatAmt(info.manual, coin.symbol)} · ${formatUsd(manualUsd)}</strong>
    </div>
    <div class="breakdown-row">
      <span>Combined total</span>
      <strong>${formatAmt(info.balance, coin.symbol)} · ${formatUsd(usd)}</strong>
    </div>
  `;

  // Cost basis stats
  const cb = costBasisInfo(pf, coin.id);
  document.getElementById("asset-avg-buy").textContent =
    cb.avg != null ? formatUsd(cb.avg) : "—";
  document.getElementById("asset-cost-basis").textContent =
    cb.cost > 0 ? formatUsd(cb.cost) : "—";
  const plEl = document.getElementById("asset-pl");
  if (cb.pl != null) {
    const sign = cb.pl > 0 ? "+" : "";
    const cls = cb.pl > 0 ? "up" : cb.pl < 0 ? "down" : "neutral";
    plEl.className = `stat-value ${cls}`;
    plEl.textContent = `${sign}${formatUsd(cb.pl)}${
      cb.plPct != null ? ` (${sign}${cb.plPct.toFixed(2)}%)` : ""
    }`;
  } else {
    plEl.className = "stat-value";
    plEl.textContent = "—";
  }

  // Prefill cost inputs with current values (don't clobber while typing on re-render after save)
  const avgInput = document.getElementById("avg-buy-input");
  const costInput = document.getElementById("cost-basis-input");
  if (document.activeElement !== avgInput) {
    avgInput.value = cb.avg != null ? String(roundPriceInput(cb.avg)) : "";
  }
  if (document.activeElement !== costInput) {
    costInput.value = cb.cost > 0 ? String(roundPriceInput(cb.cost)) : "";
  }

  document.getElementById("address-input").placeholder = coin.placeholder;
  document.getElementById("address-hint").textContent = coin.note;
  document.getElementById("manual-amount-input").placeholder = `Amount in ${coin.symbol}`;

  // Price paid: default to live market price (editable). Don't overwrite user edits.
  if (manualPriceCoinId !== coin.id) {
    manualPriceCoinId = coin.id;
    manualPriceDirty = false;
  }
  const priceInput = document.getElementById("manual-price-input");
  priceInput.placeholder = `USD per ${coin.symbol}`;
  if (document.activeElement !== priceInput && !manualPriceDirty) {
    priceInput.value = px != null && px > 0 ? String(roundPriceInput(px)) : "";
  }

  // Exchange fee % (saved setting, editable here)
  const feeInput = document.getElementById("manual-fee-input");
  if (feeInput && document.activeElement !== feeInput) {
    const fee = getExchangeFeePct();
    feeInput.value = fee > 0 ? String(fee) : "";
  }
  updateManualFeeHint();

  const holding = getCoinHolding(pf, coin.id);

  // Manual list
  const manualList = document.getElementById("asset-manual-list");
  manualList.innerHTML = "";
  if (!holding.manual.length) {
    manualList.innerHTML = `<p class="empty-hint" style="margin:8px 0 12px">No manual amounts yet.</p>`;
  }
  for (const entry of holding.manual) {
    const card = document.createElement("div");
    card.className = "addr-card";
    const v = entry.amount * (px || 0);
    const label = entry.label || "Manual";
    const lotCost =
      entry.costUsd != null
        ? entry.costUsd
        : entry.unitPrice != null
          ? manualLotCost(entry.amount, entry.unitPrice, entry.feePct)
          : null;
    const feeNote =
      entry.unitPrice != null && entry.feePct > 0
        ? ` · fee ${entry.feePct}%`
        : "";
    const priceLine =
      entry.unitPrice != null
        ? `<span class="muted">@ ${formatUsd(entry.unitPrice)}${feeNote}${
            lotCost != null ? ` · cost ${formatUsd(lotCost)}` : ""
          }</span>`
        : `<span class="muted">No price paid</span>`;
    card.innerHTML = `
      <div class="addr-title"><span class="tag manual">Manual</span>${escapeHtml(label)}</div>
      <div class="addr-meta">
        <span class="ok">${formatAmt(entry.amount, coin.symbol)}</span>
        <span>${formatUsd(v)}</span>
      </div>
      <div class="addr-meta">${priceLine}</div>
      <div class="addr-actions">
        <button type="button" class="btn-tiny" data-remove>Remove</button>
      </div>
    `;
    card.querySelector("[data-remove]").addEventListener("click", () => {
      removeManualEntry(holding, entry);
      saveStore();
      render();
      toast("Manual amount removed");
    });
    manualList.appendChild(card);
  }

  // Address list
  const list = document.getElementById("asset-address-list");
  list.innerHTML = "";
  const addrs = holding.addresses;

  if (!addrs.length) {
    list.innerHTML = `<p class="empty-hint" style="margin:8px 0 12px">No wallet addresses yet.</p>`;
  }

  for (const addr of addrs) {
    const st = ensureCacheSlot(pf.id, coin.id, addr);
    const card = document.createElement("div");
    card.className = "addr-card";
    let meta = "";
    if (st.loading) meta = `<span>Looking up…</span>`;
    else if (st.error) meta = `<span class="err">${escapeHtml(st.error)}</span>`;
    else if (st.balance != null) {
      const v = st.balance * (px || 0);
      meta = `
        <span class="ok">${formatAmt(st.balance, coin.symbol)}</span>
        <span>${formatUsd(v)}</span>
        <a href="${coin.explorer(addr)}" target="_blank" rel="noopener">Explorer</a>
      `;
    } else meta = `<span class="muted">Not loaded</span>`;

    card.innerHTML = `
      <div class="addr-title"><span class="tag wallet">Wallet</span></div>
      <div class="addr-text">${escapeHtml(addr)}</div>
      <div class="addr-meta">${meta}</div>
      <div class="addr-actions">
        <button type="button" class="btn-tiny" data-remove>Remove</button>
      </div>
    `;
    card.querySelector("[data-remove]").addEventListener("click", () => {
      holding.addresses = holding.addresses.filter((a) => a !== addr);
      saveStore();
      render();
      toast("Address removed");
    });
    list.appendChild(card);
  }
}

function renderAddCoin() {
  const list = document.getElementById("coin-pick-list");
  list.innerHTML = "";
  for (const coin of COINS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "coin-pick-row";
    btn.innerHTML = `
      ${coinAvatarHtml(coin)}
      <div class="grow">
        <div class="name">${escapeHtml(coin.name)}</div>
        <div class="sym">${coin.symbol}</div>
      </div>
      <span class="chev">›</span>
    `;
    btn.addEventListener("click", () => showView("asset", { coinId: coin.id }));
    list.appendChild(btn);
  }
}

// ── Portfolio CRUD ─────────────────────────────────────────────────────────

function openPortfolioModal(mode) {
  modalMode = mode;
  const modal = document.getElementById("modal-portfolio");
  const title = document.getElementById("modal-portfolio-title");
  const input = document.getElementById("portfolio-name-input");
  title.textContent = mode === "rename" ? "Rename portfolio" : "Create portfolio";
  if (mode === "rename") {
    const pf = getPortfolio(nav.portfolioId);
    input.value = pf?.name || "";
  } else {
    input.value = "";
  }
  modal.hidden = false;
  setTimeout(() => input.focus(), 50);
}

function closePortfolioModal() {
  document.getElementById("modal-portfolio").hidden = true;
  modalMode = null;
}

function savePortfolioModal() {
  const name = document.getElementById("portfolio-name-input").value.trim();
  if (!name) {
    toast("Enter a name", "error");
    return;
  }
  if (modalMode === "create") {
    const id = uid();
    store.portfolios.push({
      id,
      name,
      createdAt: Date.now(),
      includeInTotal: true,
      holdings: emptyHoldings(),
    });
    store.activePortfolioId = id;
    saveStore();
    closePortfolioModal();
    showView("portfolio", { portfolioId: id });
    toast("Portfolio created", "success");
  } else if (modalMode === "rename") {
    const pf = getPortfolio(nav.portfolioId);
    if (pf) {
      pf.name = name;
      saveStore();
      closePortfolioModal();
      render();
      toast("Renamed", "success");
    }
  }
}

function deleteCurrentPortfolio() {
  const pf = getPortfolio(nav.portfolioId);
  if (!pf) return;
  if (store.portfolios.length <= 1) {
    toast("Keep at least one portfolio", "error");
    return;
  }
  if (!confirm(`Delete “${pf.name}” and all its addresses?`)) return;
  store.portfolios = store.portfolios.filter((p) => p.id !== pf.id);
  if (store.activePortfolioId === pf.id) {
    store.activePortfolioId = store.portfolios[0]?.id || null;
  }
  delete balanceCache[pf.id];
  saveStore();
  showView("settings");
  toast("Portfolio deleted");
}

function openPicker() {
  const list = document.getElementById("picker-list");
  list.innerHTML = "";
  for (const pf of store.portfolios) {
    const t = portfolioTotals(pf);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "picker-item";
    btn.innerHTML = `<span>${escapeHtml(pf.name)}</span><span class="val">${formatUsd(t.totalUsd)}</span>`;
    btn.addEventListener("click", () => {
      store.activePortfolioId = pf.id;
      saveStore();
      document.getElementById("modal-picker").hidden = true;
      showView("portfolio", { portfolioId: pf.id });
    });
    list.appendChild(btn);
  }
  document.getElementById("modal-picker").hidden = false;
}

// ── Address validation & add ───────────────────────────────────────────────

function looksPlausible(coinId, address) {
  const a = address.trim();
  switch (coinId) {
    case "btc":
      return /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,90}$/.test(a);
    case "xrp":
      return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a);
    case "xlm":
      return /^G[A-Z2-7]{55}$/.test(a);
    case "hbar":
      return /^(0\.0\.\d+|0x[a-fA-F0-9]{40})$/.test(a);
    case "ada":
    case "night":
      return /^addr1[a-z0-9]{20,}$/i.test(a);
    case "doge":
      return /^[DA9][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(a);
    case "ltc":
      return /^(ltc1|[LM3])[a-zA-HJ-NP-Z0-9]{25,90}$/.test(a);
    default:
      return a.length > 8;
  }
}

async function addAddressToCurrent(address) {
  const pf = getPortfolio(nav.portfolioId);
  const coin = COIN_BY_ID[nav.coinId];
  if (!pf || !coin) return;

  const addr = address.trim();
  if (!addr) return;
  if (!looksPlausible(coin.id, addr)) {
    toast(`Invalid ${coin.symbol} address format`, "error");
    return;
  }
  const holding = getCoinHolding(pf, coin.id);
  if (holding.addresses.includes(addr)) {
    toast("Already added", "error");
    return;
  }
  holding.addresses.push(addr);
  saveStore();
  document.getElementById("address-input").value = "";
  render();
  toast("Looking up balance…");
  await refreshBalance(pf.id, coin.id, addr);
  render();
  toast("Address added", "success");
}

function roundPriceInput(n) {
  if (!Number.isFinite(n)) return n;
  if (n >= 1000) return Math.round(n * 100) / 100;
  if (n >= 1) return Math.round(n * 10000) / 10000;
  return Math.round(n * 1e8) / 1e8;
}

/** Remove a manual entry and reverse its contribution to cost basis when priced. */
function removeManualEntry(holding, entry) {
  const lotCost =
    entry.costUsd != null
      ? entry.costUsd
      : entry.unitPrice != null
        ? manualLotCost(entry.amount, entry.unitPrice, entry.feePct)
        : null;
  if (lotCost != null && Number.isFinite(lotCost)) {
    holding.costBasisUsd = Math.max(0, (Number(holding.costBasisUsd) || 0) - lotCost);
  }
  holding.manual = holding.manual.filter((m) => m.id !== entry.id);
}

function updateManualFeeHint() {
  const hint = document.getElementById("manual-price-hint");
  if (!hint) return;
  const fee = getExchangeFeePct();
  if (fee > 0) {
    hint.textContent = `Cost basis uses amount × price × (1 + ${fee}% fee). Fee is saved and applied on add.`;
  } else {
    hint.textContent =
      "Price defaults to market. Cost basis uses amount × price. Set a fee % to include exchange fees.";
  }
}

/**
 * Add manual lot. If unit price is provided, fold it into cost basis with exchange fee:
 * cost = amount × price × (1 + fee%).
 */
function addManualToCurrent(amountRaw, priceRaw, feeRaw, labelRaw) {
  const pf = getPortfolio(nav.portfolioId);
  const coin = COIN_BY_ID[nav.coinId];
  if (!pf || !coin) return;

  const cleaned = String(amountRaw || "").replace(/,/g, "").trim();
  const amount = Number(cleaned);
  if (!cleaned || !Number.isFinite(amount) || amount <= 0) {
    toast("Enter a valid amount greater than 0", "error");
    return;
  }

  // Persist fee setting from the form (even if price blank)
  const feePct = setExchangeFeePct(feeRaw === "" || feeRaw == null ? getExchangeFeePct() : feeRaw);

  let unitPrice = null;
  const priceStr = String(priceRaw || "").trim();
  if (priceStr) {
    unitPrice = parseOptionalUsd(priceStr);
    if (unitPrice == null || unitPrice <= 0) {
      toast("Enter a valid price paid, or leave it blank", "error");
      return;
    }
  }

  const costUsd = unitPrice != null ? manualLotCost(amount, unitPrice, feePct) : null;

  const holding = getCoinHolding(pf, coin.id);
  holding.manual.push({
    id: uid(),
    amount,
    label: String(labelRaw || "").trim().slice(0, 40),
    unitPrice,
    feePct: unitPrice != null ? feePct : 0,
    costUsd,
  });

  if (costUsd != null) {
    holding.costBasisUsd = (Number(holding.costBasisUsd) || 0) + costUsd;
  }

  saveStore();
  document.getElementById("manual-amount-input").value = "";
  document.getElementById("manual-label-input").value = "";
  // Re-fill price with live market on next render
  manualPriceDirty = false;
  document.getElementById("manual-price-input").value = "";
  render();

  if (unitPrice != null) {
    const cb = costBasisInfo(pf, coin.id);
    const avgTxt = cb.avg != null ? formatUsd(cb.avg) : "—";
    const feeNote = feePct > 0 ? ` · fee ${feePct}%` : "";
    toast(`Added · cost ${formatUsd(costUsd)}${feeNote} · avg ${avgTxt}`, "success");
  } else {
    toast("Manual amount added", "success");
  }
}

// ── Settings: export / import / wipe ───────────────────────────────────────

function exportData() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `updown-portfolios-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("Exported", "success");
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data?.portfolios || !Array.isArray(data.portfolios)) throw new Error("Invalid file");
      store = {
        version: 2,
        activePortfolioId: data.activePortfolioId || data.portfolios[0]?.id || null,
        exchangeFeePct: normalizeExchangeFeePct(data.exchangeFeePct),
        portfolios: data.portfolios.map(normalizePortfolio),
      };
      if (!store.portfolios.length) store = defaultStore();
      saveStore();
      balanceCache = {};
      showView("home");
      refreshAll();
      toast("Import complete", "success");
    } catch {
      toast("Could not import file", "error");
    }
  };
  reader.readAsText(file);
}

function wipeAll() {
  if (!confirm("Delete all portfolios and local data?")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_KEY);
  localStorage.removeItem(SNAPSHOT_KEY);
  store = defaultStore();
  saveStore();
  balanceCache = {};
  prices = {};
  chartCache = {};
  lastChartHoldings = [];
  showView("home");
  render();
  toast("Local data cleared");
}

// ── Event wiring ───────────────────────────────────────────────────────────

function wire() {
  wirePullToRefresh();

  document.getElementById("home-chart-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".chart-tab");
    if (!tab || !tab.dataset.range) return;
    if (tab.dataset.range === chartRange) return;
    chartRange = tab.dataset.range;
    syncChartTabs();
    updateHomeChart(null, { force: false });
  });

  document.getElementById("home-chart-retry")?.addEventListener("click", () => {
    // Bust cache for current range so retry actually refetches
    const days = chartRange;
    for (const key of Object.keys(chartCache)) {
      if (key.endsWith(`:${days}`)) delete chartCache[key];
    }
    updateHomeChart(null, { force: true });
  });

  document.getElementById("btn-back").addEventListener("click", () => {
    if (nav.view === "asset" || nav.view === "add-coin") {
      showView("portfolio", { portfolioId: nav.portfolioId });
    } else if (nav.view === "portfolio") {
      // Portfolios are managed from Settings
      showView("settings");
    } else if (nav.view === "settings") {
      showView("home");
    }
  });

  document.getElementById("btn-settings").addEventListener("click", () => showView("settings"));

  document.getElementById("btn-new-portfolio").addEventListener("click", () => openPortfolioModal("create"));
  document.getElementById("btn-rename-portfolio").addEventListener("click", () => openPortfolioModal("rename"));
  document.getElementById("btn-delete-portfolio").addEventListener("click", () => deleteCurrentPortfolio());
  document.getElementById("btn-add-holding").addEventListener("click", () => showView("add-coin"));

  document.getElementById("modal-portfolio-cancel").addEventListener("click", closePortfolioModal);
  document.getElementById("modal-portfolio-save").addEventListener("click", savePortfolioModal);
  document.getElementById("portfolio-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") savePortfolioModal();
  });

  document.getElementById("btn-portfolio-switch").addEventListener("click", openPicker);
  document.getElementById("picker-close").addEventListener("click", () => {
    document.getElementById("modal-picker").hidden = true;
  });
  document.getElementById("picker-all").addEventListener("click", () => {
    document.getElementById("modal-picker").hidden = true;
    showView("settings");
  });

  document.getElementById("add-address-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = document.getElementById("address-input").value;
    await addAddressToCurrent(val);
  });

  document.getElementById("add-manual-form").addEventListener("submit", (e) => {
    e.preventDefault();
    addManualToCurrent(
      document.getElementById("manual-amount-input").value,
      document.getElementById("manual-price-input").value,
      document.getElementById("manual-fee-input").value,
      document.getElementById("manual-label-input").value
    );
  });

  document.getElementById("manual-price-input").addEventListener("input", () => {
    manualPriceDirty = true;
  });

  document.getElementById("manual-fee-input").addEventListener("change", () => {
    const fee = setExchangeFeePct(document.getElementById("manual-fee-input").value || 0);
    document.getElementById("manual-fee-input").value = fee > 0 ? String(fee) : "";
    updateManualFeeHint();
    toast(fee > 0 ? `Exchange fee saved: ${fee}%` : "Exchange fee cleared", "success");
  });

  document.getElementById("btn-save-avg-buy").addEventListener("click", () => {
    const pf = getPortfolio(nav.portfolioId);
    const coin = COIN_BY_ID[nav.coinId];
    if (!pf || !coin) return;
    if (setAvgBuyPrice(pf, coin.id, document.getElementById("avg-buy-input").value)) {
      render();
      const cb = costBasisInfo(pf, coin.id);
      toast(`Avg buy set · cost basis ${formatUsd(cb.cost)}`, "success");
    }
  });

  document.getElementById("btn-save-cost-basis").addEventListener("click", () => {
    const pf = getPortfolio(nav.portfolioId);
    const coin = COIN_BY_ID[nav.coinId];
    if (!pf || !coin) return;
    if (setCostBasisUsd(pf, coin.id, document.getElementById("cost-basis-input").value)) {
      render();
      const cb = costBasisInfo(pf, coin.id);
      const avgTxt = cb.avg != null ? formatUsd(cb.avg) : "—";
      toast(`Cost basis set · avg buy ${avgTxt}`, "success");
    }
  });

  document.getElementById("btn-clear-cost").addEventListener("click", () => {
    const pf = getPortfolio(nav.portfolioId);
    const coin = COIN_BY_ID[nav.coinId];
    if (!pf || !coin) return;
    if (!confirm("Clear cost basis and average buy price for this coin?")) return;
    clearCostBasis(pf, coin.id);
    render();
    toast("Cost basis cleared");
  });

  document.getElementById("btn-save-fee").addEventListener("click", () => {
    const fee = setExchangeFeePct(document.getElementById("settings-fee-input").value || 0);
    document.getElementById("settings-fee-input").value = fee > 0 ? String(fee) : "";
    updateManualFeeHint();
    toast(fee > 0 ? `Exchange fee saved: ${fee}%` : "Exchange fee cleared", "success");
  });

  document.getElementById("btn-export").addEventListener("click", exportData);
  document.getElementById("btn-import").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document.getElementById("import-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) importData(file);
    e.target.value = "";
  });
  document.getElementById("btn-wipe").addEventListener("click", wipeAll);

  // Close modals on backdrop click
  for (const id of ["modal-portfolio", "modal-picker"]) {
    document.getElementById(id).addEventListener("click", (e) => {
      if (e.target.id === id) e.target.hidden = true;
    });
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

loadMarketSnapshot(); // restore last prices/balances so UI doesn't flash $0
wire();
render();
refreshAll({ fromPull: false });
