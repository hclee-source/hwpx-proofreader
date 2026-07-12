// 검출 엔진 추출기 — index.html의 규칙 데이터·검출기를 hwp-bridge 패널용 engine.js로 생성
//
// 사용: node tools/extract-engine.js [출력경로]
//   기본 출력: ../hwp-bridge/panel/engine.js
//
// index.html이 단일 파일 원칙의 정본이고, engine.js는 여기서 생성되는 산출물이다.
// index.html의 규칙·검출기를 수정했다면 이 스크립트를 다시 실행해 동기화한다.
// 추출 마커(아래 SLICES)를 index.html에서 바꾸면 여기도 함께 고칠 것 (tests/rules_test.js와 동일 관행).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const outPath = process.argv[2] || path.join(ROOT, '..', 'hwp-bridge', 'panel', 'engine.js');

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.find(s => s.includes('CURATED_CATEGORIES'));
const srcAi = scripts.find(s => s.includes('AI_PROOFREAD_PROMPT'));
if (!src || !srcAi) { console.error('index.html에서 규칙/AI 구간을 찾지 못했습니다'); process.exit(1); }

function sliceOf(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker), e = text.indexOf(endMarker);
  if (s < 0 || e < 0 || e <= s) {
    console.error('추출 마커 실패:', JSON.stringify(startMarker), s, JSON.stringify(endMarker), e);
    process.exit(1);
  }
  return text.slice(s, e);
}
const slice = (a, b) => sliceOf(src, a, b);

const blockRules  = slice('const RULESET_VERSION', '// ========== 상태 관리');
const blockInject = slice('// 프리셋 규칙 주입', 'function saveRules');
const blockDetect = slice('const CHO  =', 'function applyCorrection');
// AI 심층 검수: 프롬프트 + JSON 파서 + Claude 호출 (공용 모듈 스크립트에서)
const blockAi = sliceOf(srcAi, 'const AI_PROOFREAD_PROMPT', '// HWPX 교정(script 3)');
// 문제집 검수: 공통 파서 + examAnalyze + 정답 분포 + 표/CSV 내보내기 (소스 독립부만)
const blockExam = sliceOf(srcAi, '// ── 문제집 검수 공통 파서', '// ── (B-HWPX) 문제집 검수 HWPX 어댑터');
// HWPX 어댑터에서 소스 독립인 splitQuestionsHwpx만 추가 ("숫자. 지문" 문단 형식 지원)
const blockSplitQ = sliceOf(srcAi, 'function splitQuestionsHwpx', '// 전체 섹션에서 문항 파싱');

let commit = '(unknown)';
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (_) {}

