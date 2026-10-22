import { computeHighlights } from './diff.js';

const SPLIT_VIEW_ID_NONE = chrome.tabs.SPLIT_VIEW_ID_NONE ?? -1;
const DEFAULT_SETTINGS = { ignoreCase: false, syncScroll: false };

// 창별 비교 상태. 서비스 워커가 내려가도 유지되도록 storage.session 에도 저장한다.
// { compareId, leftTabId, rightTabId, total, current, leftToRight, rightToLeft }
const states = new Map();
const stateKey = (windowId) => `state:${windowId}`;

async function getState(windowId) {
  if (!states.has(windowId)) {
    const key = stateKey(windowId);
    states.set(windowId, (await chrome.storage.session.get(key))[key] ?? null);
  }
  return states.get(windowId);
}

async function setState(windowId, state) {
  states.set(windowId, state);
  if (state) await chrome.storage.session.set({ [stateKey(windowId)]: state });
  else await chrome.storage.session.remove(stateKey(windowId));
}

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS))) };
}

async function getSplitTabs(windowId) {
  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active) throw new Error('활성 탭을 찾을 수 없습니다.');
  if (!('splitViewId' in active)) {
    throw new Error('이 Chrome 버전은 분할 보기 API를 지원하지 않습니다. Chrome을 최신 버전으로 업데이트해 주세요.');
  }
  if (active.splitViewId === SPLIT_VIEW_ID_NONE) {
    throw new Error('현재 탭이 분할 보기 상태가 아닙니다.');
  }

  const tabs = (await chrome.tabs.query({ windowId }))
    .filter((t) => t.splitViewId === active.splitViewId)
    .sort((a, b) => a.index - b.index);
  if (tabs.length !== 2) throw new Error('분할 보기의 두 탭을 찾지 못했습니다.');
  return tabs;
}

async function run(tabId, func, args = []) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return result?.result;
  } catch (e) {
    throw new Error(`이 페이지에는 접근할 수 없습니다 (chrome://, 웹 스토어 등). ${e.message}`);
  }
}

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch((e) => {
    throw new Error(`이 페이지에는 접근할 수 없습니다 (chrome://, 웹 스토어 등). ${e.message}`);
  });
}

const navOf = (state) => (state ? { current: state.current, total: state.total } : null);

async function compare(windowId) {
  const [leftTab, rightTab] = await getSplitTabs(windowId);
  const settings = await getSettings();
  await Promise.all([inject(leftTab.id), inject(rightTab.id)]);

  const [leftBlocks, rightBlocks] = await Promise.all([
    run(leftTab.id, () => window.__splitViewDiff.extract()),
    run(rightTab.id, () => window.__splitViewDiff.extract()),
  ]);
  const result = computeHighlights(leftBlocks, rightBlocks, { ignoreCase: settings.ignoreCase });
  const compareId = crypto.randomUUID();

  const apply = (side, payload) => window.__splitViewDiff.apply(side, payload);
  await Promise.all([
    run(leftTab.id, apply, ['left', { highlights: result.left, anchors: result.leftAnchors, compareId }]),
    run(rightTab.id, apply, ['right', { highlights: result.right, anchors: result.rightAnchors, compareId }]),
  ]);
  await Promise.all([leftTab, rightTab].map((t) => setSync(t.id, settings.syncScroll)));

  await setState(windowId, {
    compareId,
    leftTabId: leftTab.id,
    rightTabId: rightTab.id,
    total: result.total,
    current: -1,
    leftToRight: result.leftToRight,
    rightToLeft: result.rightToLeft,
  });
  const nav = result.total > 0 ? await navigate(windowId, 1) : navOf(await getState(windowId));
  return { stats: result.stats, nav };
}

async function clear(windowId) {
  const tabs = await getSplitTabs(windowId);
  await Promise.all(tabs.map((t) => run(t.id, () => window.__splitViewDiff?.clear())));
  await setState(windowId, null);
  return { nav: null };
}

