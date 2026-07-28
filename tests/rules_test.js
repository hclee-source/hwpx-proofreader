// 큐레이션 통합본 규칙 시스템 회귀 테스트 — 내장 규칙·문맥 가드·마이그레이션·CSV 왕복
// 실행: node tests/rules_test.js  (index.html에서 해당 스크립트 구간을 추출해 검증)
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.find(s => s.includes('CURATED_CATEGORIES'));
if (!src) { console.error('index.html에서 규칙 구간을 찾지 못했습니다'); process.exit(1); }

function slice(startMarker, endMarker) {
  const s = src.indexOf(startMarker), e = src.indexOf(endMarker);
  if (s < 0 || e < 0 || e <= s) { console.error('추출 마커 실패:', JSON.stringify(startMarker), s, JSON.stringify(endMarker), e); process.exit(1); }
  return src.slice(s, e);
}

const blockRules   = slice('const RULESET_VERSION', '// ========== 상태 관리');
const blockMigrate = slice('// 구 내장 규칙(통합본 이전) 제거', 'function saveRules');
const blockCsv     = slice('function rulesToCsv', "document.getElementById('exportCsvBtn')");
const blockDetect  = slice('const CAT_NAMES', 'function applyCorrection');

// DOM/스토리지 스텁
global.state = { rules: [], exceptions: [] };
global.localStorage = (() => { const m = new Map(); return {
  getItem: k => (m.has(k) ? m.get(k) : null),
  setItem: (k, v) => m.set(k, String(v)),
  removeItem: k => m.delete(k),
}; })();
global.showToast = () => {};

eval(blockRules + '\n' + blockMigrate + '\n' + blockCsv + '\n' + blockDetect
  + '\n; global._t = { RULESET_VERSION, CURATED_CATEGORIES, PRESETS, CURATED_SIGS, OLD_BUILTIN_SIGS, isLegacyBuiltinRule, cleanupLegacyBuiltinRules, injectRulesFromPresets, rulesToCsv, csvToRules, detectIssuesInText, CAT_NAMES };');
const T = global._t;

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, detail !== undefined ? '— ' + detail : ''); }
}

// ── 1. 내장 규칙 수·구조 ──
console.log('[1] 내장 규칙 수·구조');
const totalRules = T.PRESETS.reduce((n, p) => n + p.rules.length, 0);
ok(T.PRESETS.length === 10, '프리셋(카테고리) 10개 (큐레이션 8 + 사전 유래 2)', T.PRESETS.length);
ok(totalRules === 14073, '규칙 총수 14,073개 (오검출 3건 삭제: 무명→익명·베틀→배틀·문안하→무난하)', totalRules);
ok(T.CURATED_SIGS.size === totalRules, '시그니처 수 = 규칙 수 (내장 중복 0)', T.CURATED_SIGS.size);
const guarded = T.PRESETS.reduce((n, p) => n + p.rules.filter(r => r.rejectBefore || r.rejectAfter).length, 0);
ok(guarded === 273, '문맥 가드 규칙 273개 (기존 249 + 코퍼스 게이트 검토로 신규 24)', guarded);
ok(T.PRESETS.every(p => p.rules.every(r => r.type === 'literal' && r.original && typeof r.replacement === 'string')), '전 규칙 literal + 필수 필드');
ok(T.PRESETS.every(p => p.rules.every(r => r.confidence > 0 && r.confidence <= 1)), '신뢰도 범위 (0,1]');
const ctrlRe = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]');
ok(T.PRESETS.every(p => p.rules.every(r => !ctrlRe.test(r.original) && !ctrlRe.test(r.replacement))), '제어문자 잔존 0');

