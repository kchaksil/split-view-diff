// 비교 알고리즘 (Myers diff) 과 하이라이트 범위 계산.
// 페이지와 무관한 순수 함수만 두어 Node 에서도 테스트할 수 있게 한다.

const MAX_EDIT_DISTANCE = 4000;

// a, b: 문자열 배열. 결과: ['=', i, j] | ['-', i] | ['+', j] 의 순서열.
export function diff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push(['=', i, i]);
  for (const op of myers(a.slice(start, endA), b.slice(start, endB))) {
    if (op[0] === '=') ops.push(['=', op[1] + start, op[2] + start]);
    else ops.push([op[0], op[1] + start]);
  }
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push(['=', i, j]);
  return ops;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ['+', j]);
  if (m === 0) return a.map((_, i) => ['-', i]);

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])
        ? v[off + k + 1]
        : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice(off - d, off + d + 1));
        return backtrack(trace, n, m);
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }

  // 차이가 너무 많으면 전부 삭제/추가로 취급한다.
  return [...a.map((_, i) => ['-', i]), ...b.map((_, j) => ['+', j])];
}

function backtrack(trace, n, m) {
  const ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1];
    const get = (k) => prev[k + d - 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['=', x - 1, y - 1]);
      x--;
      y--;
    }
    if (x === prevX) ops.push(['+', y - 1]);
    else ops.push(['-', x - 1]);
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push(['=', x - 1, y - 1]);
    x--;
    y--;
  }
  return ops.reverse();
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const SIMILARITY_THRESHOLD = 0.3;

function tokenize(text) {
  const tokens = [];
  for (const match of text.matchAll(TOKEN)) {
    const s = match.index;
    const e = s + match[0].length;
    tokens.push({ s, e, key: /^\s/.test(match[0]) ? ' ' : match[0] });
  }
  return tokens;
}

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

// 블록 짝짓기용 유사도. 대소문자만 다른 블록도 "변경"으로 묶이도록 항상 소문자로 비교한다.
function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(' '));
  const wb = new Set(b.toLowerCase().split(' '));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return (2 * common) / (wa.size + wb.size);
}

// 공백만 사이에 둔 인접 범위는 하나로 합친다.
function mergeRanges(text, ranges) {
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && text.slice(last[1], r[0]).trim() === '') last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

function wordDiff(aText, bText, ignoreCase) {
  const keyOf = (t) => (ignoreCase ? t.key.toLowerCase() : t.key);
  const ta = tokenize(aText);
  const tb = tokenize(bText);
  const left = [];
  const right = [];
  for (const op of diff(ta.map(keyOf), tb.map(keyOf))) {
    if (op[0] === '-' && ta[op[1]].key !== ' ') left.push([ta[op[1]].s, ta[op[1]].e]);
    if (op[0] === '+' && tb[op[1]].key !== ' ') right.push([tb[op[1]].s, tb[op[1]].e]);
  }
  return [mergeRanges(aText, left), mergeRanges(bText, right)];
}

function wholeRange(text) {
  const s = text.length - text.trimStart().length;
  const e = text.trimEnd().length;
  return [[s, e]];
}

// leftBlocks, rightBlocks: 각 탭에서 추출한 블록 텍스트 배열.
// 결과:
//   left/right: 각 쪽에 칠할 { id, block, kind, ranges } 목록 (id 는 차이 번호)
//   leftAnchors/rightAnchors: 차이 번호별로 각 쪽에서 스크롤할 블록 번호
//   leftToRight/rightToLeft: 스크롤 동기화용 블록 대응표
export function computeHighlights(leftBlocks, rightBlocks, { ignoreCase = false } = {}) {
  const key = ignoreCase ? (t) => normalize(t).toLowerCase() : normalize;
  const aKeys = leftBlocks.map(key);
  const bKeys = rightBlocks.map(key);
  const left = [];
  const right = [];
  const leftAnchors = [];
  const rightAnchors = [];
  const leftToRight = new Array(aKeys.length).fill(0);
  const rightToLeft = new Array(bKeys.length).fill(0);
  const stats = { modified: 0, removed: 0, added: 0 };
  let nextA = 0;
  let nextB = 0;
  let pendingA = [];
  let pendingB = [];

  const addItem = (l, r, leftAnchor, rightAnchor) => {
    const id = leftAnchors.length;
    if (l) left.push({ id, ...l });
    if (r) right.push({ id, ...r });
    leftAnchors.push(leftAnchor);
    rightAnchors.push(rightAnchor);
  };

  // 한쪽에만 있는 블록은 반대쪽에서 "들어갔어야 할 자리"(다음 일치 블록)를 기준점으로 삼는다.
  const flush = () => {
    const endA = nextA + pendingA.length;
    const endB = nextB + pendingB.length;
    const count = Math.max(pendingA.length, pendingB.length);
    for (let k = 0; k < count; k++) {
      const i = pendingA[k];
      const j = pendingB[k];
      if (i !== undefined && j !== undefined && similarity(aKeys[i], bKeys[j]) >= SIMILARITY_THRESHOLD) {
        leftToRight[i] = j;
        rightToLeft[j] = i;
        const [lr, rr] = wordDiff(leftBlocks[i], rightBlocks[j], ignoreCase);
        if (!lr.length && !rr.length) continue;
        addItem(
          lr.length && { block: i, kind: 'mod', ranges: lr },
          rr.length && { block: j, kind: 'mod', ranges: rr },
          i,
          j,
        );
        stats.modified++;
        continue;
      }
      if (i !== undefined) {
        leftToRight[i] = j ?? endB;
        addItem({ block: i, kind: 'whole', ranges: wholeRange(leftBlocks[i]) }, null, i, j ?? endB);
        stats.removed++;
      }
      if (j !== undefined) {
        rightToLeft[j] = i ?? endA;
        addItem(null, { block: j, kind: 'whole', ranges: wholeRange(rightBlocks[j]) }, i ?? endA, j);
        stats.added++;
      }
    }
    pendingA = [];
    pendingB = [];
  };

  for (const op of diff(aKeys, bKeys)) {
    if (op[0] === '=') {
      flush();
      leftToRight[op[1]] = op[2];
      rightToLeft[op[2]] = op[1];
      nextA = op[1] + 1;
      nextB = op[2] + 1;
    } else if (op[0] === '-') {
      pendingA.push(op[1]);
    } else {
      pendingB.push(op[1]);
    }
  }
  flush();

  return { left, right, leftAnchors, rightAnchors, leftToRight, rightToLeft, stats, total: leftAnchors.length };
}
