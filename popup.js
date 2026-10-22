const status = document.getElementById('status');
const position = document.getElementById('position');
const controls = document.querySelectorAll('button:not(.link), input');
const prevButton = document.getElementById('prev');
const nextButton = document.getElementById('next');
const ignoreCase = document.getElementById('ignoreCase');
const syncScroll = document.getElementById('syncScroll');

function show(text, isError = false) {
  status.textContent = text;
  status.className = isError ? 'error' : '';
}

function showNav(nav) {
  const hasDiffs = nav?.total > 0;
  position.textContent = hasDiffs ? `${nav.current + 1} / ${nav.total}` : '– / –';
  prevButton.disabled = nextButton.disabled = !hasDiffs;
}

function showStats({ modified, removed, added }) {
  show(modified + removed + added === 0
    ? '차이가 없습니다.'
    : `변경 ${modified} · 왼쪽에만 ${removed} · 오른쪽에만 ${added}`);
}

async function send(message, pendingText) {
  controls.forEach((c) => (c.disabled = true));
  if (pendingText) show(pendingText);
  let res;
  try {
    const { id: windowId } = await chrome.windows.getCurrent();
    res = await chrome.runtime.sendMessage({ ...message, windowId });
  } finally {
    controls.forEach((c) => (c.disabled = false));
  }
  if (!res?.ok) {
    show(res?.error ?? '알 수 없는 오류', true);
    return null;
  }
  showNav(res.nav);
  if (res.stats) showStats(res.stats);
  return res;
}

document.getElementById('compare').addEventListener('click', () => send({ type: 'compare' }, '비교 중…'));

document.getElementById('clear').addEventListener('click', async () => {
  if (await send({ type: 'clear' }, '지우는 중…')) show('표시를 지웠습니다.');
});

prevButton.addEventListener('click', () => send({ type: 'navigate', delta: -1 }));
nextButton.addEventListener('click', () => send({ type: 'navigate', delta: 1 }));

ignoreCase.addEventListener('change', () => {
  send({ type: 'settings', changes: { ignoreCase: ignoreCase.checked } }, '설정 적용 중…')
    .then((res) => res && !res.stats && show(''));
});

syncScroll.addEventListener('change', () => {
  send({ type: 'settings', changes: { syncScroll: syncScroll.checked } })
    .then((res) => res && show(syncScroll.checked ? '스크롤 동기화를 켰습니다.' : '스크롤 동기화를 껐습니다.'));
});

// Chrome 에 실제로 등록된 단축키를 보여 준다. 다른 확장과 겹치거나 업데이트로 추가된 명령은 키가 비어 있을 수 있다.
const COMMAND_ORDER = ['run-compare', 'prev-diff', 'next-diff'];
const COMMAND_LABELS = { 'run-compare': '비교', 'prev-diff': '이전 차이로 이동', 'next-diff': '다음 차이로 이동' };
// Chrome 은 키 이름을 UI 언어로 돌려준다 ("Alt+Shift+아래쪽 화살표"). 길어서 기호로 줄인다.
const KEY_SYMBOLS = [
  [/위쪽 화살표|Up/g, '↑'], [/아래쪽 화살표|Down/g, '↓'],
  [/왼쪽 화살표|Left/g, '←'], [/오른쪽 화살표|Right/g, '→'],
];

function formatShortcut(shortcut) {
  return KEY_SYMBOLS.reduce((s, [pattern, symbol]) => s.replace(pattern, symbol), shortcut);
}

async function showShortcuts() {
  const table = document.getElementById('shortcuts');
  const openButton = document.getElementById('openShortcuts');
  const all = await chrome.commands.getAll();
  const commands = COMMAND_ORDER.map((name) => all.find((c) => c.name === name)).filter(Boolean);

  const th = (text, className) => {
    const el = document.createElement('th');
    el.textContent = text;
    if (className) el.className = className;
    return el;
  };

  table.replaceChildren();
  const title = th('단축키', 'title');
  title.colSpan = 2;
  table.insertRow().append(title);
  for (const c of commands) {
    const row = table.insertRow();
    row.append(th(COMMAND_LABELS[c.name]));
    const cell = row.insertCell();
    if (c.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = formatShortcut(c.shortcut);
      cell.append(kbd);
    } else {
      cell.textContent = '미지정';
      cell.className = 'missing';
    }
  }
  openButton.hidden = commands.every((c) => c.shortcut);
}

document.getElementById('openShortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

(async () => {
  showShortcuts();
  const res = await send({ type: 'status' });
  if (!res) return;
  ignoreCase.checked = res.settings.ignoreCase;
  syncScroll.checked = res.settings.syncScroll;
})();