// ── 2. 문맥 가드 (rejectBefore/rejectAfter) ──
console.log('[2] 문맥 가드 동작');
const allRules = T.PRESETS.flatMap(p => p.rules);
const findRule = (o, r) => allRules.find(x => x.original === o && x.replacement === r);
function detectionsOf(text, rule) {
  state.rules = [Object.assign({ id: 1 }, rule)];
  return T.detectIssuesInText(text).filter(i => i.ruleId === 1);
}
// rejectBefore: "해 주"→"해주"는 위해/통해/의해/대해 뒤에서 오발동 금지
const haeJu = findRule('해 주', '해주');
ok(!!haeJu && Array.isArray(haeJu.rejectBefore), '"해 주→해주" 규칙 존재 + rejectBefore 가드', JSON.stringify(haeJu && haeJu.rejectBefore));
if (haeJu) {
  ok(detectionsOf('이를 위해 주로 사용한다', haeJu).length === 0, 'rejectBefore: "위해 주로" 오발동 차단');
  ok(detectionsOf('꼭 좀 해 주면 좋겠다', haeJu).length === 1, 'rejectBefore: 정상 문맥 "해 주면"은 검출 유지');
}
// rejectAfter: "그 중"→"그중"은 "그 중요한" 오발동 금지
const geuJung = findRule('그 중', '그중');
ok(!!geuJung && Array.isArray(geuJung.rejectAfter), '"그 중→그중" 규칙 존재 + rejectAfter 가드', JSON.stringify(geuJung && geuJung.rejectAfter));
if (geuJung) {
  ok(detectionsOf('그 중요한 사실을 놓쳤다', geuJung).length === 0, 'rejectAfter: "그 중요한" 오발동 차단');
  ok(detectionsOf('그 중에서 하나를 고른다', geuJung).length === 1, 'rejectAfter: 정상 문맥 "그 중에서"는 검출 유지');
}
// 실사용 신고 2026-07-20 — 긴 낱말 안쪽이 부분 매칭돼 멀쩡한 곳을 훼손하던 7건.
// 검출 0건이어야 하고, 그 규칙이 원래 노리던 문맥은 살아 있어야 한다.
for (const [orig, dst, damaged, kept] of [
  ['형 변환', '형변환', '자료형 변환을 이해한다', '형 변환 과정을 거친다'],
  ['어 주', '어주', '결과를 만들어 주는 함수', '내용을 적어 주면 좋겠다'],
  ['어 보', '어보', '코드를 읽어 보는 습관', '한번 먹어 보는 것도 좋다'],
  ['한값', '한 값', '구간의 상한값과 하한값', '계산한값을 저장한다'],
]) {
  const r = findRule(orig, dst);
  ok(!!r, `신고 규칙 존재: "${orig}→${dst}"`);
  if (r) {
    ok(detectionsOf(damaged, r).length === 0, `부분 매칭 훼손 차단: ${damaged}`);
    ok(detectionsOf(kept, r).length === 1, `정상 문맥 검출 유지: ${kept}`);
  }
}
// 보조용언을 붙이자는 낱말 전용 규칙 — 일반 '어 주/어 보' 가드로는 못 막는다(원문이 다름)
for (const [o, d] of [['이어 붙', '이어붙'], ['만들어 주', '만들어주'], ['읽어 보', '읽어보']]) {
  ok(!findRule(o, d), `"${o}→${d}" 규칙 삭제됨`);
}

// 사전 유래(dict_*)와 큐레이션이 서로 반대로 교정하면 무한 핑퐁이 된다 —
// '최빈값' 사고(2026-07-13)가 그 유형이었다. 두 규칙셋을 합칠 때 반드시 0이어야 한다.
{
  const dict = [], cur = [];
  for (const p of T.PRESETS)
    for (const r of p.rules) (p.id.includes('dict_') ? dict : cur).push(r);
  ok(dict.length > 0, '사전 유래 규칙 이식됨', dict.length);
  const curByOrig = new Map(cur.map(r => [r.original, r]));
  const curRepl = new Set(cur.map(r => r.replacement));
  const pingpong = dict.filter(d => {
    const c = curByOrig.get(d.replacement);
    return c && c.replacement === d.original;
  });
  ok(pingpong.length === 0, '사전↔큐레이션 정반대 교정 0건',
    JSON.stringify(pingpong.slice(0, 5).map(d => d.original + '>' + d.replacement)));
  // 큐레이션이 만들어 낸 결과를 사전이 다시 고치면 적용→재검출이 안 끝난다
  const chain = dict.filter(d => curRepl.has(d.original));
  ok(chain.length === 0, '사전이 큐레이션 교정 결과를 재교정 0건',
    JSON.stringify(chain.slice(0, 5).map(d => d.original + '>' + d.replacement)));
}

