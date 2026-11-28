// ランダムな作品IDをまとめてPixiv APIで確認し、存在する作品の情報だけを返す。
// 結果はVercelのCDNにキャッシュされるので、訪問者が増えてもPixivへの問い合わせは増えない。
//
// GET /api/batch?type=illust|novel&max=<最大ID>&shard=<0〜SHARDS-1>
// 返り値: { type, checked, errors, items: [{ id, x, ai }] }
//   x: 0=全年齢, 1=R-18, 2=R-18G / ai: AI生成ならtrue
//   削除済み・非公開の作品は items に含まれない

const ALLOWED_ORIGINS = [
  'https://tarikomo.github.io',
  'http://localhost:8765',
];
const IDS_PER_BATCH = 60;
const CONCURRENCY = 10;
const SHARDS = 5;
const MAX_ALLOWED_ID = 500_000_000;
const CACHE_SECONDS = 600;
const ERROR_CACHE_SECONDS = 60;

const PIXIV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.pixiv.net/',
  'Accept': 'application/json',
};

// 1作品を確認する。存在すれば {id, x, ai}、削除済み・非公開なら null、判定できなければ 'error'
async function check(type, id) {
  try {
    const res = await fetch(`https://www.pixiv.net/ajax/${type}/${id}`, {
      headers: PIXIV_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return 'error';
    const data = await res.json();
    if (data.error || !data.body) return null;
    return { id, x: data.body.xRestrict ?? 0, ai: data.body.aiType === 2 };
  } catch {
    return 'error';
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  const type = req.query.type === 'novel' ? 'novel' : 'illust';
  const max = Number.parseInt(req.query.max, 10);
  const shard = Number.parseInt(req.query.shard, 10);
  if (!(max >= 1 && max <= MAX_ALLOWED_ID) || !(shard >= 0 && shard < SHARDS)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ error: 'invalid parameters' });
  }

  const ids = Array.from({ length: IDS_PER_BATCH }, () => Math.floor(Math.random() * max) + 1);
  const results = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(chunk.map((id) => check(type, id))));
  }

  const errors = results.filter((r) => r === 'error').length;
  const items = results.filter((r) => r && r !== 'error');

  // Pixivに拒否されている時は短くキャッシュして、問い合わせ過多にならないようにする
  const failing = errors > IDS_PER_BATCH / 2;
  const seconds = failing ? ERROR_CACHE_SECONDS : CACHE_SECONDS;
  res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
  res.status(failing ? 503 : 200).json({ type, checked: IDS_PER_BATCH, errors, items });
}