// delta: +1 다음, -1 이전. 끝에 도달하면 반대쪽 끝으로 돌아간다.
async function navigate(windowId, delta) {
  const state = await getState(windowId);
  if (!state?.total) throw new Error('먼저 비교를 실행해 주세요.');
  const current = state.current < 0 && delta < 0
    ? state.total - 1
    : (state.current + delta + state.total) % state.total;
  await setState(windowId, { ...state, current });

  const go = (id) => window.__splitViewDiff?.navigate(id);
  await Promise.all([state.leftTabId, state.rightTabId].map((id) => run(id, go, [current]).catch(() => {})));
  return navOf({ ...state, current });
}

async function setSync(tabId, enabled) {
  await run(tabId, (on) => window.__splitViewDiff?.setSync(on), [enabled]).catch(() => {});
}

async function updateSettings(windowId, changes) {
  const before = await getSettings();
  await chrome.storage.local.set(changes);

  if ('syncScroll' in changes && changes.syncScroll !== before.syncScroll) {
    const tabs = await getSplitTabs(windowId).catch(() => []);
    for (const t of tabs) {
      if (changes.syncScroll) await inject(t.id).catch(() => {});
      await setSync(t.id, changes.syncScroll);
    }
  }
  if ('ignoreCase' in changes && changes.ignoreCase !== before.ignoreCase && (await getState(windowId))) {
    return compare(windowId);
  }
  return { nav: navOf(await getState(windowId)) };
}

async function status(windowId) {
  return { nav: navOf(await getState(windowId)), settings: await getSettings() };
}

// 한쪽 탭의 스크롤 위치를 반대쪽 탭에 전달한다. 비교 결과가 있으면 같은 블록끼리 맞추고, 없으면 비율로 맞춘다.
async function relayScroll(msg, tab) {
  if (!tab || tab.splitViewId === undefined || tab.splitViewId === SPLIT_VIEW_ID_NONE) return;
  const partner = (await chrome.tabs.query({ windowId: tab.windowId }))
    .find((t) => t.splitViewId === tab.splitViewId && t.id !== tab.id);
  if (!partner) return;

  const state = await getState(tab.windowId);
  const map = state?.leftTabId === tab.id ? state.leftToRight : state?.rightTabId === tab.id ? state.rightToLeft : null;
  const matched = map && msg.compareId === state.compareId && msg.block >= 0;
  chrome.tabs.sendMessage(partner.id, {
    type: 'syncTo',
    compareId: matched ? state.compareId : null,
    block: matched ? map[msg.block] : -1,
    offset: msg.offset,
    ratio: msg.ratio,
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'scroll') {
    relayScroll(msg, sender.tab);
    return false;
  }

  const handlers = {
    compare: () => compare(msg.windowId),
    clear: () => clear(msg.windowId),
    navigate: async () => ({ nav: await navigate(msg.windowId, msg.delta) }),
    settings: () => updateSettings(msg.windowId, msg.changes),
    status: () => status(msg.windowId),
  };
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler().then(
    (res) => sendResponse({ ok: true, ...res }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  const { id: windowId } = await chrome.windows.getLastFocused();
  const actions = {
    'run-compare': () => compare(windowId),
    'next-diff': () => navigate(windowId, 1),
    'prev-diff': () => navigate(windowId, -1),
  };
  actions[command]?.().catch((e) => console.warn('[Split View Diff]', e.message));
});

// 동기화가 켜져 있으면, 분할 보기 탭이 새 페이지를 불러올 때 스크립트를 다시 넣는다.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (tab.splitViewId === undefined || tab.splitViewId === SPLIT_VIEW_ID_NONE) return;
  if (!(await getSettings()).syncScroll) return;
  await inject(tabId).catch(() => {});
  await setSync(tabId, true);
});

chrome.windows.onRemoved.addListener((windowId) => setState(windowId, null));

// 확장을 새로고침/재설치하면 열려 있던 탭의 옛 스크립트는 chrome.* 연결이 끊긴 채 남는다.
// 분할 보기 탭에 새 스크립트를 바로 주입해 옛 인스턴스를 정리하고, 동기화 설정도 이어받는다.
chrome.runtime.onInstalled.addListener(async () => {
  const { syncScroll } = await getSettings();
  const tabs = (await chrome.tabs.query({}))
    .filter((t) => t.splitViewId !== undefined && t.splitViewId !== SPLIT_VIEW_ID_NONE);
  for (const t of tabs) {
    await inject(t.id).catch(() => {});
    await setSync(t.id, syncScroll);
  }
});