// 문제집 검수 세그먼트 어댑터 — 패널 입력(문단 배열)용. String.raw로 정규식 백슬래시 보존.
const blockExamAdapter = String.raw`
// 세그먼트(문단 배열) 어댑터 — parseExamQuestionsHwpx의 패널 판 (extract-engine.js가 부가)
function examParseSegments(paragraphs, format) {
  const starts = [];
  let acc = 0;
  for (const t of paragraphs) { starts.push(acc); acc += t.length + 1; }
  const text = paragraphs.join('\n');
  const posToPara = pos => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo;
  };

  // 회차 헤더는 짧은 문단(<=40자)에서만 인정 — 본문 참조 문구("1회 12번 참고") 오탐 방지
  const roundMarks = [];
  paragraphs.forEach((t, i) => {
    const compact = t.replace(/\s/g, '');
    if (!compact || compact.length > 40) return;
    for (const pat of EXAM_ROUND_PATTERNS) {
      const m = compact.match(pat);
      if (m) { roundMarks.push({ pos: starts[i], round: m[0] }); break; }
    }
  });
  const roundAt = pos => {
    let r = '(회차 미상)';
    for (const rm of roundMarks) { if (rm.pos <= pos) r = rm.round; else break; }
    return r;
  };

  const footerAnswers = {}, footerByRound = {};
  if (format === 'footer') {
    const fre = new RegExp('(\\d{1,3})\\s*[.·]\\s*(' + EXAM_CIRCLED_CLASS + ')', 'g');
    let fm;
    while ((fm = fre.exec(text)) !== null) {
      const num = parseInt(fm[1], 10), ans = circledToInt(fm[2]);
      footerAnswers[num] = ans;
      const r = roundAt(fm.index);
      (footerByRound[r] = footerByRound[r] || {})[num] = ans;
    }
  }

  const circledRe = new RegExp(EXAM_CIRCLED_CLASS, 'g');
  const ansRe = new RegExp('답\\s*[:：]\\s*(' + EXAM_CIRCLED_CLASS + ')');
  const ansStripRe = new RegExp('답\\s*[:：]\\s*' + EXAM_CIRCLED_CLASS, 'g');
  const footerPairRe = new RegExp('\\d{1,3}\\s*[.·]\\s*' + EXAM_CIRCLED_CLASS, 'g');

  const questions = [];
  for (const q of splitQuestionsHwpx(text)) {
    let optBody = q.body.replace(ansStripRe, '');
    if (format === 'footer') optBody = optBody.replace(footerPairRe, '');
    const optChars = optBody.match(circledRe) || [];
    if (optChars.length < 2) continue; // 번호 오분할 조각 제외
    const optSet = [...new Set(optChars.map(circledToInt))].sort((a, b) => a - b);
    const am = q.body.match(ansRe);
    const firstOpt = q.body.search(circledRe);
    const head = firstOpt >= 0 ? q.body.slice(0, firstOpt) : q.body.slice(0, 120);
    const para = posToPara(q.numPos);
    questions.push({
      num: q.num,
      pageNo: '문단 ' + (para + 1),          // 표시용 위치
      para, off: q.numPos - starts[para],    // goto용 세그먼트 좌표
      round: roundAt(q.numPos),
      numPos: q.numPos, bodyStart: q.bodyStart,
      nOptions: optSet.length, optionsSeen: optSet,
      inlineAnswer: am ? circledToInt(am[1]) : null,
      hasNote: q.body.includes('오답노트'),
      hasPoint: q.body.includes('접근 Point') || q.body.replace(/\s/g, '').includes('접근Point'),
      negative: isNegativeQuestion(head),
    });
  }
  return { questions, footerAnswers, footerByRound };
}

// 정합성 검수 — findings에 goto용 (para, off) 좌표를 부여해 반환
function examCheck(paragraphs, format) {
  const { questions, footerAnswers, footerByRound } = examParseSegments(paragraphs, format);
  const report = examAnalyze(questions, footerAnswers, format, footerByRound);
  for (const f of report.findings) {
    const q = questions.find(x => x.numPos === f.numPos);
    if (q) { f.para = q.para; f.off = q.off; }
  }
  return report;
}

function answerStats(paragraphs, format) {
  const { questions, footerByRound } = examParseSegments(paragraphs, format);
  return answerStatsAnalyze(questions, footerByRound, format);
}
`;

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
// ═══ [3.5] AI 심층 검수 — 프롬프트·파서·Claude 호출 (index.html에서 추출) ═══
${blockAi}
// ═══ [3.7] 문제집 검수 — 파서·분석·표 내보내기 (index.html에서 추출) ═══
${blockExam}
${blockSplitQ}
${blockExamAdapter}
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

// ── AI 심층 검수 오케스트레이터 (extract-engine.js가 부가) ──
// callFn(text) → Promise<[{original,suggestion,category,confidence,reason}]>
// 실사용은 t => aiCallClaudeApi(key, model, t), 테스트는 가짜 함수 주입.
const AI_CAT_NAMES = {
  spelling: 'AI·맞춤법', spacing: 'AI·띄어쓰기', punct: 'AI·문장부호',
  style: 'AI·비문/문장', terminology: 'AI·용어', content: 'AI·사실/계산', template: 'AI·템플릿',
};

