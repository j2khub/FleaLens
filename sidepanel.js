// 플리렌즈 - Side Panel Script

const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const contentDiv = document.getElementById('content');

// ── 테마 관리 ──
const themeToggle = document.getElementById('theme-toggle');
const themeBtns = themeToggle.querySelectorAll('.theme-btn');

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
  themeBtns.forEach(btn => {
    const isActive = btn.dataset.theme === theme;
    btn.classList.toggle('bg-white', isActive && !root.classList.contains('dark'));
    btn.classList.toggle('dark:bg-gray-700', isActive);
    btn.classList.toggle('text-gray-900', isActive);
    btn.classList.toggle('dark:text-white', isActive);
    btn.classList.toggle('shadow-sm', isActive);
  });
}

function initTheme() {
  chrome.storage.local.get('theme', ({ theme }) => applyTheme(theme || 'system'));
}

themeBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    chrome.storage.local.set({ theme });
    applyTheme(theme);
  });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  chrome.storage.local.get('theme', ({ theme }) => {
    if (!theme || theme === 'system') applyTheme('system');
  });
});

initTheme();

// ── 검색 ──
let currentRawTitle = '';
let currentPrice = null;
let lastQuery = '';
let searchId = 0; // 검색 요청 ID (중복 방지)

searchBtn.addEventListener('click', () => {
  const query = searchInput.value.trim();
  if (query) { currentRawTitle = ''; currentPrice = null; chipsContainer.innerHTML = ''; performSearch(query); }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const query = searchInput.value.trim();
    if (query) { currentRawTitle = ''; currentPrice = null; chipsContainer.innerHTML = ''; performSearch(query); }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PRODUCT_DETECTED') {
    handleProductDetected(message);
  }
});

function handleProductDetected(message) {
  searchInput.value = message.productName;
  currentRawTitle = message.rawTitle || '';
  currentPrice = message.currentPrice || null;
  generateChips(message.rawTitle || message.productName, message.productName);
  performSearch(message.productName, message.currentPrice);
}

chrome.runtime.sendMessage({ type: 'GET_LAST_PRODUCT' }, (response) => {
  if (response && response.productName) handleProductDetected(response);
});

// ── 검색 URL ──
function getSearchUrl(platform, query) {
  const q = encodeURIComponent(query);
  return {
    daangn: `https://www.daangn.com/kr/buy-sell/?search=${q}`,
    bunjang: `https://m.bunjang.co.kr/search/products?q=${q}`,
    joongna: `https://web.joongna.com/search/${q}`,
  }[platform] || '#';
}

// ── 플랫폼 정의 ──
const PLATFORMS = [
  { key: 'daangn', name: '당근', dot: 'bg-daangn', hex: '#FF6F0F' },
  { key: 'bunjang', name: '번개장터', dot: 'bg-bunjang', hex: '#FF0048' },
  { key: 'joongna', name: '중고나라', dot: 'bg-joongna', hex: '#21C97D' },
];