// 다글자 가드 토큰 (리눅스·윈도우 등 3글자)
const multiGuard = allRules.find(r => (r.rejectBefore || []).concat(r.rejectAfter || []).some(g => g.length >= 2));
ok(!!multiGuard, '다글자 가드 토큰 규칙 존재', multiGuard && JSON.stringify([multiGuard.original, multiGuard.rejectBefore, multiGuard.rejectAfter]));
if (multiGuard) {
  const g = (multiGuard.rejectBefore || []).concat(multiGuard.rejectAfter || []).find(x => x.length >= 2);
  const isBefore = (multiGuard.rejectBefore || []).includes(g);
  const guardedText = isBefore ? (g + multiGuard.original + ' 뒤문장') : ('앞문장 ' + multiGuard.original + g);
  const cleanText = '앞문장 ' + multiGuard.original + ' 뒤문장';
  ok(detectionsOf(guardedText, multiGuard).length === 0, `다글자 가드 차단 (토큰 "${g}")`);
  ok(detectionsOf(cleanText, multiGuard).length >= 1, '다글자 가드 규칙도 정상 문맥은 검출');
}

// ── 3. 마이그레이션: 구 내장 제거 + 사용자 규칙 보존 + 멱등 ──
console.log('[3] 마이그레이션');
state.rules = [
  // 구 내장 (현행 시그니처)
  { id: 1, category: 'spacing', type: 'regex', original: '([가-힣])않', replacement: '$1 않', flags: 'g', description: '구 내장', confidence: 0.88 },
  { id: 2, category: 'spacing', type: 'literal', original: '상호 작용', replacement: '상호작용', description: '구 내장', confidence: 0.92 },
  // 구 내장 (미마이그레이션 구버전 변형)
  { id: 3, category: 'spacing', type: 'literal', original: '그 중', replacement: '그중', description: '구구버전', confidence: 0.9 },
  { id: 4, category: 'custom', type: 'literal', original: '하기 위해서', replacement: '하려고', description: '유해 규칙', confidence: 0.8 },
  // 사용자 규칙 (보존 대상)
  { id: 5, category: 'custom', type: 'literal', original: '골든레빗', replacement: '골든래빗', description: '사용자 추가', confidence: 0.99 },
  { id: 6, category: 'custom', type: 'regex', original: 'v(\\d+)\\.(\\d+)', replacement: 'v$1.$2', flags: 'g', description: '사용자 정규식', confidence: 0.9 },
];
const removed = T.cleanupLegacyBuiltinRules();
// id1(않 regex)=구 시그니처 제거, id4(하려고)=유해 판정 제거.
// id2(상호 작용)·id3(그 중)는 통합본에도 있는 쌍이라 제거하지 않고 주입 때 통합본 정의로 갱신(설계 동작)
ok(removed === 2, '구 내장 2개 제거 (구 시그니처 1 + 유해 1; 통합본 동일 쌍 2개는 갱신 승계)', removed);
ok(state.rules.length === 4 && [2, 3, 5, 6].every(id => state.rules.some(r => r.id === id)), '동일 쌍 2 + 사용자 2 보존', JSON.stringify(state.rules.map(r => r.id)));
const inj1 = T.injectRulesFromPresets(T.PRESETS);
ok(inj1.added === totalRules - 2 && inj1.updated === 2, `통합본 주입 (신규 ${totalRules - 2} + 동일 쌍 갱신 2)`, JSON.stringify(inj1));
// 갱신 승계 확인: 구 '그 중' 리터럴이 통합본 정의(가드·분류·신뢰도)로 교체되고 id는 유지
const upgraded = state.rules.find(r => r.id === 3);
ok(upgraded && Array.isArray(upgraded.rejectAfter) && upgraded.category === 'convert' && upgraded.confidence === 0.95, '동일 쌍 갱신 시 가드·분류·신뢰도 승계(id 유지)', JSON.stringify(upgraded));
ok(state.rules.length === 2 + totalRules, '최종 규칙 수 = 사용자 2 + 통합본', state.rules.length);
// 멱등성: 재실행 시 제거 0·추가 0·전량 갱신
const removed2 = T.cleanupLegacyBuiltinRules();
const inj2 = T.injectRulesFromPresets(T.PRESETS);
ok(removed2 === 0 && inj2.added === 0 && inj2.updated === totalRules, '재실행 멱등 (제거 0·추가 0·갱신 전량)', JSON.stringify({ removed2, inj2 }));
ok(state.rules.length === 2 + totalRules, '재실행 후 규칙 수 불변', state.rules.length);
// id 중복 없음
const ids = new Set(state.rules.map(r => r.id));
ok(ids.size === state.rules.length, '규칙 id 전량 고유', ids.size + '/' + state.rules.length);

