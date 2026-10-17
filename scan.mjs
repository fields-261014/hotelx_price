// HoteLux 요금 조회 + 하락 알림
// 실행: node scan.mjs   (환경변수 TELEGRAM_TOKEN, TELEGRAM_CHAT_ID 가 있으면 텔레그램으로 알림)
import fs from 'node:fs';

const CFG = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)));
const STATE_FILE = new URL('./data/state.json', import.meta.url);
const LATEST_FILE = new URL('./data/latest.json', import.meta.url);
const REPORT_FILE = new URL('./report.md', import.meta.url);
const API = 'https://hotel.hotelux.com/services/booking/hotel/rates?mode=asyncPagingMerged';
const MOCK = process.env.MOCK === '1';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const fmtDate = iso => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };
const won = n => (typeof n === 'number' ? n.toLocaleString('ko-KR') : '–');
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };

const HEADERS = {
  'content-type': 'application/json',
  'accept': 'application/json, text/plain, */*',
  'origin': 'https://hotel.hotelux.com',
  'referer': 'https://hotel.hotelux.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
};

// 실제 브라우저(Chromium)로 HoteLux 페이지를 먼저 열어 접속 세션을 만든 뒤, 그 페이지 안에서 조회한다.
let browser = null, page = null;
const SESSION_URL = 'https://hotel.hotelux.com/#/hotel/detail?locationType=city&showLabel=Busan&locationRef=59ad4641e32d2a86e654b2be&checkIn=' + kstToday() + '&checkOut=' + addDays(kstToday(), 1) + '&numberOfAdults=2&numberOfChildren=0&numberOfRooms=1&hotelId=5c1e76d93457456c0777a5ee';

// 페이지가 스스로 보낸 첫 요금 조회 요청(헤더·본문)을 본떠서, 호텔·날짜만 바꿔 보낸다.
let ctx = null, template = null;
const SKIP_HEADERS = new Set(['content-length', 'host', 'cookie', 'connection', 'accept-encoding']);

async function openSession() {
  if (!browser) {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', userAgent: HEADERS['user-agent'], viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    page.on('request', req => {
      if (template || req.method() !== 'POST' || !req.url().includes('/booking/hotel/rates')) return;
      let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch {}
      if (!body) return;
      const headers = {};
      for (const [k, v] of Object.entries(req.headers())) if (!SKIP_HEADERS.has(k.toLowerCase()) && !k.startsWith(':')) headers[k] = v;
      template = { headers, body };
      console.log('요청 양식 확보. 헤더:', Object.keys(headers).join(', '), '| 본문 항목:', Object.keys(body).join(', '),
        '| stay 항목:', Object.keys(body.stay || {}).join(', '));
    });
  }
  template = null;
  await page.goto(SESSION_URL, { waitUntil: 'networkidle', timeout: 90000 }).catch(e => console.log('goto 경고:', e.message));
  for (let i = 0; i < 20 && !template; i++) await sleep(1000);
  await sleep(3000);
  console.log('세션 준비 완료:', await page.title().catch(() => ''), template ? '' : '(요청 양식 못 찾음)');
}

function fromTemplate(body) {
  if (!template) return body;
  const t = JSON.parse(JSON.stringify(template.body));
  t.hotel = { ...(t.hotel || {}), _id: body.hotel._id };
  t.stay = { ...(t.stay || {}), ...body.stay, date: { ...((t.stay || {}).date || {}), ...body.stay.date } };
  return t;
}

async function post(url, body) {
  if (MOCK) return mockResponse(body);
  if (!page) await openSession();
  const payload = fromTemplate(body);
  try {
    if (template) {
      const r = await ctx.request.post(url, { headers: { ...template.headers, 'content-type': 'application/json' }, data: JSON.stringify(payload), timeout: 60000 });
      const t = await r.text();
      try { return JSON.parse(t); } catch { return { err: { messageKey: 'http' + r.status() } }; }
    }
    const path = url.replace('https://hotel.hotelux.com', '');
    return await page.evaluate(async ({ path, payload }) => {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), credentials: 'include' });
      const t = await r.text();
      try { return JSON.parse(t); } catch { return { err: { messageKey: 'http' + r.status } }; }
    }, { path, payload });
  } catch (e) {
    console.log('요청 오류:', e.message);
    return { err: { messageKey: 'requestError' } };
  }
}

