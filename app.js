const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'galaxy-tab-radar-settings';
let currentFilter = 'candidates';
let state = { listings: [], last_run: null, defaults: null };
let settings = null;

// ---- rules.py port: classification runs entirely in the browser ----
const TAB = /갤럭시\s*탭|galaxy\s*tab/i;
const GENERATION = /(?<![a-z0-9])s\s*(9|10|11)(?!\d)/i;
const PLUS = /s\s*(?:9|10|11)\s*(?:\+|plus|플러스)/i;
const ULTRA = /울트라|ultra/i;
const FIVE_G = /(?<![a-z0-9])5\s*g(?![a-z0-9])|셀룰러|lte/i;
const WIFI = /wi[\s-]*fi|와이파이/i;
const SEALED = /미\s*개봉|새\s*제품|새\s*상품|박스\s*씰|씰\s*봉인|unopened|sealed/i;
const UNLOCKED = /자급제|정상\s*해지|공기계|확정\s*기변/i;
const EXCLUDED = /삽니다|구해요|구합니다|구함|원해요|매입|판매대행|대량매입|케이스|커버|필름|키보드\s*만|박스\s*만|빈\s*박스|s\s*(?:9|10|11)\s*(?:fe|lite|라이트)|부품용|파손|분실|도난/i;
const USED = /사용감|중고|실사용|개봉품|단순\s*개봉|올갈이|리퍼/i;

