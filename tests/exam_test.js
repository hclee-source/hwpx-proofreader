// 문제집 검수 (exam_check · answer_stats) 회귀 테스트 — PDF·HWPX 공용 파서/분석부
// 실행: node tests/exam_test.js  (index.html에서 해당 스크립트 구간을 추출해 검증)
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.find(s => s.includes('문제집 검수 공통 파서'));
if (!src) { console.error('index.html에서 문제집 검수 구간을 찾지 못했습니다'); process.exit(1); }

const start = src.indexOf('// NBSP·전각공백을 일반 공백으로');
const parserStart = src.indexOf('// ── 문제집 검수 공통 파서');
const end = src.indexOf('// ── (C) 목차 쪽수 검증');
if (start < 0 || parserStart < 0 || end < 0) { console.error('추출 마커를 찾지 못했습니다', start, parserStart, end); process.exit(1); }

// lexNormalize 정의 + 파서~HWPX 어댑터 구간만 평가 (DOM 의존부는 스텁)
const lexNormSlice = src.slice(start, src.indexOf('// term의 모든 출현 오프셋'));
const examSlice = src.slice(parserStart, end);

global.state = { sectionFiles: {}, sectionAnalysis: {} };
global.pdfState = { pages: [], issues: [] };
global.extractTextFromSection = () => { throw new Error('sectionAnalysis가 제공되면 호출되지 않아야 함'); };
global.mapCharRangeToWords = () => [0];
global.PDF_CAT_NAME = { exam: '문제집 검수' };

eval(lexNormSlice + '\n' + examSlice
  + '\n; global._t = { splitQuestionsHwpx, parseExamQuestionsHwpx, runExamCheckHwpx, runAnswerStatsHwpx, examAnalyze, answerStatsAnalyze, hwpxExamState, runExamCheck, runAnswerStats };');
const T = global._t;