// ── 순차 검색 ──
async function performSearch(query, price = null) {
  const thisSearch = ++searchId;
  lastQuery = query;
  currentPrice = price;
  searchBtn.disabled = true;

  // 초기 레이아웃: 상품 카드 + 시세 요약(스켈레톤) + 플랫폼별 로딩
  const showRaw = currentRawTitle && currentRawTitle !== query;
  contentDiv.innerHTML = `
    <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
      ${showRaw ? `<p class="text-[11px] text-gray-400 leading-snug mb-1 truncate" title="${esc(currentRawTitle)}">${esc(currentRawTitle)}</p>` : ''}
      <p class="text-sm font-semibold leading-snug">${esc(query)}</p>
      ${price ? `<p class="text-xs text-gray-400 mt-1">현재 가격 <span class="font-semibold text-gray-600 dark:text-gray-300">${fmt(price)}</span></p>` : ''}
    </div>
    <div id="verdict-slot"></div>
    <div id="summary-slot">
      <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
        <p class="text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-3">시세 요약</p>
        <div class="grid grid-cols-3 gap-2">
          ${skelCell()}${skelCell()}${skelCell()}
        </div>
      </div>
    </div>
    ${PLATFORMS.map(p => `<div id="platform-${p.key}">${platformLoading(p)}</div>`).join('')}
    <p id="footer-slot" class="text-center text-[11px] text-gray-300 dark:text-gray-600 pb-2">조회 중...</p>
  `;

  // 3개 플랫폼 병렬 요청, 각각 도착하면 즉시 렌더
  const results = {};
  const promises = PLATFORMS.map(async (p) => {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'SEARCH_PLATFORM', query, platform: p.key });
      results[p.key] = data;
    } catch (e) {
      results[p.key] = { error: true, items: [], hasMore: false };
    }
    if (thisSearch !== searchId) return; // 새 검색 시작됨
    updatePlatformCard(p, results[p.key]);
    updateSummary(results);
  });

  await Promise.all(promises);
  if (thisSearch === searchId) searchBtn.disabled = false;
}

// ── 플랫폼 로딩 카드 ──
function platformLoading(p) {
  return `
    <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full ${p.dot}"></span>
        <span class="text-sm font-semibold">${p.name}</span>
        <div class="w-3 h-3 border border-gray-300 dark:border-gray-600 border-t-transparent rounded-full animate-spin ml-auto"></div>
      </div>
    </div>
  `;
}

function skelCell() {
  return `<div class="text-center rounded-lg bg-gray-50 dark:bg-gray-800 py-2.5"><div class="h-3 w-10 bg-gray-200 dark:bg-gray-700 rounded mx-auto mb-1"></div><div class="h-4 w-12 bg-gray-200 dark:bg-gray-700 rounded mx-auto"></div></div>`;
}

// ── 플랫폼 카드 업데이트 ──
function updatePlatformCard(p, data) {
  const slot = document.getElementById(`platform-${p.key}`);
  if (!slot) return;
  const searchUrl = getSearchUrl(p.key, lastQuery);

  if (data.error || data.items.length === 0) {
    const msg = data.error ? '조회에 실패했어요' : '검색 결과 없음';
    slot.innerHTML = `
      <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${p.dot}"></span>
          <span class="text-sm font-semibold">${p.name}</span>
        </div>
        <p class="text-xs text-gray-400 mt-2">${msg}</p>
        <a href="${searchUrl}" target="_blank" rel="noopener noreferrer"
          class="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 mt-2 transition-colors">
          직접 검색하기
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
        </a>
      </div>
    `;
    return;
  }

  const prices = data.items.map(i => i.price);
  const pAvg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pMinItem = data.items.find(i => i.price === pMin);
  const pMaxItem = data.items.find(i => i.price === pMax);
  const countLabel = data.hasMore ? prices.length + '+' : prices.length;

  slot.innerHTML = `
    <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-2">
          <span class="w-2 h-2 rounded-full ${p.dot}"></span>
          <span class="text-sm font-semibold">${p.name}</span>
        </div>
        <a href="${searchUrl}" target="_blank"
          class="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 px-2 py-0.5 rounded-full transition-colors cursor-pointer">
          ${countLabel}건
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </a>
      </div>
      <div class="grid grid-cols-3 gap-3 text-center mb-3">
        <div>
          <p class="text-[10px] text-gray-400">평균</p>
          <p class="text-xs font-semibold text-gray-700 dark:text-gray-200">${fmt(pAvg)}</p>
        </div>
        <div>
          <p class="text-[10px] text-gray-400">최저</p>
          ${pMinItem?.url
            ? `<a href="${pMinItem.url}" target="_blank" class="text-xs font-semibold text-good hover:underline cursor-pointer">${fmt(pMin)}</a>`
            : `<p class="text-xs font-semibold text-gray-700 dark:text-gray-200">${fmt(pMin)}</p>`}
        </div>
        <div>
          <p class="text-[10px] text-gray-400">최고</p>
          ${pMaxItem?.url
            ? `<a href="${pMaxItem.url}" target="_blank" class="text-xs font-semibold text-expensive hover:underline cursor-pointer">${fmt(pMax)}</a>`
            : `<p class="text-xs font-semibold text-gray-700 dark:text-gray-200">${fmt(pMax)}</p>`}
        </div>
      </div>
      <div class="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div class="h-full rounded-full opacity-70" style="width:100%;background:${p.hex}"></div>
      </div>
    </div>
  `;
}