function normalize(value) {
  return (value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function detectSpecs(text) {
  const normalized = normalize(text);
  const generationMatch = normalized.match(GENERATION);
  const generation = generationMatch ? `S${generationMatch[1]}` : '';
  const modelTier = ULTRA.test(normalized) ? 'ultra' : PLUS.test(normalized) ? 'plus' : generation ? 'base' : '';
  const has5g = FIVE_G.test(normalized);
  const hasWifi = WIFI.test(normalized);
  const networkType = has5g ? '5g' : hasWifi ? 'wifi' : '';
  return { generation, modelTier, networkType };
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
  const generations = config.generations, networkTypes = config.network_types, modelTiers = config.model_tiers;
  const text = normalize(`${listing.title} ${listing.description || ''}`);
  const title = normalize(listing.title);
  const { generation, modelTier } = detectSpecs(title);
  const { networkType } = detectSpecs(text);

  if (listing.price <= 0) return { code: 'rejected', reasons: ['가격 없음'] };
  if (listing.price < config.min_price) return { code: 'rejected', reasons: [`최소 가격 미만 (${listing.price.toLocaleString('ko-KR')}원)`] };
  if (listing.price > config.max_price) return { code: 'rejected', reasons: [`예산 초과 (${listing.price.toLocaleString('ko-KR')}원)`] };
  if (!TAB.test(title) || !generation) return { code: 'rejected', reasons: ['갤럭시탭 S9~S11 본체 여부 불명확'] };
  if (!generations.includes(generation)) return { code: 'rejected', reasons: [`선택하지 않은 세대 (${generation})`] };
  if (EXCLUDED.test(title)) return { code: 'rejected', reasons: ['제외 키워드 포함'] };
  if (!modelTiers.includes(modelTier)) {
    const tierLabel = { base: 'S 기본형', plus: 'S+', ultra: 'Ultra' }[modelTier] || modelTier;
    return { code: 'rejected', reasons: [`선택하지 않은 모델 (${tierLabel})`] };
  }
  const modelLabel = modelTier === 'base' ? generation : modelTier === 'plus' ? `${generation}+` : `${generation} Ultra`;
  if (config.max_age_days) {
    const postedAt = parsePostedAt(listing.posted_at);
    if (!postedAt) return { code: 'rejected', reasons: ['게시일 확인 불가'] };
    const cutoff = new Date(Date.now() - config.max_age_days * 86400000);
    if (postedAt < cutoff) return { code: 'rejected', reasons: [`최근 ${config.max_age_days}일 이전 게시물`] };
  }
  if (!networkType) return { code: 'review', reasons: [`${modelLabel} · 5G/Wi-Fi 유형 확인 필요`] };
  if (!networkTypes.includes(networkType)) {
    const label = networkType === '5g' ? '5G 자급제' : 'Wi-Fi';
    return { code: 'rejected', reasons: [`선택하지 않은 유형 (${label})`] };
  }

  const reasons = [];
  const sealed = SEALED.test(text);
  if (!sealed) reasons.push('미개봉 문구 확인 필요');
  if (networkType === '5g' && !UNLOCKED.test(text)) reasons.push('자급제/정상해지 확인 필요');
  if (USED.test(text) && !sealed) reasons.push('사용 또는 개봉 정황');

  if (reasons.length) {
    return { code: 'review', reasons: [...new Set(reasons)].map((r) => `${modelLabel} · ${r}`) };
  }
  const label = `${modelLabel} ${networkType === '5g' ? '5G 자급제' : 'Wi-Fi'}`;
  return { code: 'match', reasons: [`${label} 조건 충족`] };
}
// ---- end rules.py port ----

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
function loadSettings(defaults) {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved) return saved;
  } catch (error) { /* ignore malformed local storage */ }
  return {
    min_price: defaults.min_price, max_price: defaults.max_price, max_age_days: defaults.max_age_days,
    generations: [...defaults.generations], model_tiers: [...defaults.model_tiers], network_types: [...defaults.network_types],
    platforms: { ...defaults.platforms },
  };
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (error) { /* storage unavailable */ }
}
function fillForm() {
  $('minPrice').value = settings.min_price; $('maxPrice').value = settings.max_price;
  $('maxAgeDays').value = String(settings.max_age_days);
  $('genS9').checked = settings.generations.includes('S9'); $('genS10').checked = settings.generations.includes('S10'); $('genS11').checked = settings.generations.includes('S11');
  $('tierBase').checked = settings.model_tiers.includes('base'); $('tierPlus').checked = settings.model_tiers.includes('plus'); $('tierUltra').checked = settings.model_tiers.includes('ultra');
  $('type5g').checked = settings.network_types.includes('5g'); $('typeWifi').checked = settings.network_types.includes('wifi');
  $('daangn').checked = settings.platforms.daangn; $('joongna').checked = settings.platforms.joongna; $('bunjang').checked = settings.platforms.bunjang;
}
function readForm() {
  const generations = [['S9', 'genS9'], ['S10', 'genS10'], ['S11', 'genS11']].filter(([, id]) => $(id).checked).map(([value]) => value);
  const modelTiers = [['base', 'tierBase'], ['plus', 'tierPlus'], ['ultra', 'tierUltra']].filter(([, id]) => $(id).checked).map(([value]) => value);
  const networkTypes = [['5g', 'type5g'], ['wifi', 'typeWifi']].filter(([, id]) => $(id).checked).map(([value]) => value);
  const minPrice = +$('minPrice').value, maxPrice = +$('maxPrice').value;
  return {
    min_price: minPrice, max_price: maxPrice, max_age_days: +$('maxAgeDays').value,
    generations, model_tiers: modelTiers, network_types: networkTypes,
    platforms: { daangn: $('daangn').checked, joongna: $('joongna').checked, bunjang: $('bunjang').checked },
  };
}
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
    .sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || '') || a.price - b.price);

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
    if (!settings) { settings = loadSettings(state.defaults || {}); fillForm(); }
    render();
  } catch (error) { $('statusText').textContent = '데이터를 불러오지 못했습니다'; }
}
$('refreshButton').addEventListener('click', loadState);
$('filters').addEventListener('click', (event) => {
  const button = event.target.closest('button'); if (!button) return;
  document.querySelectorAll('.filters button').forEach((x) => x.classList.remove('active'));
  button.classList.add('active'); currentFilter = button.dataset.filter; render();
});
function applySettings() {
  const next = readForm();
  if (!next.generations.length || !next.model_tiers.length || !next.network_types.length) return false;
  if (next.min_price > next.max_price) { toast('최소 가격은 최대 가격보다 작아야 합니다.'); return false; }
  settings = next; saveSettings(); render();
  $('autoSaveStatus').textContent = '이 브라우저에 저장됨';
  return true;
}
$('settingsForm').addEventListener('submit', (event) => event.preventDefault());
$('settingsForm').addEventListener('change', (event) => {
  const groups = [
    [['genS9', 'genS10', 'genS11'], '세대를 하나 이상 선택하세요.'],
    [['tierBase', 'tierPlus', 'tierUltra'], '모델 등급을 하나 이상 선택하세요.'],
    [['type5g', 'typeWifi'], '통신 유형을 하나 이상 선택하세요.'],
    [['daangn', 'joongna', 'bunjang'], '플랫폼을 하나 이상 선택하세요.'],
  ];
  for (const [ids, message] of groups) {
    if (ids.includes(event.target.id) && !ids.some((id) => $(id).checked)) { event.target.checked = true; toast(message); return; }
  }
  applySettings();
});
$('settingsForm').addEventListener('input', (event) => { if (event.target.type !== 'checkbox') applySettings(); });
loadState();
setInterval(loadState, 60000);