// ── 4. 검출 스모크 (전체 규칙 로드 상태) ──
console.log('[4] 검출 스모크');
const text = '갯수를 확인할때 이 방법을 사용해 보세요. 그 중요한 것은 아니지만 그 중에서 고르세요. 이를 위해 주로 쓰입니다.';
const t0 = Date.now();
const issues = T.detectIssuesInText(text);
const elapsed = Date.now() - t0;
const sugg = issues.map(i => i.original + '→' + i.suggestion);
ok(sugg.some(s => s === '갯수→개수'), '갯수→개수 검출', JSON.stringify(sugg));
ok(sugg.some(s => s === '할때→할 때'), '할때→할 때 검출');
ok(issues.filter(i => i.original === '그 중').length === 1, '"그 중" 1건만 검출 (그 중요한 제외)', issues.filter(i => i.original === '그 중').length);
ok(!issues.some(i => i.original === '해 주' && text.slice(Math.max(0, i.position - 1), i.position) === '해'), '"위해 주로" 오발동 없음');
console.log('  (참고) 6,421개 규칙 × ' + text.length + '자 검출 소요: ' + elapsed + 'ms, 총 ' + issues.length + '건');
// 사용자 정규식 규칙 병행 동작
const regexIssues = issues.filter(i => i.ruleId === 6);
ok(state.rules.some(r => r.id === 6), '사용자 정규식 규칙 잔존 확인');

// ── 5. CSV 왕복 (가드 보존) ──
console.log('[5] CSV 왕복');
const guardedRule = allRules.find(r => r.rejectBefore && r.rejectAfter) || allRules.find(r => r.rejectBefore) || allRules.find(r => r.rejectAfter);
const csvRules = [
  Object.assign({ id: 1 }, guardedRule),
  { id: 2, category: 'custom', type: 'literal', original: '테스트,따옴표"포함', replacement: '교정 값', description: '이스케이프 확인', confidence: 0.9 },
];
const csv = T.rulesToCsv(csvRules);
const back = T.csvToRules(csv);
ok(back.length === 2, 'CSV 왕복 규칙 수 유지', back.length);
ok(JSON.stringify(back[0].rejectBefore || null) === JSON.stringify(guardedRule.rejectBefore || null), 'rejectBefore 보존', JSON.stringify([guardedRule.rejectBefore, back[0].rejectBefore]));
ok(JSON.stringify(back[0].rejectAfter || null) === JSON.stringify(guardedRule.rejectAfter || null), 'rejectAfter 보존', JSON.stringify([guardedRule.rejectAfter, back[0].rejectAfter]));
ok(back[1].original === '테스트,따옴표"포함', 'CSV 이스케이프 왕복', back[1].original);

