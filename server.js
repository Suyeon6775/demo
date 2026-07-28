const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const API_KEY = process.env.OPENAI_API_KEY || '';
const PORT = 3000;

const IMAGES_DIR = path.join(__dirname, 'saved_images');
if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

let exhibitionState = {
  mode: 'idle',
  currentScan: null,
  viewMode: 'both',
  lossLevel: 0,
  depthLevel: 0,
  scans: [],
};

// 이미지 생성 로직 (프롬프트 강화)
function generateAndSave(reqBody, filename, cb) {
  const bodyStr = JSON.stringify(reqBody);
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/images/generations',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };

  const proxy = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', (d) => (data += d));
    apiRes.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error || !parsed.data?.[0]) {
          cb(null, parsed.error?.message || '이미지 생성 실패');
          return;
        }
        const filePath = path.join(IMAGES_DIR, filename);
        const imageData = Buffer.from(parsed.data[0].b64_json, 'base64');
        fs.writeFile(filePath, imageData, (err) => {
          if (err) {
            cb(null, err.message);
            return;
          }
          cb(`/saved_images/${filename}`, null);
        });
      } catch (e) {
        cb(null, e.message);
      }
    });
  });
  proxy.on('error', (e) => cb(null, e.message));
  proxy.write(bodyStr);
  proxy.end();
}

function callGPT(body, cb) {
  const bodyStr = JSON.stringify(body);
  const opts = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  };
  const r = https.request(opts, (apiRes) => {
    let data = '';
    apiRes.on('data', (d) => (data += d));
    apiRes.on('end', () => {
      const parsed = JSON.parse(data);
      cb(parsed.choices?.[0]?.message?.content?.trim() || '오류');
    });
  });
  r.on('error', () => cb('네트워크 오류'));
  r.write(bodyStr);
  r.end();
}

const httpServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  if (req.url.startsWith('/saved_images/')) {
    const filename = req.url.replace('/saved_images/', '');
    const filePath = path.join(IMAGES_DIR, filename);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
    return;
  }
  // saved_images 파일 목록 반환
  if (req.url === '/api/saved-images') {
    fs.readdir(IMAGES_DIR, (err, files) => {
      if (err) {
        res.writeHead(500);
        res.end('[]');
        return;
      }
      const imgs = files
        .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
        .map(f => `/saved_images/${f}`);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(imgs));
    });
    return;
  }

  let filePath = req.url === '/' ? '/display.html' : req.url;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  socket.on('scan', async (data) => {
    const { base64, originalDataUrl } = data;
    exhibitionState.mode = 'scanning';
    io.emit('state', exhibitionState);

    let textA = '',
      textB = '';
    await new Promise((resolve) => {
      let done = 0;
      const finish = () => {
        if (++done === 2) resolve();
      };
      callGPT(
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64}` },
                },
                {
                  type: 'text',
                  text: '이 이미지를 객관적으로 한 문장으로 묘사하세요. 피사체, 색상, 형태에 집중하세요. 감정 없이. 반드시 한국어로만.',
                },
              ],
            },
          ],
        },
        (t) => {
          textA = t;
          finish();
        },
      );
      callGPT(
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content:
                '당신은 한국어로만 글을 쓰는 시인입니다. 반드시 한국어로만 응답하세요. 영어 사용 절대 금지.',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${base64}` },
                },
                {
                  type: 'text',
                  text: '이 이미지를 감각과 느낌으로 번역하세요. 2-3문장의 한국어 산문시로 작성하세요. 설명하지 말고 느낌으로만.',
                },
              ],
            },
          ],
        },
        (t) => {
          textB = t;
          finish();
        },
      );
    });

    // 텍스트 먼저 전송 — 애니메이션용
    io.emit('textReady', { textA, textB });

    const ts = Date.now();
    const [imgAUrl, imgBUrl] = await Promise.all([
      new Promise((resolve) =>
        generateAndSave(
          {
            model: 'gpt-image-1',
            prompt: `Objective technical photograph, inventory style, flat neutral lighting, 8k, sharp. Subject: ${textA}. ABSOLUTELY NO TEXT.`,
            n: 1,
            size: '1024x1024',
          },
          `a_${ts}.png`,
          (url) => resolve(url),
        ),
      ),
      new Promise((resolve) =>
        generateAndSave(
          {
            model: 'gpt-image-1',
            prompt: `Poetic, cinematic, atmospheric photograph, emotive quality, shallow depth of field. Subject: ${textB}. ABSOLUTELY NO TEXT.`,
            n: 1,
            size: '1024x1024',
          },
          `b_${ts}.png`,
          (url) => resolve(url),
        ),
      ),
    ]);

    const scan = {
      id: ts,
      timestamp: new Date().toISOString(),
      originalDataUrl,
      textA,
      textB,
      imageA: imgAUrl,
      imageB: imgBUrl,
      depthChain: [{ textA, textB, imageA: imgAUrl, imageB: imgBUrl }],
    };
    exhibitionState.currentScan = scan;
    exhibitionState.scans.unshift(scan);
    exhibitionState.mode = 'result';
    io.emit('state', exhibitionState);
  });

  socket.on('deepen', async () => {
    // deepen 로직
  });

  // 아카이브 모드 진입
  socket.on('showArchive', () => {
    exhibitionState.mode = 'archive';
    io.emit('state', exhibitionState);
  });

  // 아카이브에서 특정 항목 선택
  socket.on('selectArchive', (index) => {
    io.emit('selectArchive', index);
  });

  // 아카이브 나가기
  socket.on('exitArchive', () => {
    exhibitionState.mode = exhibitionState.currentScan ? 'result' : 'idle';
    io.emit('state', exhibitionState);
  });

  // 기존 이벤트들
  socket.on('setView', (mode) => {
    exhibitionState.viewMode = mode;
    io.emit('state', exhibitionState);
  });

  socket.on('setLoss', (level) => {
    exhibitionState.lossLevel = level;
    io.emit('state', exhibitionState);
  });
});

httpServer.listen(PORT, () =>
  console.log(`✅ 서버 구동: http://localhost:${PORT}`),
);
