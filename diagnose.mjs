// HoteLux 접속 진단 (한 번만 실행하는 용도)
// GitHub 서버 위치, 세션 없는 요청, 브라우저로 페이지를 열었을 때 사이트가 주는 응답을 모아 텔레그램으로 보낸다.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const HOTEL = '5c1e76d93457456c0777a5ee'; // 파크 하얏트 부산
const CI = addDays(kst(), 16), CO = addDays(kst(), 17);
const PAGE = `https://hotel.hotelux.com/#/hotel/detail?locationType=city&showLabel=Busan&locationRef=59ad4641e32d2a86e654b2be&checkIn=${CI}&checkOut=${CO}&numberOfAdults=2&numberOfChildren=0&numberOfRooms=1&hotelId=${HOTEL}`;
const RATES_BODY = { hotel: { _id: HOTEL }, stay: { date: { checkIn: CI, checkOut: CO }, numberOfAdults: 2, numberOfChildren: 0, numberOfRooms: 1 } };
const CAL_BODY = { preferred: { version: 'v1' }, dateRange: { start: kst(), end: addDays(kst(), 29) }, hotel: { _id: HOTEL } };

const out = [];
const log = s => { console.log(s); out.push(s); };
const short = (s, n = 160) => String(s).replace(/\s+/g, ' ').slice(0, n);
const summarize = t => {
  try {
    const j = JSON.parse(t);
    if (j.err) return 'err: ' + (j.err.messageKey || j.err.message);
    if (j.rooms) return `ok rooms=${j.rooms.length}`;
    if (j.results) return `ok results=${j.results.length}`;
    return 'ok ' + short(JSON.stringify(j), 120);
  } catch { return 'text: ' + short(t, 120); }
};

// 1. 서버 위치
try {
  const j = await (await fetch('https://ipinfo.io/json')).json();
  log(`1) 서버 위치: ${j.country} ${j.region || ''} / ${j.org || ''}`);
} catch (e) { log('1) 서버 위치 확인 실패: ' + e.message); }

// 2. 브라우저 없이 바로 요청
try {
  const r = await fetch('https://hotel.hotelux.com/services/booking/hotel/rates?mode=asyncPagingMerged', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://hotel.hotelux.com', referer: 'https://hotel.hotelux.com/' }, body: JSON.stringify(RATES_BODY),
  });
  log(`2) 직접 요청: HTTP ${r.status} ${summarize(await r.text())}`);
} catch (e) { log('2) 직접 요청 실패: ' + e.message); }

// 3. 브라우저로 페이지 열기 + 사이트가 스스로 보내는 요청 관찰
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
const page = await ctx.newPage();
const seen = [];
page.on('response', async resp => {
  const u = resp.url();
  if (!u.includes('/services/')) return;
  let t = ''; try { t = await resp.text(); } catch {}
  seen.push(`${resp.request().method()} ${u.replace('https://hotel.hotelux.com/services/', '').split('?')[0]} → ${resp.status()} ${summarize(t)}`);
});
await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 90000 }).catch(e => log('3) 페이지 열기 경고: ' + e.message));
await sleep(15000);
log(`3) 페이지 제목: ${await page.title()}`);
const text = await page.evaluate(() => document.body.innerText).catch(() => '');
const prices = (text.match(/(USD|KRW|₩)\s?[\d,]+/g) || []).slice(0, 3);
log(`3) 화면에 가격 표시: ${prices.length ? prices.join(', ') : '없음'}`);
log('3) 사이트가 보낸 요청:');
for (const s of seen.slice(0, 12)) log('   ' + s);

// 4. 열린 페이지 안에서 요청
const inPage = async (path, body) => page.evaluate(async ({ path, body }) => {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'include' });
  return { status: r.status, text: await r.text() };
}, { path, body }).catch(e => ({ status: 0, text: e.message }));
const a = await inPage('/services/booking/hotel/rates?mode=asyncPagingMerged', RATES_BODY);
log(`4) 페이지 안 요금 조회: HTTP ${a.status} ${summarize(a.text)}`);
await sleep(2000);
const b = await inPage('/services/booking/hotel/rateCalendar', CAL_BODY);
log(`4) 페이지 안 달력 조회: HTTP ${b.status} ${summarize(b.text)}`);
const cookies = (await ctx.cookies()).map(c => c.name);
log(`4) 받은 쿠키: ${cookies.length ? cookies.join(', ') : '없음'}`);
await browser.close();

// 텔레그램 전송
const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
const msg = '[HoteLux 진단 결과]\n' + out.join('\n');
if (token && chat) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: msg.slice(0, 4000), disable_web_page_preview: true }) });
}
