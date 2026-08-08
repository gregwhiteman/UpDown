/**
 * UpDown — mobile multi-portfolio crypto tracker (CMC-style)
 * All user data persisted in localStorage.
 */

const STORAGE_KEY = "updown.app.v2";
const LEGACY_KEY = "updown.addresses.v1";
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
    color: "#00aae4",
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
    color: "#14b6e7",
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
    color: "#7c3aed",
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

/** @type {{ version: number, activePortfolioId: string|null, portfolios: Portfolio[] }} */
let store = loadStore();

/** @type {Record<string, { usd: number, change24h: number }>} */
let prices = {};

/**
 * balanceCache[portfolioId][coinId][address] = { balance, error, loading }
 * @type {Record<string, Record<string, Record<string, { balance: number|null, error: string|null, loading: boolean }>>>}
 */
let balanceCache = {};

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

/** @returns {{ addresses: string[], manual: { id: string, amount: number, label: string }[] }} */
function emptyCoinHolding() {
  return { addresses: [], manual: [] };
}

function emptyHoldings() {
  const h = {};
  for (const c of COINS) h[c.id] = emptyCoinHolding();
  return h;
}

/** Normalize legacy array or partial object → { addresses, manual } */
function normalizeCoinHolding(raw) {
  // Legacy: string[] of addresses only
  if (Array.isArray(raw)) {
    return {
      addresses: raw.map(String).filter(Boolean),
      manual: [],
    };
  }
  if (raw && typeof raw === "object") {
    const addresses = Array.isArray(raw.addresses)
      ? raw.addresses.map(String).filter(Boolean)
      : [];
    let manual = [];
    if (Array.isArray(raw.manual)) {
      manual = raw.manual
        .map((m) => ({
          id: m.id || uid(),
          amount: Number(m.amount),
          label: String(m.label || "").slice(0, 40),
        }))
        .filter((m) => Number.isFinite(m.amount) && m.amount > 0);
    } else if (raw.manual != null && Number(raw.manual) > 0) {
      // Single number form
      manual = [{ id: uid(), amount: Number(raw.manual), label: "" }];
    }
    return { addresses, manual };
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
  return h;
}

function defaultStore() {
  const id = uid();
  return {
    version: 2,
    activePortfolioId: id,
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
          };
        }
      }
      const migrated = {
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
  const next = {};
  for (const coin of COINS) {
    const row = data[coin.geckoId];
    next[coin.id] = { usd: row?.usd ?? 0, change24h: row?.usd_24h_change ?? 0 };
  }
  prices = next;
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
  slot.loading = true;
  slot.error = null;
  try {
    slot.balance = await coin.fetchBalance(addr);
    slot.error = null;
  } catch (err) {
    slot.balance = null;
    slot.error = humanizeError(err);
  } finally {
    slot.loading = false;
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

async function refreshAll() {
  const btn = document.getElementById("btn-refresh");
  btn.classList.add("spin");
  btn.disabled = true;

  try {
    await fetchPrices();
  } catch (err) {
    toast(`Prices: ${humanizeError(err)}`, "error");
  }

  const jobs = [];
  for (const pf of store.portfolios) {
    for (const coin of COINS) {
      const holding = getCoinHolding(pf, coin.id);
      for (const addr of holding.addresses) {
        ensureCacheSlot(pf.id, coin.id, addr).loading = true;
        jobs.push(() => refreshBalance(pf.id, coin.id, addr));
      }
    }
  }

  if (jobs.length) {
    render(); // show loading states
    await runPool(jobs, 4);
  }

  btn.classList.remove("spin");
  btn.disabled = false;
  render();
  toast("Updated", "success");
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

/** Total coin amounts across portfolios included in the main balance. */
function renderHomeCoinTotals(allocRows) {
  const el = document.getElementById("home-coin-totals");
  if (!el) return;

  const rows = (allocRows || []).filter((r) => r.balance > 0);
  if (!rows.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }

  el.hidden = false;
  el.innerHTML = rows
    .map((r) => {
      const coin = COIN_BY_ID[r.coinId];
      if (!coin) return "";
      const color = coin.color || "#3861fb";
      return `
        <div class="home-coin-row">
          <div class="home-coin-left">
            <span class="home-coin-dot" style="background:${color}" aria-hidden="true"></span>
            <span class="home-coin-amt mono">${escapeHtml(formatAmt(r.balance, coin.symbol))}</span>
          </div>
          <span class="home-coin-usd muted">${formatUsd(r.usd)}</span>
        </div>
      `;
    })
    .filter(Boolean)
    .join("");
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
  const title = document.getElementById("topbar-title");
  const switchBtn = document.getElementById("btn-portfolio-switch");
  const tabbar = document.querySelector(".tabbar");

  // Tabs
  document.querySelectorAll(".tab").forEach((t) => {
    const isHome = nav.view === "home" || nav.view === "portfolio" || nav.view === "asset" || nav.view === "add-coin";
    if (t.dataset.tab === "home") t.classList.toggle("active", isHome && nav.view !== "settings");
    if (t.dataset.tab === "settings") t.classList.toggle("active", nav.view === "settings");
  });

  if (nav.view === "home") {
    back.hidden = true;
    title.hidden = false;
    title.textContent = "Portfolio";
    switchBtn.hidden = true;
    tabbar.style.display = "";
    renderHome();
  } else if (nav.view === "portfolio") {
    back.hidden = false;
    title.hidden = true;
    switchBtn.hidden = false;
    const pf = getPortfolio(nav.portfolioId);
    document.getElementById("active-portfolio-label").textContent = pf?.name || "Portfolio";
    tabbar.style.display = "";
    renderPortfolio();
  } else if (nav.view === "asset") {
    back.hidden = false;
    title.hidden = false;
    title.textContent = COIN_BY_ID[nav.coinId]?.symbol || "Asset";
    switchBtn.hidden = true;
    tabbar.style.display = "";
    renderAsset();
  } else if (nav.view === "add-coin") {
    back.hidden = false;
    title.hidden = false;
    title.textContent = "Add holding";
    switchBtn.hidden = true;
    tabbar.style.display = "";
    renderAddCoin();
  } else if (nav.view === "settings") {
    back.hidden = true;
    title.hidden = false;
    title.textContent = "Settings";
    switchBtn.hidden = true;
    tabbar.style.display = "";
  }
}

function renderHome() {
  const { totalUsd, changeUsd, changePct, perPf, allocRows, excludedCount } = allPortfoliosTotals();
  document.getElementById("home-total").textContent = formatUsd(totalUsd);
  setChangePill(document.getElementById("home-change"), changeUsd, changePct);
  renderAllocBar(document.getElementById("home-alloc-bar"), allocRows);
  renderHomeCoinTotals(allocRows);

  const scopeEl = document.getElementById("home-scope-hint");
  if (scopeEl) {
    if (excludedCount > 0) {
      scopeEl.hidden = false;
      scopeEl.textContent =
        excludedCount === 1
          ? "1 portfolio excluded from total"
          : `${excludedCount} portfolios excluded from total`;
    } else {
      scopeEl.hidden = true;
      scopeEl.textContent = "";
    }
  }

  const list = document.getElementById("portfolio-list");
  const empty = document.getElementById("home-empty");
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
        <label class="switch" title="Include in main portfolio total">
          <input type="checkbox" class="pf-include-toggle" ${included ? "checked" : ""} aria-label="Include ${escapeHtml(pf.name)} in main total" />
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
      renderHome();
      toast(e.target.checked ? `“${pf.name}” included in total` : `“${pf.name}” excluded from total`);
    });

    // Prevent toggle click from bubbling awkwardly
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
    const sub = parts.length ? ` · ${parts.join(" · ")}` : "";

    const row = document.createElement("button");
    row.type = "button";
    row.className = "holding-row";
    row.innerHTML = `
      <div class="holding-left">
        <div class="coin-avatar" style="background:${coin.color};color:${iconContrast(coin.color)}">${coin.symbol.slice(0, 4)}</div>
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

  const avatar = document.getElementById("asset-avatar");
  avatar.textContent = coin.symbol.slice(0, 4);
  avatar.style.background = coin.color;
  avatar.style.color = iconContrast(coin.color);

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

  document.getElementById("address-input").placeholder = coin.placeholder;
  document.getElementById("address-hint").textContent = coin.note;
  document.getElementById("manual-amount-input").placeholder = `Amount in ${coin.symbol}`;

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
    card.innerHTML = `
      <div class="addr-title"><span class="tag manual">Manual</span>${escapeHtml(label)}</div>
      <div class="addr-meta">
        <span class="ok">${formatAmt(entry.amount, coin.symbol)}</span>
        <span>${formatUsd(v)}</span>
      </div>
      <div class="addr-actions">
        <button type="button" class="btn-tiny" data-remove>Remove</button>
      </div>
    `;
    card.querySelector("[data-remove]").addEventListener("click", () => {
      holding.manual = holding.manual.filter((m) => m.id !== entry.id);
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
      <div class="coin-avatar" style="background:${coin.color};color:${iconContrast(coin.color)}">${coin.symbol.slice(0, 4)}</div>
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
  showView("home");
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

function addManualToCurrent(amountRaw, labelRaw) {
  const pf = getPortfolio(nav.portfolioId);
  const coin = COIN_BY_ID[nav.coinId];
  if (!pf || !coin) return;

  const cleaned = String(amountRaw || "").replace(/,/g, "").trim();
  const amount = Number(cleaned);
  if (!cleaned || !Number.isFinite(amount) || amount <= 0) {
    toast("Enter a valid amount greater than 0", "error");
    return;
  }

  const holding = getCoinHolding(pf, coin.id);
  holding.manual.push({
    id: uid(),
    amount,
    label: String(labelRaw || "").trim().slice(0, 40),
  });
  saveStore();
  document.getElementById("manual-amount-input").value = "";
  document.getElementById("manual-label-input").value = "";
  render();
  toast("Manual amount added", "success");
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
  store = defaultStore();
  saveStore();
  balanceCache = {};
  showView("home");
  render();
  toast("Local data cleared");
}

// ── Event wiring ───────────────────────────────────────────────────────────

function wire() {
  document.getElementById("btn-refresh").addEventListener("click", () => refreshAll());

  document.getElementById("btn-back").addEventListener("click", () => {
    if (nav.view === "asset" || nav.view === "add-coin") {
      showView("portfolio", { portfolioId: nav.portfolioId });
    } else if (nav.view === "portfolio") {
      showView("home");
    }
  });

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
    showView("home");
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
      document.getElementById("manual-label-input").value
    );
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.tab === "home") showView("home");
      if (tab.dataset.tab === "settings") showView("settings");
    });
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

wire();
render();
refreshAll();
