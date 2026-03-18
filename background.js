// 플리렌즈 - Background Service Worker

// 지원 도메인 (단일 소스)
const SUPPORTED_HOSTS = [
  'www.daangn.com', 'm.daangn.com',
  'www.bunjang.co.kr', 'm.bunjang.co.kr',
  'web.joongna.com',
];
const SUPPORTED_PATTERNS = SUPPORTED_HOSTS.map(h => `https://${h}/*`);

// fetch 타임아웃 헬퍼
function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: SUPPORTED_PATTERNS });
  for (const tab of tabs) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    }).catch(() => {});
  }
});

// 익스텐션 아이콘 클릭 시 사이드패널 열기
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// 탭 닫힐 때 감지 데이터 정리
chrome.tabs.onRemoved.addListener((tabId) => {
  lastDetectedByTab.delete(tabId);
});

// 지원 사이트 방문 시 사이드패널 자동 활성화
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  try {
    const url = new URL(tab.url);
    if (SUPPORTED_HOSTS.includes(url.hostname)) {
      await chrome.sidePanel.setOptions({
        tabId,
        path: 'sidepanel.html',
        enabled: true,
      });
    }
  } catch (e) {
    // 유효하지 않은 URL 무시
  }
});

// 탭별 마지막 감지 상품 저장
const lastDetectedByTab = new Map();

// 캐시 (5분 TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCached(query, platform) {
  const key = `${query}::${platform}`;
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(query, platform, data) {
  cache.set(`${query}::${platform}`, { data, time: Date.now() });
  // 캐시 100개 초과 시 오래된 것 정리
  if (cache.size > 100) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 플랫폼별 개별 검색 (순차 표시용)
  if (message.type === 'SEARCH_PLATFORM') {
    const { query, platform } = message;
    const cached = getCached(query, platform);
    if (cached) {
      sendResponse(cached);
      return false;
    }
    const searchFn = { daangn: searchDaangn, bunjang: searchBunjang, joongna: searchJoongna }[platform];
    if (!searchFn) { sendResponse({ error: true, items: [], hasMore: false }); return false; }
    searchFn(query).then(result => {
      setCache(query, platform, result);
      sendResponse(result);
    }).catch(() => {
      sendResponse({ error: true, items: [], hasMore: false });
    });
    return true;
  }

  // content script → 상품 감지됨
  if (message.type === 'PRODUCT_DETECTED' && sender.tab) {
    lastDetectedByTab.set(sender.tab.id, message);
    chrome.sidePanel.setOptions({
      tabId: sender.tab.id,
      path: 'sidepanel.html',
      enabled: true,
    }).catch(() => {});
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  // 사이드패널이 열릴 때 현재 탭의 마지막 감지 상품 요청
  if (message.type === 'GET_LAST_PRODUCT') {
    // 현재 활성 탭 기준
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      sendResponse(tabId ? lastDetectedByTab.get(tabId) || null : null);
    });
    return true;
  }
});

const MAX_ITEMS = 50;

// 구매글 필터 (판매글만 남기기)
const BUY_KEYWORDS = /삽니다|매입|구합니다|구매합니다|구해요|구해봅니다|삽니당|사요|구입|매입합니다|삽니다요|찾습니다|찾아요|구함/;

function filterBuyPosts(items) {
  return items.filter(item => !BUY_KEYWORDS.test(item.name || ''));
}

function limitItems(items) {
  const filtered = filterBuyPosts(items);
  const hasMore = filtered.length > MAX_ITEMS;
  return { items: filtered.slice(0, MAX_ITEMS), hasMore };
}

// ── 당근마켓 검색 ──
async function searchDaangn(query) {
  // omit(전국) 먼저, 결과 없으면 include(지역) 폴백
  for (const cred of ['omit', 'include']) {
    try {
      const url = `https://www.daangn.com/kr/buy-sell/?search=${encodeURIComponent(query)}`;
      const response = await fetchWithTimeout(url, {
        credentials: cred,
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9',
        },
      });
      if (!response.ok) continue;
      const html = await response.text();
      const result = parseDaangnResults(html);
      if (result.items.length > 0) return result;
    } catch (e) {
      console.error('[플리렌즈] 당근 검색 실패:', e);
    }
  }
  return { error: true, items: [], hasMore: false };
}

