require('dotenv').config();
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');
const { chromium } = require('playwright');

const client = new Anthropic();
const PORT = Number(process.env.PORT) || 3000;

const SYSTEM = `너는 행사 페이지에서 핵심 정보를 추출하는 한국어 분석가야.
주어진 본문을 분석해서 <output_format>의 JSON 한 줄로만 응답해.

<input>
사용자 메시지 안에 다음 3가지 필드가 들어있다.
- URL: 행사 페이지 주소
- 제목: 페이지 <title>
- 페이지 본문: 헤드리스 브라우저가 JS 실행 후 추출한 텍스트
</input>

<output_format>
JSON 객체 1개. 키 5개. 시작은 반드시 { 로. 코드펜스 · 인사 · 사과 · 설명 · JSON 외 텍스트 모두 금지.
{"eventName":"...","eventInfo":"...","eventDate":"...","groomAccount":"...","brideAccount":"..."}
- eventName: 행사명 (성을 포함한 풀네임 · 가운뎃점 양쪽 공백)
- eventInfo: 날짜 · 시간 · 장소를 한 문장으로
- eventDate: ISO 8601 (YYYY-MM-DD) 또는 ""
- groomAccount: 신랑 본인 계좌 ("은행명 계좌번호" 형식) 또는 ""
- brideAccount: 신부 본인 계좌 ("은행명 계좌번호" 형식) 또는 ""
</output_format>

<rules>
- eventName: 사람 이름은 반드시 **성까지 포함한 풀네임**. 본문에 풀네임이 보이면 그걸 사용. 가운뎃점은 양쪽 공백 한 칸씩 ("박찬일 · 박연수 결혼식")
- eventInfo: 날짜 · 시간 · 장소를 한 문장으로
- eventDate: 본문에서 **명확한 날짜**를 찾았을 때만 ISO 8601 (YYYY-MM-DD)
- groomAccount / brideAccount: 본문에 **신랑 본인 / 신부 본인** 계좌가 명시되어 있을 때만 채움. 부모 계좌만 있고 본인 계좌가 없으면 그것이라도 채우되 어디 계좌인지(예: "신랑부 김철수 국민 123-...") 명시. 본인·부모 모두 없으면 "".
- 계좌 형식: "은행명 계좌번호" (예: "국민은행 123-45-6789012"). 번호는 본문에 표기된 그대로(하이픈 포함)
- 모르는 사실은 빈 문자열("")
- 본문 밖 외부 지식 · 추측 금지
- 엣지 케이스
  · 본문이 비었거나 행사 정보가 없음 → 모든 값 ""
  · 날짜만 모호 → eventDate만 ""
  · 시간 또는 장소만 모호 → 해당 부분 생략하고 가능한 정보만 eventInfo에 적음
  · 계좌 정보가 없거나 가려진 상태 → groomAccount/brideAccount는 ""
</rules>

<examples>
입력:
URL: https://salondeletter.com/w/yin1e090sr
제목: 찬일•연수의 결혼식에 초대합니다
페이지 본문: 신랑 박찬일 (국민 123456-78-901234) / 신부 박연수 (신한 110-987-654321) / 2026년 5월 9일 토요일 낮 12시 / 양재 온누리교회 사랑홀 ...

출력:
{"eventName":"박찬일 · 박연수 결혼식","eventInfo":"2026년 5월 9일 12:00, 양재 온누리교회 사랑홀","eventDate":"2026-05-09","groomAccount":"국민은행 123456-78-901234","brideAccount":"신한은행 110-987-654321"}
</examples>`;

const HTML_PATH = path.join(__dirname, 'index.html');
const PAGE_TEXT_LIMIT = 8_000;
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'stylesheet']);

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
    } catch {}
    browserPromise = null;
  }
  browserPromise = (async () => {
    const b = await chromium.launch({ headless: true });
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  })();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

function validateUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error('유효한 URL이 아닙니다.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('http:// 또는 https:// URL만 지원합니다.');
  }
  return parsed.toString();
}

async function expandAccountSections(page) {
  const primary = ['마음 전하실', '마음전하실', '축의금', '축하금', '계좌번호', '혼주'];
  const secondary = ['신랑 측', '신랑측', '신부 측', '신부측'];

  // 1) 클릭 기반 (다른 사이트 호환)
  async function realClick(keyword) {
    try {
      const locator = page.getByText(keyword, { exact: false });
      const count = await locator.count();
      for (let i = 0; i < Math.min(count, 3); i++) {
        await locator.nth(i)
          .click({ timeout: 500, force: true, noWaitAfter: true })
          .catch(() => {});
        await page.waitForTimeout(120);
      }
    } catch {}
  }
  for (const kw of [...primary, ...secondary]) await realClick(kw);
  await page.waitForTimeout(400);

  // 2) 숨겨진 계좌 영역 강제로 보이게 — display:none 해제
  await page.evaluate(() => {
    const selectors = [
      '.account_list', '.account_wrap', '.account_box',
      '[class*="account"]', '[class*="bank"]',
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.style && el.style.display === 'none') el.style.display = 'block';
      });
    }
    // 내부 자식들 중 inline style로 display:none인 것도 해제 (계좌번호 input 등)
    document.querySelectorAll('[style*="display"]').forEach((el) => {
      if (el.style.display === 'none') {
        const cls = String(el.className || '');
        const par = el.closest('[class*="account"], [class*="bank"]');
        if (par || /account|bank|acc/.test(cls)) el.style.display = '';
      }
    });
  });
  await page.waitForTimeout(300);
}

