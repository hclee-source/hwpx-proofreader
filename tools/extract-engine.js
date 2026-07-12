// 검출 엔진 추출기 — index.html의 규칙 데이터·검출기를 확장용 engine.js로 생성
//
// 사용: node tools/extract-engine.js [출력경로]
//   기본 출력: ../hwp-bridge/extension/engine.js
//
// index.html이 단일 파일 원칙의 정본이고, engine.js는 여기서 생성되는 산출물이다.
// index.html의 규칙·검출기를 수정했다면 이 스크립트를 다시 실행해 동기화한다.
// 추출 마커(아래 SLICES)를 index.html에서 바꾸면 여기도 함께 고칠 것 (tests/rules_test.js와 동일 관행).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const outPath = process.argv[2] || path.join(ROOT, '..', 'hwp-bridge', 'extension', 'engine.js');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.find(s => s.includes('CURATED_CATEGORIES'));
if (!src) { console.error('index.html에서 규칙 구간을 찾지 못했습니다'); process.exit(1); }

function slice(startMarker, endMarker) {
  const s = src.indexOf(startMarker), e = src.indexOf(endMarker);
  if (s < 0 || e < 0 || e <= s) {
    console.error('추출 마커 실패:', JSON.stringify(startMarker), s, JSON.stringify(endMarker), e);
    process.exit(1);
  }
  return src.slice(s, e);
}

const blockRules  = slice('const RULESET_VERSION', '// ========== 상태 관리');
const blockInject = slice('// 프리셋 규칙 주입', 'function saveRules');
const blockDetect = slice('const CHO  =', 'function applyCorrection');

let commit = '(unknown)';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (_) {}

const out = `// ⚠ 자동 생성 파일 — 직접 수정 금지.
// 생성: hwpx-proofreader 저장소에서 node tools/extract-engine.js
// 원본: index.html @ ${commit} (규칙·검출기의 정본은 index.html)
/* eslint-disable */
const HwpxEngine = (function () {
'use strict';

// 추출 블록이 참조하는 앱 전역의 스텁 (엔진은 상태를 외부에 저장하지 않는다)
const state = { rules: [], exceptions: [] };
const localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const showToast = () => {};

// ═══ [1] 내장 규칙 데이터 (index.html에서 추출) ═══
${blockRules}
// ═══ [2] 규칙 주입 (index.html에서 추출) ═══
${blockInject}
// ═══ [3] 검출기 (index.html에서 추출) ═══
${blockDetect}
// ═══ [4] 엔진 공개 API (extract-engine.js가 부가) ═══

injectRulesFromPresets(PRESETS); // state.rules ← 내장 규칙 전체

// 자동 검출기 목록 — default는 웹 도구(index.html) 사이드바 기본값과 동일
const AUTO_DETECTORS = [
  { key: 'jamo',        fn: detectJamoSeparation,  def: false },
  { key: 'particle',    fn: detectParticleSpacing, def: true  },
  { key: 'colon',       fn: detectColonSpacing,    def: false },
  { key: 'saisiot',     fn: detectSaisiot,         def: true  },
  { key: 'template',    fn: detectTemplateLeftover, def: true },
  { key: 'styleMix',    fn: detectStyleMix,        def: true  },
  { key: 'dupWord',     fn: detectDupWord,         def: true  },
  { key: 'durationGan', fn: detectDurationGan,     def: true  },
];

// paragraphs: 브리지 GET /text의 문단 텍스트 배열 (배열 인덱스 = para 좌표).
// opts: { rules: bool, jamo: bool, particle: bool, ... } — 생략 시 기본값.
// 반환: [{para, off, ruleId, category, categoryName, original, suggestion,
//         confidence, description?, contextBefore, contextAfter}] 문서 순 정렬.
function detectAll(paragraphs, opts) {
  opts = opts || {};
  // \\n 1문자 경계로 결합 — 문단 오프셋이 그대로 보존된다.
  // 문체 혼용처럼 문서 전체 빈도를 보는 검출기 때문에 문단별이 아니라 전체로 돌린다.
  const full = paragraphs.join('\\n');
  const starts = [];
  let acc = 0;
  for (const p of paragraphs) { starts.push(acc); acc += p.length + 1; }

  let raw = [];
  if (opts.rules !== false) raw = raw.concat(detectIssuesInText(full));
  for (const d of AUTO_DETECTORS) {
    const on = opts[d.key] !== undefined ? !!opts[d.key] : d.def;
    if (on) raw = raw.concat(d.fn(full));
  }

  const out = [];
  for (const it of raw) {
    if (it.selected === false) { /* 검토 전용(문체 혼용 등)도 목록엔 포함 */ }
    // position(전체 텍스트) → (para, off)
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= it.position) lo = mid; else hi = mid - 1;
    }
    const para = lo;
    const off = it.position - starts[para];
    // 문단 경계(결합용 \\n)에 걸친 매치는 한글 쪽에서 치환 불가 → 제외
    if (off + String(it.original).length > paragraphs[para].length) continue;
    out.push({
      para, off,
      ruleId: it.ruleId, category: it.category, categoryName: it.categoryName,
      original: it.original, suggestion: it.suggestion,
      confidence: it.confidence, description: it.description,
      contextBefore: it.contextBefore, contextAfter: it.contextAfter,
      selected: it.selected !== false,
    });
  }
  out.sort((a, b) => a.para - b.para || a.off - b.off);

  // 중첩 dedup — 규칙과 자동 검출기가 같은 자리를 잡는 경우(' 라고 '→'라고 ' vs ' 라고'→'라고')
  // 적용 결과가 동일하면 하나만 남긴다 (원문이 짧은 쪽 = 더 국소적인 이슈 우선).
  const applied = it => {
    const t = paragraphs[it.para];
    return t.slice(0, it.off) + it.suggestion + t.slice(it.off + it.original.length);
  };
  const deduped = [];
  for (const it of out) {
    const dupIdx = deduped.findIndex(prev =>
      prev.para === it.para &&
      prev.off < it.off + it.original.length &&
      it.off < prev.off + prev.original.length &&
      applied(prev) === applied(it));
    if (dupIdx === -1) deduped.push(it);
    else if (it.original.length < deduped[dupIdx].original.length) deduped[dupIdx] = it;
  }
  return deduped;
}

return {
  detectAll,
  detectIssuesInText,
  ruleCount: () => state.rules.length,
  RULESET_VERSION,
  CAT_NAMES,
};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = HwpxEngine;
if (typeof globalThis !== 'undefined') globalThis.HwpxEngine = HwpxEngine;
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out);

// 생성물 구문 검사
try {
  new Function(out);
} catch (e) {
  console.error('생성된 engine.js 구문 오류:', e.message);
  process.exit(1);
}
console.log('OK →', outPath, `(${Math.round(out.length / 1024)}KB, 원본 @ ${commit})`);
