// 규칙 안전 게이트 — index.html의 내장 규칙을 표준어 산문 코퍼스에 걸어 오검출을 잡는다.
//
// 배경: 규칙 수정은 이 저장소에서 먼저 하는 경우가 많은데(가드 추가·규칙 삭제),
// 표준어 산문에서 발화하는 규칙은 실전 원고에서도 오검출한다는 사실을 확인할 방법이
// 여기에는 없었다. 옆 저장소 gyojeong이 그 게이트(tools/corpus_gate.mjs)를 갖고 있고
// 두 저장소의 규칙셋은 동일하게 유지되므로(tests/rules_test.js [7]), 게이트 로직을
// 복제하지 않고 재사용한다 — 규칙만 gyojeong이 읽는 형식으로 내보내 넘긴다.
//
// 사용:
//   node tools/corpus-gate.js            # 시트 유래 8개 카테고리 (baseline 대조)
//   node tools/corpus-gate.js --dict     # 사전 유래 2개 카테고리 (발화 0건이어야 통과)
//   node tools/corpus-gate.js --write-baseline
//   GYOJEONG_DIR=D:/other node tools/corpus-gate.js
//
// gyojeong 저장소나 코퍼스가 없으면 건너뛴다(exit 0).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GYOJEONG = process.env.GYOJEONG_DIR || 'C:/hcl/gyojeong';
const GATE = path.join(GYOJEONG, 'tools', 'corpus_gate.mjs');
const SHEET_CATS = 'convert,spelling,plural,honorific,space1,space2,space3,final';
const SHEET_BASELINE = path.join(GYOJEONG, 'tools', 'corpus_gate_sheet_baseline.json');

if (!fs.existsSync(GATE)) {
  console.log(`건너뜀 — gyojeong 게이트 없음: ${GATE}`);
  console.log('(GYOJEONG_DIR 환경변수로 경로를 지정할 수 있습니다)');
  process.exit(0);
}

// index.html의 규칙 구간을 평가해 CURATED_CATEGORIES를 얻는다(tests/rules_test.js와 같은 관행).
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const src = scripts.find(s => s.includes('CURATED_CATEGORIES'));
if (!src) { console.error('index.html에서 규칙 구간을 찾지 못했습니다'); process.exit(1); }
const s = src.indexOf('const RULESET_VERSION'), e = src.indexOf('// ========== 상태 관리');
if (s < 0 || e <= s) { console.error('추출 마커 실패'); process.exit(1); }
global.showToast = () => {};
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.state = { rules: [], exceptions: [] };
eval(src.slice(s, e) + '\n; global._t = { RULESET_VERSION, CURATED_CATEGORIES };');
const { RULESET_VERSION, CURATED_CATEGORIES } = global._t;

// gyojeong rules.json 형식으로 내보낸다.
const out = {
  version: RULESET_VERSION,
  source: 'hwpx-proofreader/index.html',
  categories: CURATED_CATEGORIES.map(c => ({ id: c.id, label: c.label, defaultOn: true, rules: c.rules })),
};
const tmp = path.join(os.tmpdir(), `hwpx-rules-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');

const dict = process.argv.includes('--dict');
const args = [GATE, '--rules', tmp];
if (dict) {
  args.push('--categories', 'dict_saisiot,dict_nonstd');
} else {
  args.push('--categories', SHEET_CATS, '--baseline', SHEET_BASELINE);
  if (process.argv.includes('--write-baseline')) args.push('--write-baseline');
}

const total = out.categories.reduce((n, c) => n + c.rules.length, 0);
console.log(`규칙 ${total}개(${RULESET_VERSION}) → ${dict ? '사전 유래' : '시트 유래'} 게이트`);
const res = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: GYOJEONG });
try { fs.unlinkSync(tmp); } catch (_) { /* 임시 파일 정리 실패는 무시 */ }
process.exit(res.status === null ? 1 : res.status);