// ── 시세 요약 + 판정 업데이트 ──
function updateSummary(results) {
  let allItems = [];
  PLATFORMS.forEach(p => {
    const d = results[p.key];
    if (d && !d.error) d.items.forEach(i => allItems.push(i));
  });

  const summarySlot = document.getElementById('summary-slot');
  const verdictSlot = document.getElementById('verdict-slot');
  const footerSlot = document.getElementById('footer-slot');

  const doneCount = PLATFORMS.filter(p => results[p.key]).length;

  if (allItems.length === 0) {
    if (summarySlot) summarySlot.innerHTML = '';
    if (footerSlot) footerSlot.textContent = doneCount < 3 ? '조회 중...' : '매물을 찾지 못했어요';
    return;
  }

  const allPrices = allItems.map(i => i.price);
  const avg = Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length);
  const min = Math.min(...allPrices);
  const max = Math.max(...allPrices);
  const minItem = allItems.find(i => i.price === min);
  const maxItem = allItems.find(i => i.price === max);

  if (summarySlot) {
    summarySlot.innerHTML = `
      <div class="rounded-xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-4">
        <p class="text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-3">시세 요약</p>
        <div class="grid grid-cols-3 gap-2">
          ${priceCell('최저', min, 'text-good', minItem)}
          <div class="text-center rounded-lg bg-primary/5 dark:bg-primary/10 py-2.5">
            <p class="text-[10px] text-gray-400 mb-0.5">평균</p>
            <p class="text-sm font-bold text-primary">${fmtShort(avg)}</p>
          </div>
          ${priceCell('최고', max, 'text-expensive', maxItem)}
        </div>
      </div>
    `;
  }

  // 가격 판정 (비교군 2개 이상일 때만)
  if (verdictSlot && currentPrice && allItems.length >= 2) {
    const ratio = currentPrice / avg;
    let cls, text;
    if (ratio <= 0.85) {
      cls = 'bg-good-bg dark:bg-good-bg-dark text-good';
      text = `평균보다 ${Math.round((1 - ratio) * 100)}% 저렴해요`;
    } else if (ratio <= 1.1) {
      cls = 'bg-normal-bg dark:bg-normal-bg-dark text-normal';
      text = '적정한 가격이에요';
    } else {
      cls = 'bg-expensive-bg dark:bg-expensive-bg-dark text-expensive';
      text = `평균보다 ${Math.round((ratio - 1) * 100)}% 비싸요`;
    }
    verdictSlot.innerHTML = `
      <div class="rounded-xl ${cls} px-4 py-3">
        <p class="text-[11px] opacity-70 mb-0.5">가격 판정</p>
        <p class="text-sm font-bold">${text}</p>
      </div>
    `;
  }

  // 푸터
  const anyMore = PLATFORMS.some(p => results[p.key]?.hasMore);
  if (footerSlot) {
    footerSlot.textContent = doneCount < 3
      ? `${anyMore ? allPrices.length + '+' : allPrices.length}개 매물 (${doneCount}/3 완료)`
      : `총 ${anyMore ? allPrices.length + '+' : allPrices.length}개 매물 비교 완료`;
  }
}

// ── 추천 키워드 칩 ──
const chipsContainer = document.getElementById('keyword-chips');