// 한 날짜·한 호텔 조회 → 지정 요금제 기준 하위 2개 객실 [[객실, 요금제, 원화], ...]
async function fetchDate(hotelId, ci, state) {
  const body = { hotel: { _id: hotelId }, stay: { date: { checkIn: ci, checkOut: addDays(ci, 1) }, numberOfAdults: 2, numberOfChildren: 0, numberOfRooms: 1 } };
  const re = new RegExp(CFG.planRe, 'i');
  const ex = CFG.excludeRe ? new RegExp(CFG.excludeRe, 'i') : null;
  for (let attempt = 0; attempt < 8; attempt++) {
    let j;
    try { j = await post(API, body); } catch { j = { err: { messageKey: 'network' } }; }
    if (j.err && j.err.messageKey === 'tooManyRequests') {
      state.blocks++; state.gap += 1000; await sleep(MOCK ? 1 : 90000); continue;
    }
    if (j.err) { state.errs++; state.lastErr = j.err.messageKey || j.err.message; return null; }
    let rooms = j.rooms || [];
    let guard = 0;
    while (j.asyncJobId && guard++ < 5) {
      await sleep(MOCK ? 1 : 1500);
      j = await post(`${API}&asyncJobId=${j.asyncJobId}`, body);
      rooms = rooms.concat(j.rooms || []);
    }
    const best = {};
    for (const rm of rooms) for (const r of rm.rates || []) {
      const nm = (r.nameEn || '').trim();
      if (!re.test(nm) || (ex && ex.test(nm))) continue;
      const p = r.priceDetail && r.priceDetail.aggregated;
      if (!p || p.currency !== 'KRW') continue;
      if (!best[rm.nameEn] || p.sum < best[rm.nameEn][1]) best[rm.nameEn] = [nm, p.sum];
    }
    return Object.entries(best).sort((a, b) => a[1][1] - b[1][1]).slice(0, 2).map(([room, [plan, krw]]) => [room, plan, krw]);
  }
  state.errs++; state.lastErr = 'tooManyRequests(계속)';
  return null;
}

// 호텔 1곳 조회. 처음부터 연속 실패하면 일찍 멈춘다.
async function scanHotel(h) {
  const today = kstToday();
  const st = { gap: CFG.gapMs, blocks: 0, errs: 0, n: 0, lastErr: null, aborted: false };
  const res = {};
  let streak = 0, reopened = false, okCount = 0;
  for (let i = 0; i < CFG.days; i++) {
    const ci = addDays(today, i);
    res[ci] = await fetchDate(h.id, ci, st);
    st.n++;
    if (res[ci] === null) {
      streak++;
      console.log(`조회 실패 ${h.key} ${ci}: ${st.lastErr}`);
      if (streak === 5 && !reopened && !MOCK) { reopened = true; console.log('연속 실패 → 페이지를 다시 열어 세션 재시도'); await openSession(); }
      if (streak >= 10 && okCount === 0) { st.aborted = true; break; }
    } else { streak = 0; okCount++; }
    if (st.n % 30 === 0) console.log(`${h.key} progress ${st.n}/${CFG.days} blocks=${st.blocks} errs=${st.errs}`);
    await sleep(MOCK ? 0 : st.gap);
  }
  const ok = !st.aborted && st.errs <= CFG.days * 0.5;
  return { key: h.key, today, scanAt: new Date().toISOString(), ok, st, res };
}

function compare(res, today) {
  const state = readJson(STATE_FILE, { lows: {}, last: {} });
  const alerts = [];
  for (const h of CFG.hotels) {
    if (!res[h.key]) continue;
    const lows = (state.lows[h.key] ||= {});
    const last = (state.last[h.key] ||= {});
    const tgt = typeof h.targetKrw === 'number' ? h.targetKrw : null;
    for (const [ci, rows] of Object.entries(res[h.key] || {})) {
      if (!rows) continue;
      lows[ci] ||= {}; last[ci] ||= {};
      for (const [room, plan, krw] of rows) {
        const prevLow = lows[ci][room], prevLast = last[ci][room];
        if (typeof prevLow === 'number' && krw <= prevLow * (1 - CFG.dropPct / 100)) {
          alerts.push({ hotel: h.name, date: ci, room, plan, prev: prevLow, now: krw, kind: 'drop', pct: Math.round((1 - krw / prevLow) * 1000) / 10 });
        } else if (tgt !== null && krw <= tgt && !(typeof prevLast === 'number' && prevLast <= tgt)) {
          alerts.push({ hotel: h.name, date: ci, room, plan, prev: prevLast ?? null, now: krw, kind: 'target' });
        }
        if (typeof prevLow !== 'number' || krw < prevLow) lows[ci][room] = krw;
        last[ci][room] = krw;
      }
    }
    for (const ci of Object.keys(lows)) if (ci < today) { delete lows[ci]; delete last[ci]; }
  }
  return { state, alerts };
}