// ── 6. 구 프리셋 264개 전수 판별 ──
console.log('[6] 구 프리셋 전수 판별');
ok(T.OLD_BUILTIN_SIGS.size >= 260, '구 시그니처 260개 이상 내장', T.OLD_BUILTIN_SIGS.size);
// 구 시그니처 전부: 통합본과 동일 쌍이 아니면 legacy 판별돼야 함
let sigLegacyOk = 0, sigShared = 0;
for (const sig of T.OLD_BUILTIN_SIGS) {
  const z = sig.indexOf('\u0000');
  const r = { original: sig.slice(0, z), replacement: sig.slice(z + 1) };
  if (T.CURATED_SIGS.has(sig)) { sigShared++; continue; }
  if (T.isLegacyBuiltinRule(r)) sigLegacyOk++;
}
ok(sigLegacyOk + sigShared === T.OLD_BUILTIN_SIGS.size, `구 시그니처 전수 커버 (legacy ${sigLegacyOk} + 통합본 동일 ${sigShared})`, (sigLegacyOk + sigShared) + '/' + T.OLD_BUILTIN_SIGS.size);
// 가드 있는 규칙은 절대 legacy 판별되지 않음 (통합본 규칙 보호)
ok(allRules.filter(r => r.rejectBefore || r.rejectAfter).every(r => !T.isLegacyBuiltinRule(r)), '가드 규칙은 legacy 판별 제외');
// 통합본 전 규칙이 legacy 판별되지 않음
ok(allRules.every(r => !T.isLegacyBuiltinRule(r)), '통합본 전 규칙 legacy 오판별 0');

// ── 7. gyojeong 규칙셋 대조 ──
// 같은 규칙셋을 쓰는 gyojeong(크롬 확장)과 어긋나지 않았는지 본다. 수정은 어느 쪽에서든
// 먼저 일어나고 손으로 옮기므로("(hwpx 동기)" 커밋) 빠뜨리기 쉽다 — 실제로 3건 격차를
// 손으로 감사해서야 찾았고 그게 원고에 제어문자를 박아 넣던 오염이었다(2026-07-28).
// gyojeong 저장소가 없는 환경에서는 건너뛴다.
console.log('[7] gyojeong 규칙셋 대조');
const GYOJEONG = process.env.GYOJEONG_DIR || 'C:/hcl/gyojeong';
const gyPath = path.join(GYOJEONG, 'rules.json');
if (!fs.existsSync(gyPath)) {
  console.log(`  - 건너뜀 (gyojeong 없음: ${gyPath}; GYOJEONG_DIR로 지정 가능)`);
} else {
  const gy = JSON.parse(fs.readFileSync(gyPath, 'utf8'));
  const key = (catId, r) => catId + '|' + r[0] + '|' + r[1];
  const guard = (r) => JSON.stringify(r[2] || null);
  const G = new Map();
  for (const c of gy.categories) for (const r of c.rules) G.set(key(c.id, r), guard(r));
  const H = new Map();
  for (const c of T.CURATED_CATEGORIES) for (const r of c.rules) H.set(key(c.id, r), guard(r));

  const onlyH = [...H.keys()].filter(k => !G.has(k));
  const onlyG = [...G.keys()].filter(k => !H.has(k));
  const guardDiff = [...H.keys()].filter(k => G.has(k) && G.get(k) !== H.get(k));
  const brief = (list) => JSON.stringify(list.slice(0, 5)) + (list.length > 5 ? ` 외 ${list.length - 5}건` : '');

  ok(H.size === G.size, `규칙 수 일치 (hwpx ${H.size} / gyojeong ${G.size})`);
  ok(onlyH.length === 0, 'hwpx에만 있는 규칙 0건 — gyojeong으로 옮길 것', brief(onlyH));
  ok(onlyG.length === 0, 'gyojeong에만 있는 규칙 0건 — hwpx로 옮길 것', brief(onlyG));
  ok(guardDiff.length === 0, '가드(rejectBefore/After) 불일치 0건', brief(guardDiff));
}

console.log('\n결과: ' + pass + ' 통과 / ' + fail + ' 실패');
process.exit(fail > 0 ? 1 : 0);
