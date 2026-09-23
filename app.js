const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'galaxy-tab-radar-settings';
let currentFilter = 'candidates';
let state = { listings: [], last_run: null, defaults: null };
let settings = null;

// ---- presence-driven scan trigger ----
// Scanning only happens while someone has this page open and visible.
// This calls a small Cloudflare Worker proxy instead of GitHub's API
// directly — the real token only ever lives in the Worker's encrypted
// secret, never in this file or any git commit.
const TRIGGER_PROXY_URL = 'https://winter-paper-72a2.browninvestmentor.workers.dev';
const TRIGGER_COOLDOWN_MS = 4 * 60 * 1000;
const PRESENCE_INTERVAL_MS = 5 * 60 * 1000;
let lastTriggerRequestAt = 0;
let presenceTimer = null;

async function dispatchScan() {
  lastTriggerRequestAt = Date.now();
  try {
    const response = await fetch(TRIGGER_PROXY_URL, { method: 'POST' });
    return response.ok;
  } catch (error) { return false; /* network hiccup: next tick or click retries */ }
}
async function maybeTriggerScan() {
  const now = Date.now();
  if (now - lastTriggerRequestAt < TRIGGER_COOLDOWN_MS) return;
  const lastRunAt = state.last_run ? new Date(state.last_run.finished_at).getTime() : 0;
  if (lastRunAt && now - lastRunAt < TRIGGER_COOLDOWN_MS) return;
  await dispatchScan();
}
function startPresenceLoop() {
  maybeTriggerScan();
  if (!presenceTimer) presenceTimer = setInterval(maybeTriggerScan, PRESENCE_INTERVAL_MS);
}
function stopPresenceLoop() {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') startPresenceLoop();
  else stopPresenceLoop();
});
// ---- end presence-driven scan trigger ----

// ---- devices.py + rules.py port: classification runs entirely in the browser ----
const CATALOG = [
  {
    id: 'galaxy_tab', label: '갤럭시탭', hasNetwork: true,
    identity: /갤럭시\s*탭|galaxy\s*tab/i,
    generations: [
      { id: 'S9', label: 'S9', pattern: /(?<![a-z0-9])s\s*9(?!\d)/i },
      { id: 'S10', label: 'S10', pattern: /(?<![a-z0-9])s\s*10(?!\d)/i },
      { id: 'S11', label: 'S11', pattern: /(?<![a-z0-9])s\s*11(?!\d)/i },
    ],
    tiers: [
      { id: 'ultra', label: 'Ultra', pattern: /울트라|ultra/i },
      { id: 'plus', label: 'S+', pattern: /s\s*(?:9|10|11)\s*(?:\+|plus|플러스)/i },
    ],
    baseTier: { id: 'base', label: 'S 기본형' },
  },
  {
    id: 'galaxy_phone', label: '갤럭시폰', hasNetwork: false,
    identity: /갤럭시|galaxy|삼성/i,
    generations: [
      { id: 'S25', label: 'S25', pattern: /(?<![a-z0-9])s\s*25(?!\d)/i },
      { id: 'S24', label: 'S24', pattern: /(?<![a-z0-9])s\s*24(?!\d)/i },
      { id: 'S23', label: 'S23', pattern: /(?<![a-z0-9])s\s*23(?!\d)/i },
      { id: 'z_fold6', label: 'Z Fold6', pattern: /z\s*(?:폴드|fold)\s*6/i, supportsTiers: false },
      { id: 'z_fold5', label: 'Z Fold5', pattern: /z\s*(?:폴드|fold)\s*5/i, supportsTiers: false },
      { id: 'z_flip6', label: 'Z Flip6', pattern: /z\s*(?:플립|flip)\s*6/i, supportsTiers: false },
      { id: 'z_flip5', label: 'Z Flip5', pattern: /z\s*(?:플립|flip)\s*5/i, supportsTiers: false },
    ],
    tiers: [
      { id: 'ultra', label: 'Ultra', pattern: /울트라|ultra/i },
      { id: 'plus', label: '+', pattern: /s\s*(?:23|24|25)\s*(?:\+|plus|플러스)/i },
    ],
    baseTier: { id: 'base', label: '기본형' },
  },
  {
    id: 'iphone', label: '아이폰', hasNetwork: false,
    identity: /아이폰|iphone/i,
    generations: [
      { id: '17', label: '17', pattern: /아이폰\s*17(?!\d)|iphone\s*17(?!\d)/i },
      { id: '16', label: '16', pattern: /아이폰\s*16(?!\d)|iphone\s*16(?!\d)/i },
      { id: '15', label: '15', pattern: /아이폰\s*15(?!\d)|iphone\s*15(?!\d)/i },
      { id: '14', label: '14', pattern: /아이폰\s*14(?!\d)|iphone\s*14(?!\d)/i },
    ],
    tiers: [
      { id: 'pro_max', label: 'Pro Max', pattern: /프로\s*맥스|pro\s*max/i },
      { id: 'pro', label: 'Pro', pattern: /프로|pro/i },
      { id: 'plus', label: 'Plus', pattern: /플러스|plus/i },
    ],
    baseTier: { id: 'base', label: '기본형' },
  },
  {
    id: 'ipad', label: '아이패드', hasNetwork: true,
    identity: /아이패드|ipad/i,
    generations: [
      { id: 'pro', label: 'Pro', pattern: /아이패드\s*프로|ipad\s*pro/i, supportsTiers: false },
      { id: 'air', label: 'Air', pattern: /아이패드\s*에어|ipad\s*air/i, supportsTiers: false },
      { id: 'mini', label: 'mini', pattern: /아이패드\s*미니|ipad\s*mini/i, supportsTiers: false },
      { id: 'base', label: '기본형', pattern: /아이패드|ipad/i, supportsTiers: false },
    ],
    tiers: [],
    baseTier: null,
  },
];