function buildReport(res, state, scanAt, times = {}) {
  const out = [`# HoteLux 요금 현황`, '', `마지막 조회: ${new Date(scanAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)`, '',
    `기준: 1박·성인 2명, 세금 포함 원화. 요금제 ${CFG.planRe.replace(/\|/g, ' / ')} (제외: ${CFG.excludeRe || '없음'}). 알림 조건: 날짜·객실별 역대 최저 대비 ${CFG.dropPct}% 이상 하락, 또는 목표가 이하 첫 도달.`, ''];
  for (const h of CFG.hotels) {
    const rows = res[h.key] || {};
    const dates = Object.keys(rows).sort();
    out.push(`## ${h.name}`, '');
    if (times[h.key] && times[h.key] !== scanAt) out.push(`(이번 조회 실패, ${new Date(times[h.key]).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 조회 결과)`, '');
    if (typeof h.targetKrw === 'number') out.push(`목표가: ${won(h.targetKrw)}원`, '');
    // 월별 최저
    const monthMin = {};
    for (const ci of dates) { const r = rows[ci] && rows[ci][0]; if (!r) continue; const m = ci.slice(0, 7); if (!monthMin[m] || r[2] < monthMin[m][1]) monthMin[m] = [ci, r[2]]; }
    out.push('| 월 | 최저가 날짜 | 최저가 |', '|---|---|---:|');
    for (const [m, [ci, krw]] of Object.entries(monthMin)) out.push(`| ${m} | ${fmtDate(ci)} | ${won(krw)}원 |`);
    out.push('', '<details><summary>날짜별 전체 보기</summary>', '', '| 체크인 | 최저 객실 | 객실·요금제 | 두번째 객실 | 역대 최저 |', '|---|---:|---|---:|---:|');
    for (const ci of dates) {
      const r = rows[ci];
      if (r === null) { out.push(`| ${fmtDate(ci)} | 조회 실패 | | | |`); continue; }
      const [r1, r2] = r;
      const low = r1 ? state.lows[h.key]?.[ci]?.[r1[0]] : undefined;
      out.push(`| ${fmtDate(ci)} | ${r1 ? won(r1[2]) : '해당 요금 없음'} | ${r1 ? `${r1[0].slice(0, 40)} · ${r1[1]}` : ''} | ${r2 ? won(r2[2]) : '–'} | ${won(low)} |`);
    }
    out.push('', '</details>', '');
  }
  return out.join('\n');
}

async function telegram(text) {
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('[telegram 미설정] 보낼 메시지:\n' + text); return; }
  for (let i = 0; i < text.length; i += 3900) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(i, i + 3900), disable_web_page_preview: true }),
    });
    if (!r.ok) console.log('telegram error', r.status, await r.text());
  }
}

function alertText(alerts, repoUrl) {
  const lines = [`[HoteLux 요금 알림] ${alerts.length}건`];
  const sorted = [...alerts].sort((a, b) => (b.pct || 0) - (a.pct || 0));
  for (const a of sorted.slice(0, 20)) {
    const why = a.kind === 'drop' ? `역대최저 대비 ▼${a.pct}%` : '목표가 도달';
    lines.push(`- ${a.hotel} ${fmtDate(a.date)} ${a.room.slice(0, 25)}: ${won(a.prev)}원 → ${won(a.now)}원 (${why})`);
  }
  if (alerts.length > 20) lines.push(`외 ${alerts.length - 20}건`);
  if (repoUrl) lines.push(`전체 현황: ${repoUrl}/blob/HEAD/report.md`);
  return lines.join('\n');
}