// ── 합성 섹션 빌더: 문단 배열 → originalText(\x01 구분) + paragraphs ──
function buildSection(paras) {
  const paragraphs = [];
  let off = 0;
  for (const p of paras) {
    paragraphs.push({ text: p, startInFull: off });
    off += p.length + 1;
  }
  return { originalText: paras.join('\x01'), paragraphs };
}
function setDoc(paras) {
  const sec = buildSection(paras);
  state.sectionFiles = { 'Contents/section0.xml': '<xml/>' };
  state.sectionAnalysis = { 'Contents/section0.xml': sec };
}

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { fails++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

// ══════════════ HWPX 경로 ══════════════

// ── 시나리오 1: "12. 지문" 형식 + 인라인 정답 + 회차 헤더 ──
const Q = (n, neg, ans, note = true, point = true) => [
  `${n}. 다음 중 데이터베이스에 대한 설명으로 ${neg ? '옳지 않은' : '옳은'} 것은?`,
  '① 첫 번째 보기 문장',
  '② 두 번째 보기 문장',
  '③ 세 번째 보기 문장',
  '④ 네 번째 보기 문장',
  `답: ${'①②③④'[ans - 1]}`,
  ...(note ? ['오답노트 — ①은 ~라서 틀리고 ②는 ~라서 틀리다'] : []),
  ...(point ? ['접근 Point 핵심 개념을 먼저 떠올린다'] : []),
];

setDoc([
  '기출변형 1회',
  ...Q(1, false, 2), ...Q(2, true, 4), ...Q(3, false, 1), ...Q(4, false, 3),
  '기출변형 2회',
  ...Q(1, false, 3), ...Q(2, false, 2, false), // 2회 2번: 오답노트 없음
]);

const rep1 = T.runExamCheckHwpx('inline');
check('1-파싱: 문항 6개', rep1.nQ === 6, rep1.nQ);
check('1-인라인 정답 6개', rep1.nInline === 6, rep1.nInline);
check('1-부정형 1문항', rep1.negativeQuestions.length === 1 && rep1.negativeQuestions[0] === 2, rep1.negativeQuestions);
const noteFinding = rep1.findings.filter(f => f.kind === '오답노트 부재');
check('1-오답노트 부재 1건 (2회 2번)', noteFinding.length === 1 && noteFinding[0].question === 2, rep1.findings);

const stats1 = T.runAnswerStatsHwpx('inline');
check('1-회차 2개 집계', Object.keys(stats1.rounds).length === 2, Object.keys(stats1.rounds));
check('1-1회 4문항', stats1.rounds['기출변형1회'] && stats1.rounds['기출변형1회'].total === 4, stats1.rounds);
check('1-누적 6문항', stats1.totalAll === 6, stats1.totalAll);

// ── 시나리오 2: 정답이 보기 범위 밖 → 정답-보기 불일치 ──
setDoc([...Q(1, false, 2), [
  '2. 다음 중 옳은 것은?', '① 보기', '② 보기', '③ 보기', '④ 보기', '답: ⑤',
].join('\x01')].flatMap(x => x.split('\x01')));
const rep2 = T.runExamCheckHwpx('inline');
check('2-정답-보기 불일치 검출', rep2.findings.some(f => f.kind === '정답-보기 불일치' && f.question === 2), rep2.findings);

// ── 시나리오 3: 단독 번호 문단 형식 (\n숫자\n) — PDF식 조판 원고 ──
setDoc([
  '1', '다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ①',
  '2', '다음 중 옳지 않은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ③',
  '3', '다음 설명으로 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②',
]);
const rep3 = T.runExamCheckHwpx('inline');
check('3-단독 번호 문단 3문항', rep3.nQ === 3, rep3.nQ);
check('3-정합성 이상 없음', rep3.findings.length === 0, rep3.findings);

// ── 시나리오 4: 하단 정답표 형식 + 교차 불일치 ──
setDoc([
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라',
  '2. 다음 중 옳지 않은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②',
  '3. 다음 설명으로 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라',
  '정답 1.② 2.④ 3.①',
]);
const rep4 = T.runExamCheckHwpx('footer');
check('4-문항 3개', rep4.nQ === 3, rep4.nQ);
check('4-footer 정답 3개', rep4.answersFound === 3, rep4.answersFound);
check('4-교차 불일치 검출(2번: 인라인② vs footer④)',
  rep4.findings.some(f => f.kind === '정답 교차 불일치' && f.question === 2), rep4.findings);
check('4-정답표 라인이 유령 문항이 되지 않음', !rep4.findings.some(f => f.question > 3), rep4.findings.map(f => f.question));

// ── 시나리오 5: 해설 속 번호 목록 "1) ..." 이 유령 문항이 되지 않는지 ──
setDoc([
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ①',
  '오답노트 정리', '1) 첫째 근거 설명', '2) 둘째 근거 설명',
  '2. 다음 중 옳지 않은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ③', '오답노트 — 설명',
  '3. 다음 설명으로 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②', '오답노트 — 설명',
]);
const rep5 = T.runExamCheckHwpx('inline');
check('5-해설 번호목록 무시, 문항 3개', rep5.nQ === 3, rep5.nQ);

// ── 시나리오 6: 동일 정답 연속(4연속) 경보 ──
setDoc([
  '제1회',
  ...Q(1, false, 2), ...Q(2, false, 2), ...Q(3, false, 2), ...Q(4, false, 2), ...Q(5, false, 1),
]);
const stats6 = T.runAnswerStatsHwpx('inline');
check('6-동일 정답 연속 경보', stats6.alerts.some(a => a.kind === '동일 정답 연속'), stats6.alerts);

// ── 시나리오 7 (버그 회귀): 회차별 footer 정답 충돌 — flat dict 덮어쓰기 오탐 ──
setDoc([
  '기출변형 1회',
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②',
  '정답 1.②',
  '기출변형 2회',
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ④',
  '정답 1.④',
]);
const rep7 = T.runExamCheckHwpx('footer');
check('7-회차별 footer: 교차 불일치 오탐 없음', !rep7.findings.some(f => f.kind === '정답 교차 불일치'), rep7.findings);
check('7-분포 회차별 정확 집계', rep7.distribution[2] === 1 && rep7.distribution[4] === 1, rep7.distribution);

// ── 시나리오 8 (버그 회귀): 해설의 '정답: ⑤' 재진술이 보기 오염 → 마스킹 ──
setDoc([
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ⑤', '오답노트 — 따라서 정답: ⑤가 맞다',
  '2. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ①', '오답노트 — 설명',
  '3. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②', '오답노트 — 설명',
]);
const rep8 = T.runExamCheckHwpx('inline');
check('8-재진술 정답 오염 무시하고 불일치 검출',
  rep8.findings.some(f => f.kind === '정답-보기 불일치' && f.question === 1), rep8.findings);

// ── 시나리오 9 (버그 회귀): footer 정답표 라인이 마지막 문항 body의 보기를 오염 ──
setDoc([
  '1. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라',
  '2. 다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라',
  '정답 1.② 2.⑤',
]);
const rep9 = T.runExamCheckHwpx('footer');
check('9-정답표 오염 무시하고 범위 밖 정답(⑤) 검출',
  rep9.findings.some(f => f.kind === '정답-보기 불일치' && f.question === 2), rep9.findings);

// ── 시나리오 10 (버그 회귀): 문항 번호 뒤 탭(\x01 마커) ──
setDoc([
  '1.\x01다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ②',
  '2.\x01다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ③',
  '3.\x01다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ①',
]);
const rep10 = T.runExamCheckHwpx('inline');
check('10-탭 구분 문항 3개 파싱', rep10.nQ === 3, rep10.nQ);
check('10-인라인 정답 3개', rep10.nInline === 3, rep10.nInline);

// ══════════════ PDF 경로 ══════════════

const PQ = (n, ans) => [String(n), '다음 중 옳은 것은?', '① 가', '② 나', '③ 다', '④ 라', '답: ' + '①②③④⑤'[ans - 1], '오답노트 설명', '접근 Point 설명'].join('\n');

// ── 시나리오 P1: 기본 인라인 ──
global.pdfState = { issues: [], pages: [
  { index: 0, text: '기출변형 1회\n' + PQ(1, 2) + '\n' + PQ(2, 4), word_spans: [] },
  { index: 1, text: PQ(3, 1) + '\n' + PQ(4, 3), word_spans: [] },
] };
let prep = T.runExamCheck('inline');
check('P1-기본: 4문항·이상 없음', prep.nQ === 4 && prep.findings.length === 0, prep);
let pst = T.runAnswerStats('inline');
check('P1-통계: 4문항 1회차', pst.totalAll === 4 && Object.keys(pst.rounds).length === 1, pst && pst.rounds);
check('P1-pdfState 연동', pdfState.examReport === prep && pdfState.answerStats === pst);

// ── 시나리오 P2 (버그 회귀): 회차별 footer 충돌 ──
global.pdfState = { issues: [], pages: [
  { index: 0, text: '기출변형 1회\n' + PQ(1, 2) + '\n정답 1.②', word_spans: [] },
  { index: 1, text: '기출변형 2회\n' + PQ(1, 4) + '\n정답 1.④', word_spans: [] },
] };
prep = T.runExamCheck('footer');
check('P2-회차별 footer 교차 오탐 없음', !prep.findings.some(f => f.kind === '정답 교차 불일치'), prep.findings);
check('P2-분포 정확', prep.distribution[2] === 1 && prep.distribution[4] === 1, prep.distribution);

// ── 시나리오 P3 (버그 회귀): 해설 재진술 '정답: ⑤' ──
global.pdfState = { issues: [], pages: [
  { index: 0, text: [PQ(1, 5), '따라서 정답: ⑤가 맞다', PQ(2, 1), PQ(3, 2)].join('\n'), word_spans: [] },
] };
prep = T.runExamCheck('inline');
check('P3-재진술 오염 무시하고 불일치 검출', prep.findings.some(f => f.kind === '정답-보기 불일치' && f.question === 1), prep.findings);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
process.exit(fails ? 1 : 0);