const FIVE_G = /(?<![a-z0-9])5\s*g(?![a-z0-9])|셀룰러|lte/i;
const WIFI = /wi[\s-]*fi|와이파이/i;
const SEALED = /미\s*개봉|새\s*제품|새\s*상품|박스\s*씰|씰\s*봉인|unopened|sealed/i;
const UNLOCKED = /자급제|정상\s*해지|공기계|확정\s*기변/i;
const EXCLUDED = /삽니다|구해요|구합니다|구함|원해요|매입|판매대행|대량매입|케이스|커버|필름|키보드\s*만|박스\s*만|빈\s*박스|s\s*(?:9|10|11)\s*(?:fe|lite|라이트)|부품용|파손|분실|도난/i;
const USED = /사용감|중고|실사용|개봉품|단순\s*개봉|올갈이|리퍼/i;

function normalize(value) {
  return (value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function detectFamily(title) {
  for (const family of CATALOG) {
    if (!family.identity.test(title)) continue;
    for (const generation of family.generations) {
      if (generation.pattern.test(title)) return { family, generation };
    }
  }
  return null;
}
function detectTier(family, generation, title) {
  if (generation.supportsTiers === false || !family.baseTier) return null;
  for (const tier of family.tiers) {
    if (tier.pattern.test(title)) return tier;
  }
  return family.baseTier;
}
function detectNetwork(text) {
  if (FIVE_G.test(text)) return '5g';
  if (WIFI.test(text)) return 'wifi';
  return '';
}
function parsePostedAt(value) {
  const raw = (value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return new Date(Number(raw) * 1000);
  let iso = raw.replace(' ', 'T');
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += '+09:00';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
function classify(listing, config) {
  const text = normalize(`${listing.title} ${listing.description || ''}`);
  const title = normalize(listing.title);
  const includeKeywords = (config.include_keywords || []).map(normalize).filter(Boolean);
  const excludeKeywords = (config.exclude_keywords || []).map(normalize).filter(Boolean);

  if (listing.price <= 0) return { code: 'rejected', reasons: ['가격 없음'] };
  if (listing.price < config.min_price) return { code: 'rejected', reasons: [`최소 가격 미만 (${listing.price.toLocaleString('ko-KR')}원)`] };
  if (listing.price > config.max_price) return { code: 'rejected', reasons: [`예산 초과 (${listing.price.toLocaleString('ko-KR')}원)`] };
  if (excludeKeywords.length && excludeKeywords.some((k) => text.includes(k))) return { code: 'rejected', reasons: ['제외 키워드 포함'] };
  if (includeKeywords.length && !includeKeywords.some((k) => text.includes(k))) return { code: 'rejected', reasons: ['포함 키워드 없음'] };

  const found = detectFamily(title);
  if (!found) return { code: 'rejected', reasons: ['지원 기종(갤럭시탭/갤럭시폰/아이폰/아이패드) 여부 불명확'] };
  const { family, generation } = found;
  const familyConfig = (config.device_families || {})[family.id] || {};
  if (!familyConfig.enabled) return { code: 'rejected', reasons: [`선택하지 않은 기종 (${family.label})`], device_family: family.id };
  if (!(familyConfig.generations || []).includes(generation.id)) {
    return { code: 'rejected', reasons: [`선택하지 않은 세대 (${family.label} ${generation.label})`], device_family: family.id, generation: generation.label };
  }
  if (EXCLUDED.test(title)) return { code: 'rejected', reasons: ['제외 키워드 포함'], device_family: family.id, generation: generation.label };

  const tier = detectTier(family, generation, title);
  if (tier && !(familyConfig.tiers || []).includes(tier.id)) {
    return { code: 'rejected', reasons: [`선택하지 않은 모델 (${tier.label})`], device_family: family.id, generation: generation.label, model_tier: tier.id };
  }

  let modelLabel = `${family.label} ${generation.label}`;
  if (tier && tier.id !== 'base') modelLabel += ` ${tier.label}`;
  const tierId = tier ? tier.id : '';

  if (config.max_age_days) {
    const postedAt = parsePostedAt(listing.posted_at);
    if (!postedAt) return { code: 'rejected', reasons: ['게시일 확인 불가'], device_family: family.id, generation: generation.label, model_tier: tierId };
    const cutoff = new Date(Date.now() - config.max_age_days * 86400000);
    if (postedAt < cutoff) return { code: 'rejected', reasons: [`최근 ${config.max_age_days}일 이전 게시물`], device_family: family.id, generation: generation.label, model_tier: tierId };
  }

  let networkType = '';
  if (family.hasNetwork) {
    networkType = detectNetwork(text);
    if (!networkType) {
      return { code: 'review', reasons: [`${modelLabel} · 5G/Wi-Fi 유형 확인 필요`], device_family: family.id, generation: generation.label, model_tier: tierId };
    }
    if (!(familyConfig.network_types || []).includes(networkType)) {
      const label = networkType === '5g' ? '5G 자급제' : 'Wi-Fi';
      return { code: 'rejected', reasons: [`선택하지 않은 유형 (${label})`], device_family: family.id, generation: generation.label, model_tier: tierId };
    }
  }

  const reasons = [];
  const sealed = SEALED.test(text);
  if (!sealed) reasons.push('미개봉 문구 확인 필요');
  const carrierRelevant = family.hasNetwork ? networkType === '5g' : true;
  if (carrierRelevant && !UNLOCKED.test(text)) reasons.push('자급제/정상해지 확인 필요');
  if (USED.test(text) && !sealed) reasons.push('사용 또는 개봉 정황');

  if (reasons.length) {
    return {
      code: 'review', reasons: [...new Set(reasons)].map((r) => `${modelLabel} · ${r}`),
      device_family: family.id, generation: generation.label, model_tier: tierId,
    };
  }
  let label = modelLabel;
  if (family.hasNetwork) label += ` ${networkType === '5g' ? '5G 자급제' : 'Wi-Fi'}`;
  return {
    code: 'match', reasons: [`${label} 조건 충족`],
    device_family: family.id, generation: generation.label, network_type: networkType, model_tier: tierId,
  };
}
// ---- end devices.py + rules.py port ----

function won(value) { return new Intl.NumberFormat('ko-KR').format(value) + '원'; }
function when(value) {
  if (!value) return '기록 없음';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ko-KR');
}
function escapeHtml(value = '') {
  return value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function postedLabel(value) {
  const d = parsePostedAt(value);
  return d ? d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '게시일 미상';
}
function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function renderListing(item) {
  const labels = { match: '조건충족', review: '확인필요', rejected: '제외' };
  const image = item.image_url ? `<img class="thumb" src="${escapeHtml(item.image_url)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="thumb"></div>';
  return `<article class="listing" data-platform="${escapeHtml(item.platform)}">${image}<div class="listing-main">
    <div class="meta"><span class="badge ${item.verdict}">${labels[item.verdict] || item.verdict}</span><span>${escapeHtml(item.platform)}</span>${item.location ? `<span>· ${escapeHtml(item.location)}</span>` : ''}<span>· ${postedLabel(item.posted_at)}</span></div>
    <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>
    <div class="price">${won(item.price)}</div><p class="reasons">${escapeHtml(item.reasons.join(' · '))}</p>
  </div></article>`;
}
function defaultDeviceFamilies() {
  const result = {};
  CATALOG.forEach((family) => {
    const entry = { enabled: true, generations: family.generations.map((g) => g.id) };
    if (family.baseTier) entry.tiers = [...family.tiers.map((t) => t.id), family.baseTier.id];
    if (family.hasNetwork) entry.network_types = ['5g', 'wifi'];
    result[family.id] = entry;
  });
  return result;
}
function renderDeviceFamiliesMarkup() {
  return CATALOG.map((family) => {
    const generationInputs = family.generations.map((g) =>
      `<label class="check"><input type="checkbox" data-family="${family.id}" data-kind="generation" data-value="${g.id}"><span>${g.label}</span></label>`
    ).join('');
    const tierChoices = family.baseTier ? [...family.tiers, family.baseTier] : [];
    const tierInputs = tierChoices.length ? `<div class="sub-group"><span class="sub-label">모델 등급</span>${tierChoices.map((t) =>
      `<label class="check"><input type="checkbox" data-family="${family.id}" data-kind="tier" data-value="${t.id}"><span>${t.label}</span></label>`
    ).join('')}</div>` : '';
    const networkInputs = family.hasNetwork ? `<div class="sub-group"><span class="sub-label">통신 유형</span>
      <label class="check"><input type="checkbox" data-family="${family.id}" data-kind="network" data-value="5g"><span>5G 자급제/정상해지</span></label>
      <label class="check"><input type="checkbox" data-family="${family.id}" data-kind="network" data-value="wifi"><span>Wi-Fi</span></label></div>` : '';
    return `<details class="device-family" open>
      <summary>${family.label}</summary>
      <label class="check family-toggle"><input type="checkbox" data-family="${family.id}" data-kind="enabled"><span>이 기종 표시</span></label>
      <div class="sub-group"><span class="sub-label">세대</span>${generationInputs}</div>
      ${tierInputs}
      ${networkInputs}
    </details>`;
  }).join('');
}
function fillDeviceFamilies() {
  CATALOG.forEach((family) => {
    const cfg = settings.device_families[family.id] || {};
    const enabledInput = document.querySelector(`input[data-family="${family.id}"][data-kind="enabled"]`);
    if (enabledInput) enabledInput.checked = cfg.enabled !== false;
    document.querySelectorAll(`input[data-family="${family.id}"][data-kind="generation"]`).forEach((el) => {
      el.checked = (cfg.generations || []).includes(el.dataset.value);
    });
    document.querySelectorAll(`input[data-family="${family.id}"][data-kind="tier"]`).forEach((el) => {
      el.checked = (cfg.tiers || []).includes(el.dataset.value);
    });
    document.querySelectorAll(`input[data-family="${family.id}"][data-kind="network"]`).forEach((el) => {
      el.checked = (cfg.network_types || []).includes(el.dataset.value);
    });
  });
}
function readDeviceFamilies() {
  const result = {};
  CATALOG.forEach((family) => {
    const enabledInput = document.querySelector(`input[data-family="${family.id}"][data-kind="enabled"]`);
    const entry = {
      enabled: enabledInput ? enabledInput.checked : true,
      generations: [...document.querySelectorAll(`input[data-family="${family.id}"][data-kind="generation"]:checked`)].map((el) => el.dataset.value),
    };
    if (family.baseTier) {
      entry.tiers = [...document.querySelectorAll(`input[data-family="${family.id}"][data-kind="tier"]:checked`)].map((el) => el.dataset.value);
    }
    if (family.hasNetwork) {
      entry.network_types = [...document.querySelectorAll(`input[data-family="${family.id}"][data-kind="network"]:checked`)].map((el) => el.dataset.value);
    }
    result[family.id] = entry;
  });
  return result;
}
function loadSettings(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && saved.device_families) return saved;
  } catch (error) { /* ignore malformed local storage */ }
  return {
    min_price: defaults.min_price, max_price: defaults.max_price, max_age_days: defaults.max_age_days,
    device_families: JSON.parse(JSON.stringify(defaults.device_families || defaultDeviceFamilies())),
    include_keywords: [...(defaults.include_keywords || [])],
    exclude_keywords: [...(defaults.exclude_keywords || [])],
    sort: 'recent',
    platforms: { ...defaults.platforms },
  };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (error) { /* storage unavailable */ }
}
function fillForm() {
  $('minPrice').value = settings.min_price; $('maxPrice').value = settings.max_price;
  $('maxAgeDays').value = String(settings.max_age_days);
  $('includeKeywords').value = (settings.include_keywords || []).join(', ');
  $('excludeKeywords').value = (settings.exclude_keywords || []).join(', ');
  $('sortOrder').value = settings.sort || 'recent';
  fillDeviceFamilies();
  $('daangn').checked = settings.platforms.daangn; $('joongna').checked = settings.platforms.joongna; $('bunjang').checked = settings.platforms.bunjang;
}
function readForm() {
  const minPrice = +$('minPrice').value, maxPrice = +$('maxPrice').value;
  return {
    min_price: minPrice, max_price: maxPrice, max_age_days: +$('maxAgeDays').value,
    device_families: readDeviceFamilies(),
    include_keywords: $('includeKeywords').value.split(',').map((s) => s.trim()).filter(Boolean),
    exclude_keywords: $('excludeKeywords').value.split(',').map((s) => s.trim()).filter(Boolean),
    sort: $('sortOrder').value,
    platforms: { daangn: $('daangn').checked, joongna: $('joongna').checked, bunjang: $('bunjang').checked },
  };
}
const SORT_COMPARATORS = {
  recent: (a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || '') || a.price - b.price,
  price_asc: (a, b) => a.price - b.price,
  price_desc: (a, b) => b.price - a.price,
};
function render() {
  const enabledPlatforms = Object.entries(settings.platforms).filter(([, on]) => on).map(([name]) => name);
  const classified = state.listings
    .filter((item) => enabledPlatforms.includes(item.platform))
    .map((item) => ({ ...item, ...classify(item, settings) }));
  const stats = { total: classified.length, match: 0, review: 0, rejected: 0 };
  classified.forEach((item) => { stats[item.code] = (stats[item.code] || 0) + 1; });
  const visible = classified
    .filter((item) => currentFilter === 'candidates' ? item.code !== 'rejected' : item.code === currentFilter)
    .map((item) => ({ ...item, verdict: item.code }))
    .sort(SORT_COMPARATORS[settings.sort] || SORT_COMPARATORS.recent);

  $('matchCount').textContent = stats.match; $('reviewCount').textContent = stats.review;
  $('rejectedCount').textContent = stats.rejected; $('totalCount').textContent = stats.total;
  $('listings').innerHTML = visible.map(renderListing).join('');
  $('empty').style.display = visible.length ? 'none' : 'block';
}
async function loadState() {
  try {
    const response = await fetch('data/state.json?_=' + Date.now());
    state = await response.json();
    $('statusText').textContent = '감시 중';
    $('lastRun').textContent = state.last_run ? `마지막 스캔 ${when(state.last_run.finished_at)} · ${state.last_run.found_count}건 수집` : '첫 스캔을 준비 중입니다';
    if (!settings) {
      $('deviceFamilies').innerHTML = renderDeviceFamiliesMarkup();
      settings = loadSettings(state.defaults || {});
      fillForm();
    }
    render();
  } catch (error) { $('statusText').textContent = '데이터를 불러오지 못했습니다'; }
}
const REFRESH_POLL_MS = 5000;
const REFRESH_TIMEOUT_MS = 3 * 60 * 1000;
let refreshing = false;
function setRefreshLoading(on) {
  $('refreshButton').classList.toggle('loading', on);
  $('refreshButton').disabled = on;
  $('refreshButton').lastChild.textContent = on ? ' 스캔 중…' : ' 새로고침';
}
$('refreshButton').addEventListener('click', async () => {
  if (refreshing) return;
  refreshing = true;
  setRefreshLoading(true);
  const baselineFinishedAt = state.last_run ? state.last_run.finished_at : null;
  const dispatched = await dispatchScan();
  await loadState();
  if (!dispatched) { setRefreshLoading(false); refreshing = false; return; }
  const startedAt = Date.now();
  const poll = async () => {
    await loadState();
    const finishedAt = state.last_run ? state.last_run.finished_at : null;
    if (finishedAt && finishedAt !== baselineFinishedAt) {
      setRefreshLoading(false); refreshing = false;
      toast('최신 결과로 갱신했습니다.');
      return;
    }
    if (Date.now() - startedAt > REFRESH_TIMEOUT_MS) {
      setRefreshLoading(false); refreshing = false;
      toast('스캔이 예상보다 오래 걸리고 있어요. 잠시 후 다시 눌러주세요.');
      return;
    }
    setTimeout(poll, REFRESH_POLL_MS);
  };
  setTimeout(poll, REFRESH_POLL_MS);
});
$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); currentFilter = button.dataset.filter; render();
});
function applySettings() {
  const next = readForm();
  if (next.min_price > next.max_price) { toast('최소 가격은 최대 가격보다 작아야 합니다.'); return false; }
  settings = next; saveSettings(); render();
  $('autoSaveStatus').textContent = '이 브라우저에 저장됨';
  return true;
}
$('settingsForm').addEventListener('submit', (event) => event.preventDefault());
$('settingsForm').addEventListener('change', (event) => {
  const platformIds = ['daangn', 'joongna', 'bunjang'];
  if (platformIds.includes(event.target.id) && !platformIds.some((id) => $(id).checked)) {
    event.target.checked = true; toast('플랫폼을 하나 이상 선택하세요.'); return;
  }
  applySettings();
});
$('settingsForm').addEventListener('input', (event) => { if (event.target.type !== 'checkbox') applySettings(); });
$('sortOrder').addEventListener('change', () => {
  if (!settings) return;
  settings.sort = $('sortOrder').value;
  saveSettings();
  render();
});
loadState();
setInterval(loadState, 60000);
if (document.visibilityState === 'visible') startPresenceLoop();