const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}` : '';
const OUT_DIR = new URL('./out/', import.meta.url);
const ALERTS_FILE = new URL('./data/alerts.json', import.meta.url);
const [mode, arg] = process.argv.slice(2);

// 사용법: node scan.mjs scan <호텔키>  → out/<호텔키>.json
//         node scan.mjs merge         → out/*.json 을 합쳐 비교·기록·알림
//         node scan.mjs               → (로컬 테스트) 전체 조회 후 merge
async function runScan(keys) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const key of keys) {
    const h = CFG.hotels.find(x => x.key === key);
    if (!h) { console.log('config.json 에 없는 호텔:', key); continue; }
    const r = await scanHotel(h);
    console.log(`${key} 완료: ok=${r.ok} n=${r.st.n} blocks=${r.st.blocks} errs=${r.st.errs} 마지막오류=${r.st.lastErr}`);
    fs.writeFileSync(new URL(`./${key}.json`, OUT_DIR), JSON.stringify(r));
  }
  if (browser) await browser.close();
}

async function runMerge() {
  const today = kstToday();
  const scanAt = new Date().toISOString();
  const prevLatest = readJson(LATEST_FILE, { res: {}, times: {} });
  const firstRun = !fs.existsSync(STATE_FILE);
  const okRes = {}, failed = [], times = { ...(prevLatest.times || {}) };
  const allRes = { ...(prevLatest.res || {}) };
  for (const h of CFG.hotels) {
    const r = readJson(new URL(`./${h.key}.json`, OUT_DIR), null);
    if (r && r.ok) { okRes[h.key] = r.res; allRes[h.key] = r.res; times[h.key] = scanAt; }
    else failed.push({ key: h.key, name: h.name, err: r ? (r.st.lastErr || '대부분 실패') : '조회 결과 없음' });
  }
  for (const k of Object.keys(allRes)) if (!CFG.hotels.find(h => h.key === k)) { delete allRes[k]; delete times[k]; }
  const { state, alerts } = compare(okRes, today);
  const newHotels = CFG.hotels.filter(h => okRes[h.key] && !(prevLatest.res || {})[h.key]).map(h => h.key);
  fs.mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  fs.writeFileSync(LATEST_FILE, JSON.stringify({ scanAt, today, res: allRes, times }));
  fs.writeFileSync(REPORT_FILE, buildReport(allRes, state, scanAt, times));

  // 호텔별 4개월 최저가 (Claude 알림·첫 조회 안내용)
  const best = {};
  for (const h of CFG.hotels) {
    let b = null;
    for (const [ci, rows] of Object.entries(allRes[h.key] || {})) { const r = rows && rows[0]; if (r && ci >= today && (!b || r[2] < b.krw)) b = { date: ci, krw: r[2], room: r[0], plan: r[1] }; }
    best[h.key] = { name: h.name, ...(b || {}) };
  }
  fs.writeFileSync(ALERTS_FILE, JSON.stringify({ runAt: scanAt, firstRun, newHotels, failed, alerts, best }, null, 1));

  const lines = [];
  if (alerts.length) lines.push(alertText(alerts, repoUrl));
  if (firstRun || newHotels.length) {
    const block = [`[HoteLux 알림] ${firstRun ? '첫 조회 완료!' : '새 호텔 첫 조회 완료!'} 조회 기간 내 최저가:`];
    for (const h of CFG.hotels) if (firstRun || newHotels.includes(h.key)) { const b = best[h.key]; block.push(`- ${h.name}: ${b.krw ? `${fmtDate(b.date)} ${won(b.krw)}원` : '해당 요금 없음'}`); }
    lines.push(block.join('\n'));
  }
  if (failed.length) lines.push(`[HoteLux 알림] 조회 실패: ${failed.map(f => `${f.name}(${f.err})`).join(', ')}. 해당 호텔은 이전 기록을 유지했어요.`);
  if (lines.length) await telegram(lines.join('\n\n')); else console.log('알림 없음');
}

if (mode === 'scan') await runScan(arg ? [arg] : CFG.hotels.map(h => h.key));
else if (mode === 'merge') await runMerge();
else { await runScan(CFG.hotels.map(h => h.key)); await runMerge(); }

// ---------- 테스트용 가짜 응답 (MOCK=1) ----------
function mockResponse(body) {
  const ci = body.stay.date.checkIn;
  const seed = [...(body.hotel._id + ci)].reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = 300000 + (seed % 50) * 10000;
  const drop = process.env.MOCK_DROP === '1' && ci.endsWith('5') ? 0.85 : 1;
  return {
    rooms: [
      { nameEn: 'Deluxe King', rates: [
        { nameEn: 'Hyatt Prive', priceDetail: { aggregated: { sum: Math.round(base * drop), currency: 'KRW' } } },
        { nameEn: 'Member Rate', priceDetail: { aggregated: { sum: base - 50000, currency: 'KRW' } } },
      ] },
      { nameEn: 'Premier Twin', rates: [
        { nameEn: 'CHARMDEER Exclusive Rate', priceDetail: { aggregated: { sum: base + 40000, currency: 'KRW' } } },
        { nameEn: 'Vita Commissionable Rate', priceDetail: { aggregated: { sum: base - 90000, currency: 'KRW' } } },
      ] },
      { nameEn: 'Suite', rates: [{ nameEn: 'Hyatt Prive', priceDetail: { aggregated: { sum: base * 3, currency: 'KRW' } } }] },
    ],
  };
}