function generateChips(rawTitle, currentQuery) {
  chipsContainer.innerHTML = '';
  if (!rawTitle) return;

  // 원본에서 키워드 추출: 브랜드, 모델명, 제품 유형 등
  const raw = rawTitle
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[#"'\[\]\(\)]/g, '')
    .replace(/\s*[-|]\s*(당근마켓|번개장터|중고나라|당근).*$/i, '')
    .replace(/\s*\|\s*중고나라.*$/i, '');

  // 구분자로 분리
  const parts = raw.split(/[/|·•ㅡ,]/).map(s => s.trim()).filter(s => s.length > 1);

  // 각 파트에서 의미 있는 단어 조합 생성
  const chips = new Set();
  const allWords = [];

  parts.forEach(part => {
    const words = part.split(/\s+/).filter(w => w.length > 0);
    words.forEach(w => allWords.push(w));
  });

  // 노이즈 단어
  const noise = /^(급|팝니다|판매|양도|삽니다|새상품|새제품|미사용|미개봉|리퍼|정상|작동|사용감적음|사용감있음|깨끗|하자없음|풀박스|풀세트|풀셋|정품|자급제|공기계|택포|직거래|네고|무료배송|그냥|새폰|중고폰|급처|급매|떨이|프리미엄|가성비|최정가|상태좋음|상태양호|포함|일괄|예약중|끌올|나눔|판매완료|새거|중고|합니다|입니다|해요|팔아요)$/i;

  const meaningful = allWords.filter(w => !noise.test(w) && w.length > 1);

  // 칩 조합 생성
  // 1) 전체 의미있는 단어 (현재 검색어와 다를 때)
  const fullChip = meaningful.join(' ');
  if (fullChip && fullChip !== currentQuery) {
    chips.add(fullChip);
  }

  // 2) 브랜드 + 모델 (앞 2~3 단어)
  if (meaningful.length >= 3) {
    chips.add(meaningful.slice(0, 3).join(' '));
    chips.add(meaningful.slice(0, 2).join(' '));
  }

  // 3) 핵심 단어만 (영문+숫자 포함 단어 = 모델명일 확률 높음)
  const modelWords = meaningful.filter(w => /[a-zA-Z0-9]/.test(w));
  const koreanWords = meaningful.filter(w => /[가-힣]/.test(w) && !/[a-zA-Z0-9]/.test(w));
  if (modelWords.length > 0 && koreanWords.length > 0) {
    chips.add([...koreanWords.slice(0, 1), ...modelWords].join(' '));
  }

  // 현재 검색어와 동일한 칩은 제거, 40자 초과 제거
  chips.delete(currentQuery);
  const chipArray = [...chips].filter(c => c.length >= 2 && c.length <= 40).slice(0, 4);

  chipArray.forEach(chip => {
    const el = document.createElement('button');
    el.textContent = chip;
    el.className = 'text-[11px] px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-primary/10 hover:text-primary dark:hover:bg-primary/20 transition-colors cursor-pointer truncate max-w-[200px]';
    el.addEventListener('click', () => {
      searchInput.value = chip;
      currentRawTitle = '';
      currentPrice = null;
      performSearch(chip);
    });
    chipsContainer.appendChild(el);
  });
}

// ── 유틸 ──
function priceCell(label, price, colorClass, item) {
  const inner = item?.url
    ? `<a href="${item.url}" target="_blank" class="text-sm font-bold ${colorClass} hover:underline cursor-pointer">${fmtShort(price)}</a>`
    : `<p class="text-sm font-bold ${colorClass}">${fmtShort(price)}</p>`;
  return `
    <div class="text-center rounded-lg bg-gray-50 dark:bg-gray-800 py-2.5">
      <p class="text-[10px] text-gray-400 mb-0.5">${label}</p>
      ${inner}
    </div>
  `;
}

function fmt(n) { return n.toLocaleString('ko-KR') + '원'; }

function fmtShort(n) {
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
  if (n >= 10000) {
    const man = Math.floor(n / 10000);
    const rest = Math.round((n % 10000) / 1000);
    return rest > 0 ? `${man}.${rest}만` : `${man}만`;
  }
  return n.toLocaleString('ko-KR') + '원';
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