function parseDaangnResults(html) {
  const items = [];

  // 1차: JSON-LD (schema.org Product) 파싱 — 당근은 이 형식으로 제공
  const jsonLdPattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  for (const m of html.matchAll(jsonLdPattern)) {
    try {
      let data = JSON.parse(m[1]);
      if (!Array.isArray(data)) data = [data];
      for (const entry of data) {
        // ItemList 안의 itemListElement 처리
        const products = entry['@type'] === 'ItemList'
          ? (entry.itemListElement || []).map(e => e.item || e)
          : entry['@type'] === 'Product' ? [entry] : [];
        for (const p of products) {
          const offer = p.offers || {};
          // 판매완료(OutOfStock) 제외
          if ((offer.availability || '').includes('OutOfStock')) continue;
          const price = parseInt(parseFloat(offer.price || 0), 10);
          if (price >= 1000 && price <= 100000000) {
            items.push({ price, platform: 'daangn', url: p.url || '', name: p.name || '' });
          }
        }
      }
    } catch (e) { /* 파싱 실패 무시 */ }
  }

  // 당근은 JSON-LD가 정확한 소스. 0건이면 폴백 없이 0건 반환
  // (정규식 폴백은 추천/광고 상품 가격을 잘못 잡아서 제거)
  const { items: limited, hasMore } = limitItems(items);
  return { error: false, items: limited, hasMore };
}

// ── 번개장터 검색 ──
async function searchBunjang(query) {
  // 1차: 비공식 API 시도
  try {
    const url = `https://api.bunjang.co.kr/api/1/find_v2.json?q=${encodeURIComponent(query)}&order=date&page=0&n=${MAX_ITEMS}`;
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const result = parseBunjangResults(data);
    if (result.items.length > 0) return result;
  } catch (e) {
    console.error('[플리렌즈] 번개장터 API 실패:', e);
  }

  // 2차: 공식 Open API 시도
  try {
    const url = `https://openapi.bunjang.co.kr/api/v1/products?q=${encodeURIComponent(query)}&size=${MAX_ITEMS}&sort=score`;
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json();
      const items = (data.data || data.list || []).map(item => {
        const pid = item.pid || item.id || item.productId || '';
        return {
          price: parseInt(item.price, 10),
          platform: 'bunjang',
          name: item.name || item.productName || '',
          url: pid ? `https://m.bunjang.co.kr/products/${pid}` : '',
        };
      }).filter(item => !isNaN(item.price) && item.price > 0);

      if (items.length > 0) {
        const { items: limited, hasMore } = limitItems(items);
        return { error: false, items: limited, hasMore };
      }
    }
  } catch (e) {
    console.error('[플리렌즈] 번개장터 Open API 실패:', e);
  }

  // 3차: 웹 페이지 파싱 폴백
  return searchBunjangFallback(query);
}

function parseBunjangResults(data) {
  const items = [];
  const list = data.list || data.items || [];

  list.forEach(item => {
    // 판매완료 제외 (status "0" = 판매중)
    if (item.status !== undefined && String(item.status) !== '0') return;
    const price = parseInt(item.price, 10);
    if (!isNaN(price) && price > 0) {
      const pid = item.pid || item.id || item.product_id || '';
      items.push({
        price,
        platform: 'bunjang',
        name: item.name || item.product_name || '',
        url: pid ? `https://m.bunjang.co.kr/products/${pid}` : '',
      });
    }
  });

  const { items: limited, hasMore } = limitItems(items);
  return { error: false, items: limited, hasMore };
}

async function searchBunjangFallback(query) {
  try {
    const url = `https://m.bunjang.co.kr/search/products?q=${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      headers: { 'Accept': 'text/html' },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();

    const items = [];
    const priceMatches = html.match(/(\d{1,3}(,\d{3})*)\s*원/g);
    if (priceMatches) {
      const seen = new Set();
      priceMatches.forEach(match => {
        const price = parseInt(match.replace(/[,원\s]/g, ''), 10);
        if (price >= 1000 && price <= 100000000 && !seen.has(price)) {
          seen.add(price);
          items.push({ price, platform: 'bunjang' });
        }
      });
    }

    const { items: limited, hasMore } = limitItems(items);
    return { error: false, items: limited, hasMore };
  } catch (e) {
    console.error('[플리렌즈] 번개장터 폴백 검색 실패:', e);
    return { error: true, items: [], hasMore: false };
  }
}

// ── 중고나라 검색 ──
async function searchJoongna(query) {
  try {
    const url = `https://web.joongna.com/search/${encodeURIComponent(query)}`;
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    return parseJoongnaResults(html);
  } catch (e) {
    console.error('[플리렌즈] 중고나라 검색 실패:', e);
    return { error: true, items: [], hasMore: false };
  }
}

