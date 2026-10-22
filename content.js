// 각 탭에 주입되는 스크립트. 블록 단위 텍스트 추출, 하이라이트, 차이 이동, 스크롤 동기화를 담당한다.
(() => {
  // 확장을 새로고침/재설치하면 페이지에 남은 옛 스크립트의 chrome.* 연결이 끊긴다("Extension context invalidated").
  // 그래서 주입될 때마다 옛 인스턴스를 정리하고 새 인스턴스로 교체한다.
  try {
    window.__splitViewDiff?.dispose?.();
  } catch {
    // 옛 컨텍스트가 이미 끊겨 있으면 정리 중 오류가 날 수 있다. 무시하고 교체한다.
  }

  // 컨텍스트가 끊기면 chrome.runtime.id 가 undefined 가 된다.
  const alive = () => Boolean(chrome.runtime?.id);

  const MARK_CLASS = 'svd-mark';
  const CURRENT_CLASS = 'svd-current';
  const STYLE_ID = 'svd-style';
  const SKIP_TAGS = new Set(['TEXTAREA', 'SELECT', 'OPTION']);
  const SUPPRESS_MS = 150;
  const STYLE = `
    .svd-mark { border-radius: 2px; color: inherit !important; }
    .svd-left-mod    { background-color: rgba(255, 70, 70, 0.45) !important; }
    .svd-left-whole  { background-color: rgba(255, 70, 70, 0.22) !important; }
    .svd-right-mod   { background-color: rgba(40, 200, 90, 0.45) !important; }
    .svd-right-whole { background-color: rgba(40, 200, 90, 0.22) !important; }
    .svd-current     { outline: 2px solid #1a73e8 !important; outline-offset: 1px; }
  `;

  // blocks[i] = { nodes: Text[], starts: number[], text: string }
  let blocks = [];
  let anchors = [];
  let compareId = null;
  let syncEnabled = false;
  let suppressUntil = 0;
  let scrollQueued = false;
  let topsCache = null;

  function clear() {
    const parents = new Set();
    for (const span of document.querySelectorAll(`span.${MARK_CLASS}`)) {
      const parent = span.parentNode;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      parents.add(parent);
    }
    for (const parent of parents) parent.normalize();
    document.getElementById(STYLE_ID)?.remove();
    anchors = [];
    compareId = null;
  }

  function extract() {
    clear();
    const visible = new Map();
    const blockOf = new Map();

    const isVisible = (el) => {
      if (!visible.has(el)) {
        visible.set(el, !SKIP_TAGS.has(el.tagName) && el.checkVisibility({ checkVisibilityCSS: true }));
      }
      return visible.get(el);
    };

    const findBlock = (el) => {
      if (blockOf.has(el)) return blockOf.get(el);
      const display = getComputedStyle(el).display;
      const block = (display.startsWith('inline') || display === 'contents') && el.parentElement && el !== document.body
        ? findBlock(el.parentElement)
        : el;
      blockOf.set(el, block);
      return block;
    };

    const groups = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) continue;
      const block = findBlock(parent);
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }

    blocks = [];
    topsCache = null;
    for (const nodes of groups.values()) {
      const starts = [];
      let text = '';
      for (const node of nodes) {
        starts.push(text.length);
        text += node.data;
      }
      if (text.trim()) blocks.push({ nodes, starts, text });
    }
    return blocks.map((b) => b.text);
  }

  // [s, e) 문자 범위를 span 으로 감싼다. 뒤쪽 범위부터 처리해야 앞쪽 오프셋이 유지된다.
  function wrap(block, s, e, className, id) {
    const { nodes, starts, text } = block;
    for (let k = nodes.length - 1; k >= 0; k--) {
      const ns = starts[k];
      const ne = k + 1 < nodes.length ? starts[k + 1] : text.length;
      if (ne <= s || ns >= e) continue;
      const ls = Math.max(s, ns) - ns;
      const le = Math.min(e, ne) - ns;
      if (!text.slice(ns + ls, ns + le).trim()) continue;

      const node = nodes[k];
      if (!node.parentNode) continue;
      if (le < node.data.length) node.splitText(le);
      const target = ls > 0 ? node.splitText(ls) : node;
      const span = document.createElement('span');
      span.className = `${MARK_CLASS} ${className}`;
      span.dataset.svdId = id;
      target.parentNode.insertBefore(span, target);
      span.appendChild(target);
    }
  }

  function apply(side, { highlights, anchors: blockAnchors, compareId: id }) {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE;
      (document.head || document.documentElement).appendChild(style);
    }

    for (const h of [...highlights].reverse()) {
      const block = blocks[h.block];
      if (!block) continue;
      for (const [s, e] of [...h.ranges].reverse()) {
        wrap(block, s, e, `svd-${side}-${h.kind}`, h.id);
      }
    }
    anchors = blockAnchors;
    compareId = id;
    topsCache = null;
  }

  function blockElement(index) {
    const node = blocks[index]?.nodes.find((n) => n.isConnected);
    return node?.parentElement ?? null;
  }

  function scrollToY(y) {
    suppressUntil = Date.now() + SUPPRESS_MS;
    window.scrollTo({ top: Math.max(0, y), behavior: 'instant' });
  }

  // 차이 id 로 이동한다. 이 쪽에 표시가 없으면(반대쪽에만 있는 내용) 기준 블록 위치로 이동한다.
  function navigate(id) {
    for (const el of document.querySelectorAll(`.${CURRENT_CLASS}`)) el.classList.remove(CURRENT_CLASS);
    const marks = document.querySelectorAll(`span.${MARK_CLASS}[data-svd-id="${id}"]`);
    marks.forEach((el) => el.classList.add(CURRENT_CLASS));

    const target = marks[0] ?? blockElement(anchors[id]);
    if (target) {
      scrollToY(target.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3);
    } else {
      scrollToY(document.documentElement.scrollHeight);
    }
  }

  // 블록별 문서 기준 y 좌표. 문서 높이나 창 너비가 바뀌면 다시 계산한다.
  function blockTops() {
    const key = `${document.documentElement.scrollHeight}x${window.innerWidth}`;
    if (topsCache?.key !== key) {
      const tops = blocks.map((_, i) => {
        const el = blockElement(i);
        return el ? el.getBoundingClientRect().top + window.scrollY : Infinity;
      });
      topsCache = { key, tops };
    }
    return topsCache.tops;
  }

  function scrollRatio() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? window.scrollY / max : 0;
  }

  // 화면 맨 위에 걸친 블록과 그 블록 안에서의 오프셋을 보낸다.
  function reportScroll() {
    scrollQueued = false;
    const y = window.scrollY;
    const msg = { type: 'scroll', ratio: scrollRatio(), compareId, block: -1, offset: 0 };
    if (compareId && blocks.length) {
      const tops = blockTops();
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= y + 1 && (msg.block < 0 || tops[i] >= tops[msg.block])) msg.block = i;
      }
      if (msg.block >= 0) msg.offset = y - tops[msg.block];
    }
    if (!alive()) return setSync(false);
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      setSync(false);
    }
  }

  function onScroll() {
    if (Date.now() < suppressUntil || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(reportScroll);
  }

  function syncTo({ compareId: id, block, offset, ratio }) {
    if (id && id === compareId && block >= 0 && block < blocks.length) {
      const top = blockTops()[block];
      if (Number.isFinite(top)) return scrollToY(top + offset);
    }
    const max = document.documentElement.scrollHeight - window.innerHeight;
    scrollToY(ratio * max);
  }

  function setSync(enabled) {
    syncEnabled = enabled;
    if (enabled) window.addEventListener('scroll', onScroll, { passive: true });
    else window.removeEventListener('scroll', onScroll);
  }

  function onMessage(msg) {
    if (msg?.type === 'syncTo' && syncEnabled) syncTo(msg);
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function dispose() {
    setSync(false);
    clear();
    chrome.runtime.onMessage.removeListener(onMessage);
  }

  window.__splitViewDiff = { extract, apply, navigate, setSync, clear, dispose };
})();
