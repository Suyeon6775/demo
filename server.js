const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;

const API_KEY = process.env.OPENAI_API_KEY || '';
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

let exhibitionState = {
  mode: 'idle',
  currentScan: null,
  viewMode: 'both',
  lossLevel: 0,
  depthLevel: 0,
  scans: [],
};

// Cloudinary에 base64 이미지 업로드
function uploadToCloudinary(base64Data, filename) {
  return new Promise((resolve, reject) => {
    const dataUri = `data:image/png;base64,${base64Data}`;
    cloudinary.uploader.upload(dataUri, {
      public_id: filename,
      folder: 'paradox-of-translation',
      overwrite: true,
    }, (err, result) => {
      if (err) reject(err);
      else resolve(result.secure_url);
    });
  });
}

// OpenAI로 이미지 생성 후 Cloudinary에 저장
function generateAndUpload(reqBody, filename, cb) {
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
    apiRes.on('end', async () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error || !parsed.data?.[0]) {
          cb(null, parsed.error?.message || '이미지 생성 실패');
          return;
        }
        const base64 = parsed.data[0].b64_json;
        const url = await uploadToCloudinary(base64, filename);
        cb(url, null);
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

  // Cloudinary에서 저장된 이미지 목록 반환
  if (req.url === '/api/saved-images') {
    cloudinary.search
      .expression('folder:paradox-of-translation')
      .sort_by('created_at', 'desc')
      .max_results(100)
      .execute()
      .then((result) => {
        const urls = result.resources.map((r) => r.secure_url);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(urls));
      })
      .catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
      });
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
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

    let textA = '', textB = '';
    await new Promise((resolve) => {
      let done = 0;
      const finish = () => { if (++done === 2) resolve(); };
      callGPT(
        {
          model: 'gpt-4o',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
                { type: 'text', text: '이 이미지를 객관적으로 한 문장으로 묘사하세요. 피사체, 색상, 형태에 집중하세요. 감정 없이. 반드시 한국어로만.' },
              ],
            },
          ],
        },
        (t) => { textA = t; finish(); },
      );
      callGPT(
        {
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: '당신은 한국어로만 글을 쓰는 시인입니다. 반드시 한국어로만 응답하세요. 영어 사용 절대 금지.' },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
                { type: 'text', text: '이 이미지를 감각과 느낌으로 번역하세요. 2-3문장의 한국어 산문시로 작성하세요. 설명하지 말고 느낌으로만.' },
              ],
            },
          ],
        },
        (t) => { textB = t; finish(); },
      );
    });

    io.emit('textReady', { textA, textB });

    const ts = Date.now();
    const [imgAUrl, imgBUrl] = await Promise.all([
      new Promise((resolve) =>
        generateAndUpload(
          {
            model: 'gpt-image-1',
            prompt: `Objective technical photograph, inventory style, flat neutral lighting, 8k, sharp. Subject: ${textA}. ABSOLUTELY NO TEXT.`,
            n: 1,
            size: '1024x1024',
          },
          `a_${ts}`,
          (url) => resolve(url),
        ),
      ),
      new Promise((resolve) =>
        generateAndUpload(
          {
            model: 'gpt-image-1',
            prompt: `Poetic, cinematic, atmospheric photograph, emotive quality, shallow depth of field. Subject: ${textB}. ABSOLUTELY NO TEXT.`,
            n: 1,
            size: '1024x1024',
          },
          `b_${ts}`,
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

  socket.on('deepen', async () => {});

  socket.on('showArchive', () => {
    exhibitionState.mode = 'archive';
    io.emit('state', exhibitionState);
  });

  socket.on('selectArchive', (index) => {
    io.emit('selectArchive', index);
  });

  socket.on('exitArchive', () => {
    exhibitionState.mode = exhibitionState.currentScan ? 'result' : 'idle';
    io.emit('state', exhibitionState);
  });

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