async function fetchPageTextOnce(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    locale: 'ko-KR',
    viewport: { width: 1280, height: 900 },
  });
  await context.route('**/*', (route) => {
    if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page
      .waitForFunction(
        () => document.body && document.body.innerText.trim().length > 200,
        null,
        { timeout: 5_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(500);
    await expandAccountSections(page);
    const title = await page.title();
    const text = await page.evaluate(() => {
      const body = document.body;
      return body ? body.innerText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : '';
    });
    return { title, text: text.slice(0, PAGE_TEXT_LIMIT) };
  } finally {
    try { await context.close(); } catch {}
  }
}

function isBrowserDeadError(err) {
  const msg = String((err && err.message) || err);
  return /has been closed|Target .* closed|Browser closed|browser has disconnected|Connection closed/i.test(msg);
}

async function fetchPageText(url) {
  try {
    return await fetchPageTextOnce(url);
  } catch (err) {
    if (!isBrowserDeadError(err)) throw err;
    browserPromise = null;
    return await fetchPageTextOnce(url);
  }
}

function parseJsonReply(text) {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('JSON 응답을 찾을 수 없음: ' + text.slice(0, 200));
  }
  return JSON.parse(s.slice(start, end + 1));
}

async function summarize(userInput) {
  const url = validateUrl(userInput);
  const { title, text } = await fetchPageText(url);

  if (!text) {
    return { summary: '페이지 본문을 가져오지 못했습니다.', eventDate: '' };
  }

  const userContent =
    `URL: ${url}\n` +
    `제목: ${title || '(제목 없음)'}\n\n` +
    `페이지 본문 (JS 실행 후):\n${text}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });

  let lastText = '';
  for (const block of response.content) {
    if (block.type === 'text' && block.text.trim()) {
      lastText = block.text;
    }
  }

  const parsed = parseJsonReply(lastText);
  const eventName = typeof parsed.eventName === 'string' ? parsed.eventName.trim() : '';
  const eventInfo = typeof parsed.eventInfo === 'string' ? parsed.eventInfo.trim() : '';
  const summary = eventName && eventInfo
    ? `${eventName}\n${eventInfo}`
    : (eventName || eventInfo || '');
  return {
    summary,
    eventDate: typeof parsed.eventDate === 'string' ? parsed.eventDate : '',
    groomAccount: typeof parsed.groomAccount === 'string' ? parsed.groomAccount.trim() : '',
    brideAccount: typeof parsed.brideAccount === 'string' ? parsed.brideAccount.trim() : '',
  };
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('요청 본문이 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress || '-';
  res.on('finish', () => {
    const ms = Date.now() - startTime;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${ms}ms ip=${ip}`);
  });

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(HTML_PATH, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('index.html을 찾을 수 없습니다.');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      }
    });
    return;
  }

  if (req.method === 'GET' && (req.url === '/bg.jpg' || req.url === '/loading.gif')) {
    const fileName = req.url === '/bg.jpg' ? 'bg.jpg' : 'loading.gif';
    const contentType = req.url === '/bg.jpg' ? 'image/jpeg' : 'image/gif';
    const filePath = path.join(__dirname, fileName);
    fs.stat(filePath, (err) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${fileName}가 프로젝트 폴더에 없습니다.`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/summarize') {
    try {
      const body = await readBody(req);
      const { input } = JSON.parse(body || '{}');
      if (typeof input !== 'string' || !input.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '입력이 비었습니다.' }));
        return;
      }
      const trimmed = input.trim();
      console.log(`[summarize] target=${trimmed} ip=${ip}`);
      if (Buffer.byteLength(trimmed, 'utf8') > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '초대장 링크를 다시 확인해주세요' }));
        return;
      }
      const { summary, eventDate, groomAccount, brideAccount } = await summarize(trimmed);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ summary, eventDate, groomAccount, brideAccount }));
    } catch (err) {
      const status = err.status && Number.isInteger(err.status) ? err.status : 500;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message || '서버 오류' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

async function shutdown(signal) {
  console.log(`\n${signal} 수신. 종료 중...`);
  server.close(() => {});
  if (browserPromise) {
    try {
      const b = await browserPromise;
      await b.close();
    } catch {}
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 대기 중. Ctrl+C로 종료.`);
});