function parseJoongnaResults(html) {
  const items = [];

  // 1차: __NEXT_DATA__ 에서 상품 목록 추출 (seq, title, price 포함)
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const jsonData = JSON.parse(nextDataMatch[1]);
      findJoongnaProducts(jsonData, items);
    } catch (e) { /* 파싱 실패 무시 */ }
  }

  if (items.length > 0) {
    const { items: limited, hasMore } = limitItems(items);
    return { error: false, items: limited, hasMore };
  }

  // 2차: "price" JSON 패턴 폴백
  const jsonItems = extractJsonPrices(html, 'joongna');
  if (jsonItems.length > 0) {
    const { items: limited, hasMore } = limitItems(jsonItems);
    return { error: false, items: limited, hasMore };
  }

  // 3차: 정규식 폴백
  const priceMatches = html.match(/(\d{1,3}(,\d{3})*)\s*원/g);
  if (priceMatches) {
    const seen = new Set();
    priceMatches.forEach(match => {
      const price = parseInt(match.replace(/[,원\s]/g, ''), 10);
      if (price >= 1000 && price <= 100000000 && !seen.has(price)) {
        seen.add(price);
        items.push({ price, platform: 'joongna', url: '' });
      }
    });
  }

  const { items: limited, hasMore } = limitItems(items);
  return { error: false, items: limited, hasMore };
}

// 중고나라 __NEXT_DATA__ 에서 상품 찾기 (seq + price 구조)
function findJoongnaProducts(obj, items, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return;

  // seq와 price가 함께 있는 객체 = 상품
  if (obj.seq && obj.price !== undefined) {
    // 판매완료 제외 (state 0 = 판매중)
    if (obj.state !== undefined && obj.state !== 0) return;
    const price = parseInt(obj.price, 10);
    if (!isNaN(price) && price >= 1000 && price <= 100000000) {
      items.push({
        price,
        platform: 'joongna',
        name: obj.title || obj.name || '',
        url: `https://web.joongna.com/product/${obj.seq}`,
      });
    }
    return; // 이미 상품을 찾았으므로 하위 탐색 불필요
  }

  if (Array.isArray(obj)) {
    obj.forEach(item => findJoongnaProducts(item, items, depth + 1));
  } else {
    Object.values(obj).forEach(val => {
      if (typeof val === 'object' && val !== null) {
        findJoongnaProducts(val, items, depth + 1);
      }
    });
  }
}

// ── 유틸리티 ──
// __NEXT_DATA__ 등 페이지 내 JSON에서 가격 추출
function extractJsonPrices(html, platform) {
  const items = [];

  // __NEXT_DATA__ 스크립트 태그에서 JSON 추출
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const jsonData = JSON.parse(nextDataMatch[1]);
      findPricesInObject(jsonData, items, platform);
    } catch (e) {
      // JSON 파싱 실패 무시
    }
  }

  // "price": 숫자 패턴 직접 추출
  const priceJsonMatches = html.matchAll(/"price"\s*:\s*"?(\d+)"?/g);
  const seen = new Set();
  for (const match of priceJsonMatches) {
    const price = parseInt(match[1], 10);
    if (price >= 1000 && price <= 100000000 && !seen.has(price)) {
      seen.add(price);
      items.push({ price, platform, url: '' });
    }
  }

  return items;
}

function findPricesInObject(obj, items, platform, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return;

  if (obj.price !== undefined) {
    const price = parseInt(obj.price, 10);
    if (!isNaN(price) && price >= 1000 && price <= 100000000) {
      const id = obj.id || obj.pid || obj.productId || '';
      let url = obj.url || obj.link || '';
      if (!url && id) {
        if (platform === 'daangn') url = `https://www.daangn.com/items/${id}`;
        else if (platform === 'bunjang') url = `https://m.bunjang.co.kr/products/${id}`;
        else if (platform === 'joongna') url = `https://web.joongna.com/product/${id}`;
      }
      items.push({ price, platform, name: obj.title || obj.name || '', url: url || '' });
    }
  }

  if (Array.isArray(obj)) {
    obj.forEach(item => findPricesInObject(item, items, platform, depth + 1));
  } else {
    Object.values(obj).forEach(val => {
      if (typeof val === 'object' && val !== null) {
        findPricesInObject(val, items, platform, depth + 1);
      }
    });
  }
}