async function aiDetect(paragraphs, opts, callFn, onProgress) {
  opts = opts || {};
  const ratio = opts.ratio !== undefined ? opts.ratio : 0.7;
  const CHUNK = 2200;

  // 세그먼트(문단)를 문서 순서대로 ~CHUNK자 묶음으로 (세그먼트 경계 유지 = 좌표 보존)
  const chunks = [];
  let cur = null;
  paragraphs.forEach((t, idx) => {
    if (!cur || (cur.len > 0 && cur.len + t.length + 1 > CHUNK)) {
      cur = { segs: [], len: 0 };
      chunks.push(cur);
    }
    cur.segs.push(idx);
    cur.len += t.length + 1;
  });
  const jobs = chunks.filter(c => c.segs.some(i => paragraphs[i].trim()));

  const rawAll = [];
  let failed = 0, done = 0, firstError = null;
  const queue = jobs.slice();
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      try {
        const corr = await callFn(c.segs.map(i => paragraphs[i]).join('\\n'));
        for (const it of corr || []) rawAll.push({ c, it });
      } catch (e) { failed++; if (!firstError) firstError = e; }
      done++;
      if (onProgress) onProgress(done, jobs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
  if (!rawAll.length && firstError) throw firstError;

  // 신뢰도 상위 ratio만 채택 (웹 도구와 동일한 정책)
  rawAll.sort((a, b) => (b.it.confidence ?? 0) - (a.it.confidence ?? 0));
  const top = rawAll.slice(0, Math.max(1, Math.ceil(rawAll.length * ratio)));

  // original을 해당 청크의 세그먼트 안에서 정확 일치 탐색 — 유일할 때만 채택 (오적용 방지)
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const { c, it } of top) {
    const orig = String(it.original || '');
    if (!orig || it.suggestion === undefined || it.suggestion === null) { dropped++; continue; }
    let hit = null, hits = 0;
    for (const needle of [orig, orig.trim()].filter(Boolean)) {
      hits = 0; hit = null;
      for (const segIdx of c.segs) {
        const t = paragraphs[segIdx];
        let from = 0, i;
        while ((i = t.indexOf(needle, from)) !== -1) {
          hits++; hit = { para: segIdx, off: i, original: needle };
          from = i + 1;
        }
      }
      if (hits === 1) break;
    }
    if (hits !== 1 || hit.original === String(it.suggestion)) { dropped++; continue; }
    const key = hit.para + ':' + hit.off + ':' + hit.original;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = paragraphs[hit.para];
    out.push({
      para: hit.para, off: hit.off,
      ruleId: -99, category: it.category || 'custom',
      categoryName: AI_CAT_NAMES[it.category] || 'AI 검수',
      original: hit.original,
      suggestion: String(it.suggestion),
      confidence: it.confidence ?? 0.5,
      description: it.reason || '',
      contextBefore: t.slice(Math.max(0, hit.off - 20), hit.off),
      contextAfter: t.slice(hit.off + hit.original.length, hit.off + hit.original.length + 20),
      selected: true,
    });
  }
  out.sort((a, b) => a.para - b.para || a.off - b.off);
  return { issues: out,
           stats: { chunks: jobs.length, failed, considered: rawAll.length,
                    adopted: top.length, dropped } };
}

return {
  detectAll,
  detectIssuesInText,
  eqLint,           // 수식 스크립트 린트 — 브리지 /equations의 script 검사용
  ruleCount: () => state.rules.length,
  RULESET_VERSION,
  ENGINE_ORIGIN: '${commit}',   // 생성 시점의 index.html 커밋 (패널 버전 표시용)
  CAT_NAMES,
  // AI 심층 검수
  aiDetect,
  parseAiJson,
  aiCallClaude: (apiKey, model, text) => aiCallClaudeApi(apiKey, model, text),
  AI_MODELS: [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku (빠름·저렴)' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet (정확)' },
  ],
  // 문제집 검수
  examCheck,
  answerStats,
  answerStatsTable,
  answerStatsCSV,
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
