// 플리렌즈 - Content Script

(function () {
  'use strict';

  // 중복 실행 방지 (수동 주입 시)
  if (window.__fleaLensLoaded) return;
  window.__fleaLensLoaded = true;

  // 노이즈 키워드 정규식 (1회 컴파일)
  const NOISE_WORDS = [
    '팝니다', '판매합니다', '판매', '팔아요', '팔아봅니다',
    '양도', '양도합니다', '삽니다',
    '판매완료', '예약중', '끌올', '나눔', '무료나눔',
    '급처', '급매', '급구', '급구합니다', '떨이',
    '합니다', '입니다', '있습니다', '됩니다',
    '해요', '있어요', '드려요', '드립니다',
    '새상품', '새제품', '새거', '미사용', '미개봉', '리퍼',
    '거의새것', '거의새제품', '새거같은',
    'S급', 'A급', 'B급', 'C급',
    '상태좋음', '상태양호',
    '정상작동', '정상동작',
    '사용감적음', '사용감있음', '사용감많음', '사용감없음',
    '깨끗', '깨끗합니다', '깨끗해요',
    '하자없음', '하자없는', '고장없음',
    '가성비', '초경량', '초슬림', '초고속',
    '최저가', '최상급', '최정가', '특가', '한정',
    '프리미엄', '가격내림', '가격제안X',
    '무료배송', '택포', '직거래',
    '네고', '네고가능', '쿨거래',
    '당근해요',
    '풀박스', '풀셋', '풀세트',
    '정품', '국내정발', '자급제', '공기계',
    '포함', '일괄', '저렴하게',
    '내놓습니다', '내놓아요',
    '텍달린', '택달린', '텍 달린',
    '그냥', '새폰', '중고폰',
  ];
  const NOISE_PATTERN = new RegExp('(' + NOISE_WORDS.join('|') + ')', 'gi');

  const PLATFORM_CONFIG = {
    daangn: {
      name: '당근',
      hosts: ['www.daangn.com', 'm.daangn.com'],
      getProductName: () => getDaangnProductName(),
      getPrice: () => getDaangnPrice(),
      // 상세 페이지: /kr/buy-sell/{상품명}-{hash}/ (끝에 영숫자 해시 ID)
      // 제외: /kr/buy-sell/ (목록), /kr/buy-sell/s/ (지역), ?search= (검색)
      isProductPage: () => {
        const p = location.pathname;
        if (location.search.includes('search=') || location.search.includes('in=')) return false;
        // slug 끝에 8자 이상의 영숫자 해시가 있는 패턴만 상세 페이지
        return /\/kr\/buy-sell\/[^/]+-[a-z0-9]{8,}\/?$/.test(p);
      },
    },
    bunjang: {
      name: '번개장터',
      hosts: ['www.bunjang.co.kr', 'm.bunjang.co.kr'],
      getProductName: () => getBunjangProductName(),
      getPrice: () => getBunjangPrice(),
      // /products/{id} 또는 /product/{id}
      isProductPage: () => /\/products?\/\d+/.test(location.pathname),
    },
    joongna: {
      name: '중고나라',
      hosts: ['web.joongna.com'],
      getProductName: () => getJoongnaProductName(),
      getPrice: () => getJoongnaPrice(),
      // /product/{seq}
      isProductPage: () => /\/product\/\d+/.test(location.pathname),
    },
  };

  function detectPlatform() {
    const host = location.hostname;
    for (const [key, config] of Object.entries(PLATFORM_CONFIG)) {
      if (config.hosts.includes(host)) return key;
    }
    return null;
  }

  // ── 당근마켓 ──
  function getDaangnProductName() {
    // JSON-LD에서 추출
    const jsonLd = getJsonLdProduct();
    if (jsonLd?.name) return cleanProductName(jsonLd.name);

    const selectors = [
      'h1[class*="title"]',
      '[data-testid="article-title"]',
      'h1',
      'meta[property="og:title"]',
    ];
    return extractTextFromSelectors(selectors);
  }

  function getDaangnPrice() {
    const jsonLd = getJsonLdProduct();
    if (jsonLd?.offers?.price) return parseInt(parseFloat(jsonLd.offers.price), 10);
    return getPriceFromDom();
  }

  function getJsonLdProduct() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        let data = JSON.parse(script.textContent);
        if (!Array.isArray(data)) data = [data];
        for (const entry of data) {
          if (entry['@type'] === 'Product') return entry;
        }
      } catch (e) { /* 무시 */ }
    }
    return null;
  }

  // ── 번개장터 ──
  // API에서 가져온 상품 정보 캐시
  let bunjangProductCache = null;
  let bunjangCacheUrl = '';

  async function fetchBunjangProductInfo() {
    if (!isExtValid()) return null;
    const currentUrl = location.href;
    if (bunjangCacheUrl === currentUrl && bunjangProductCache) return bunjangProductCache;

    const pidMatch = location.pathname.match(/\/products?\/(\d+)/);
    if (!pidMatch) return null;
    const pid = pidMatch[1];

    // 1차: 검색 API로 pid 조회
    try {
      const res = await fetch(
        `https://api.bunjang.co.kr/api/1/find_v2.json?q=${pid}&n=5`,
        { credentials: 'omit' }
      );
      if (res.ok) {
        const data = await res.json();
        const item = (data.list || []).find(i => String(i.pid) === pid);
        if (item) {
          bunjangProductCache = item;
          bunjangCacheUrl = currentUrl;
          return bunjangProductCache;
        }
      }
    } catch (e) { /* 무시 */ }

    // 2차: document.title 대기 (SPA 렌더링 후 title이 바뀔 수 있음)
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const title = document.title;
      if (title && title !== '번개장터' && !title.startsWith('번개장터')) {
        const name = title.replace(/\s*-\s*번개장터.*$/, '').trim();
        if (name.length > 2) {
          bunjangProductCache = { name, price: null };
          bunjangCacheUrl = currentUrl;
          return bunjangProductCache;
        }
      }
    }

    return null;
  }

  function getBunjangProductName() {
    if (bunjangProductCache && bunjangCacheUrl === location.href) {
      const name = bunjangProductCache.name || bunjangProductCache.product_name || '';
      if (name) return cleanProductName(name);
    }
    return null;
  }

  function getBunjangPrice() {
    if (bunjangProductCache && bunjangCacheUrl === location.href) {
      const price = parseInt(bunjangProductCache.price, 10);
      if (!isNaN(price) && price >= 1000) return price;
    }
    return getPriceFromDom();
  }

  // ── 중고나라 ──
  function getJoongnaProductName() {
    // __NEXT_DATA__에서 추출 시도
    const nextData = getNextDataProduct();
    if (nextData) {
      const title = nextData.productTitle || nextData.title;
      if (title) return cleanProductName(title);
    }

    const selectors = [
      'h1[class*="title"]',
      '[class*="ProductName"]',
      'h1',
      'meta[property="og:title"]',
    ];
    return extractTextFromSelectors(selectors);
  }

  function getJoongnaPrice() {
    const nextData = getNextDataProduct();
    if (nextData) {
      const price = nextData.productPrice || nextData.price;
      if (price) return parseInt(price, 10);
    }
    return getPriceFromDom();
  }

  function getNextDataProduct() {
    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;
    try {
      const data = JSON.parse(script.textContent);
      return findProductInObject(data);
    } catch (e) { return null; }
  }

  function findProductInObject(obj, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return null;
    // productSeq + productTitle (상세 페이지)
    if (obj.productSeq && obj.productTitle) return obj;
    // seq + title (검색 결과)
    if (obj.seq && obj.price !== undefined && obj.title) return obj;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = findProductInObject(item, depth + 1);
        if (found) return found;
      }
    } else {
      for (const val of Object.values(obj)) {
        if (typeof val === 'object' && val !== null) {
          const found = findProductInObject(val, depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // ── 공통 유틸 ──
  function extractTextFromSelectors(selectors) {
    for (const selector of selectors) {
      if (selector.startsWith('meta')) {
        const meta = document.querySelector(selector);
        if (meta) return cleanProductName(meta.getAttribute('content'));
      } else {
        const el = document.querySelector(selector);
        if (el && el.textContent.trim()) {
          return cleanProductName(el.textContent.trim());
        }
      }
    }
    return null;
  }

  function cleanProductName(name) {
    if (!name) return null;

    let q = name;

    // 이모지 제거
    q = q.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '');

    // 특수기호 정리
    q = q.replace(/#/g, '');           // 해시태그
    q = q.replace(/["'"]/g, '');       // 따옴표
    q = q.replace(/\.{2,}/g, '');      // 연속 마침표

    // 플랫폼명 제거
    q = q.replace(/\s*[-|]\s*(당근마켓|번개장터|중고나라|당근).*$/i, '');
    q = q.replace(/\s*\|\s*중고나라.*$/i, '');

    // 괄호 내용 제거 — 단, 숫자+단위(스펙)는 보존
    // [새상품] [가격내림] 제거, [256GB] [2024년형] 보존
    q = q.replace(/\[([^\]]*)\]/g, (_, inner) => /\d/.test(inner) ? inner : '');
    q = q.replace(/\(([^)]*)\)/g, (_, inner) => /\d/.test(inner) ? inner : '');

    // 장문 설명/문장형 패턴 제거 (구분자 분리보다 먼저)
    q = q.replace(/필요하면.*$/i, '');
    q = q.replace(/원하시면.*$/i, '');
    q = q.replace(/갖다드릴.*$/i, '');
    q = q.replace(/갓다드릴.*$/i, '');
    q = q.replace(/가져다\s*드립.*$/i, '');
    q = q.replace(/문자\s*주세요.*$/i, '');
    q = q.replace(/구매하세요.*$/i, '');
    q = q.replace(/\d+원에\s*(구매|사서).*$/i, '');
    q = q.replace(/꼭\s*글.*$/i, '');
    q = q.replace(/사용감\s*있.*$/i, '');
    q = q.replace(/작동\s*잘.*$/i, '');
    q = q.replace(/이상\s*없.*$/i, '');
    q = q.replace(/아무\s*이상.*$/i, '');
    q = q.replace(/상태\s*(좋|양호|깨끗).*$/i, '');
    q = q.replace(/화질도.*$/i, '');
    q = q.replace(/기스\s*없.*$/i, '');
    q = q.replace(/별로\s*사용.*$/i, '');
    q = q.replace(/구매\s*후.*$/i, '');
    q = q.replace(/안쪽\s*겉쪽.*$/i, '');
    q = q.replace(/착용감\s*있.*$/i, '');

    // "급))" 같은 단독 급 패턴 (단어 경계에서만)
    q = q.replace(/(?:^|\s)급(?:\s|$)/g, ' ');

    // 노이즈 키워드 제거 (NOISE_PATTERN은 모듈 스코프에서 1회 컴파일)
    q = q.replace(NOISE_PATTERN, '');

    // 부가 정보 패턴 제거
    q = q.replace(/외부\s*박스.*$/i, '');
    q = q.replace(/내부\s*박스.*$/i, '');

    // 수량 표현 제거
    q = q.replace(/\d+개당/g, '');
    q = q.replace(/\d+\s*[개벌장팩권매대]+\s*(일괄|세트)?/g, '');

    // 오타 자음/모음 제거 (단어 끝에 붙은 ㅓ, ㅈ, ㅁ 등)
    q = q.replace(/([가-힣])[ㄱ-ㅎㅏ-ㅣ]+(?=\s|$)/g, '$1');
    q = q.replace(/(?<=\s)[ㄱ-ㅎㅏ-ㅣ]+(?=\s|$)/g, '');

    // 잔여 괄호/기호 정리
    q = q.replace(/[()]/g, '');
    q = q.replace(/\.(?=\s|$)/g, '');
    q = q.replace(/[,~!?\s]+/g, ' ').trim();

    // 구분자로 분리 → 가장 긴 구간 선택 (노이즈 제거 후)
    const segments = q.split(/[/|·•ㅡ]/).map(s => s.trim()).filter(s => s.length > 1);
    if (segments.length > 1) {
      q = segments.reduce((a, b) => a.length >= b.length ? a : b);
    }

    // 너무 짧으면 원본 첫 구간 사용
    if (q.length < 3 && segments.length > 0) {
      q = segments[0].replace(/[,\s]+/g, ' ').trim();
    }

    return q.slice(0, 40) || null;
  }

  function getPriceFromDom() {
    const selectors = [
      '[class*="price" i]',
      '[data-testid*="price"]',
    ];
    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const match = el.textContent.match(/(\d{1,3}(,\d{3})*)\s*원/);
          if (match) return parseInt(match[1].replace(/,/g, ''), 10);
        }
      } catch (e) { /* 무시 */ }
    }
    return null;
  }

  function getRawTitle() {
    // 번개장터: API 캐시에서
    if (bunjangProductCache && bunjangCacheUrl === location.href) {
      return (bunjangProductCache.name || '').slice(0, 80);
    }
    const el = document.querySelector('h1');
    if (el) return el.textContent.trim().slice(0, 80);
    const meta = document.querySelector('meta[property="og:title"]');
    if (meta) return meta.getAttribute('content')?.trim().slice(0, 80) || '';
    return '';
  }

  // 컨텍스트 유효 체크
  function isExtValid() { return !!chrome.runtime?.id; }

  // ── 메인 로직 ──
  let lastDetected = '';
  let detectGeneration = 0; // stale 호출 취소용

  async function detectAndNotify() {
    const gen = ++detectGeneration;
    try {
      if (!isExtValid()) return;
      const platform = detectPlatform();
      if (!platform) return;

      const config = PLATFORM_CONFIG[platform];
      if (!config.isProductPage()) return;

      if (platform === 'bunjang') {
        await fetchBunjangProductInfo();
      } else {
        await waitForContent();
      }

      if (!isExtValid() || gen !== detectGeneration) return;

      let productName = config.getProductName();

      if (!productName) {
        for (let i = 0; i < 3; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (!isExtValid() || gen !== detectGeneration) return;
          if (platform === 'bunjang') await fetchBunjangProductInfo();
          productName = config.getProductName();
          if (productName) break;
        }
      }
      if (!productName) return;

      const platformNames = ['번개장터', '당근마켓', '당근', '중고나라'];
      if (platformNames.includes(productName.trim())) return;

      const key = platform + ':' + productName;
      if (key === lastDetected) return;
      lastDetected = key;

      const currentPrice = config.getPrice();
      const rawTitle = getRawTitle();

      if (!isExtValid()) return;
      chrome.runtime.sendMessage({
        type: 'PRODUCT_DETECTED',
        productName,
        rawTitle,
        currentPrice,
        platform,
      }).catch(() => {});
    } catch (e) {
      // Extension context invalidated 등 — 조용히 종료
    }
  }

  function waitForContent() {
    return new Promise(resolve => {
      const platform = detectPlatform();

      const check = () => {
        // 번개장터 SPA: 실제 상품 관련 DOM이 렌더링될 때까지 대기
        if (platform === 'bunjang') {
          return document.querySelector('[class*="ProductName"]') ||
                 document.querySelector('[class*="product_name"]') ||
                 document.querySelector('[class*="productName"]') ||
                 document.querySelector('[class*="ProductInfo"]') ||
                 document.querySelector('[class*="detail"] [class*="name"]') ||
                 (document.title && document.title !== '번개장터' && !document.title.startsWith('번개장터'));
        }
        return document.querySelector('h1') ||
               document.querySelector('meta[property="og:title"]') ||
               document.getElementById('__NEXT_DATA__') ||
               document.querySelector('script[type="application/ld+json"]');
      };

      if (check()) { resolve(); return; }

      const observer = new MutationObserver((_, obs) => {
        if (check()) { obs.disconnect(); resolve(); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // SPA는 더 오래 기다림
      setTimeout(() => { observer.disconnect(); resolve(); }, 8000);
    });
  }

  // SPA 네비게이션 감지
  let lastUrl = location.href;
  let pollTimer = null;

  function cleanup() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.removeEventListener('popstate', onUrlChange);
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
  }

  function onUrlChange() {
    if (!isExtValid()) { cleanup(); return; }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastDetected = '';
      bunjangProductCache = null;
      bunjangCacheUrl = '';
      setTimeout(detectAndNotify, 1500);
    }
  }

  // 1) pushState / replaceState 가로채기
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    origPushState.apply(this, args);
    onUrlChange();
  };
  history.replaceState = function (...args) {
    origReplaceState.apply(this, args);
    onUrlChange();
  };

  // 2) popstate
  window.addEventListener('popstate', onUrlChange);

  // 3) 폴링 (pushState를 안 쓰는 SPA 대비)
  pollTimer = setInterval(() => {
    if (!isExtValid()) { cleanup(); return; }
    onUrlChange();
  }, 1500);

  detectAndNotify();
})();
