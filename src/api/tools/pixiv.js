const axios = require("axios");
const path = require("node:path");
const { mkdir, writeFile } = require("node:fs/promises");

const BASE = "https://www.pixiv.net";
const UPLOAD_URL = "https://api.haidarxd.my.id/api/v1/tools/img-upload";
const TMPFILES_URL = "https://tmpfiles.org/api/v1/upload";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://www.pixiv.net/",
  Accept: "application/json",
};

const RANDOM_KEYWORDS = [
  "original", "girl", "landscape", "anime", "cat", "scenery",
  "illustration", "fantasy", "city", "sunset", "water", "night",
  "flower", "sky", "food", "rain", "forest", "ocean", "snow", "dragon",
];

class PixivError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ajax(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url.toString(), { headers: HEADERS });
      if (res.status === 200) {
        const data = res.data;
        if (data.error) throw new PixivError(data.message || "unknown error");
        return data.body;
      }
      lastErr = new PixivError(`HTTP ${res.status}`);
    } catch (e) {
      if (e instanceof PixivError && e.message !== "HTTP 503") throw e;
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr;
}

function cleanDesc(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

async function search(keyword, { page = 1, order = "date_d", mode = "all", sMode = "s_tag", limit = null } = {}) {
  const body = await ajax(`/ajax/search/artworks/${encodeURIComponent(keyword)}`, {
    word: keyword, order, mode, p: page, s_mode: sMode, type: "all", lang: "en",
  });
  const items = body?.illustManga?.data ?? [];
  const results = [];
  for (const it of items) {
    if (!it.id || it.isMasked) continue;
    results.push({
      id: String(it.id), title: it.title, author: it.userName,
      user_id: it.userId, tags: it.tags, page_count: it.pageCount,
      width: it.width, height: it.height, ai_type: it.aiType,
      create_date: it.createDate, url: `${BASE}/artworks/${it.id}`, thumb: it.url,
    });
    if (limit && results.length >= limit) break;
  }
  return results;
}

async function detail(illustId) {
  const b = await ajax(`/ajax/illust/${illustId}`, { lang: "en" });
  const tags = (b.tags?.tags ?? []).map((t) => t.tag);
  const urls = b.urls ?? {};
  const pageCount = b.pageCount ?? 1;
  let pages = [];
  if (pageCount > 1) {
    try {
      const pb = await ajax(`/ajax/illust/${illustId}/pages`, { lang: "en" });
      pages = pb.map((p, i) => ({ page: i, original: p.urls?.original, regular: p.urls?.regular }));
    } catch {}
  } else if (urls.original) {
    pages = [{ page: 0, original: urls.original, regular: urls.regular }];
  }
  return {
    id: b.illustId || String(illustId), title: b.title, description: cleanDesc(b.description),
    author: b.userName, user_id: b.userId, author_url: b.userId ? `${BASE}/users/${b.userId}` : null,
    tags, page_count: pageCount, width: b.width, height: b.height, create_date: b.createDate,
    upload_date: b.uploadDate, view_count: b.viewCount, like_count: b.likeCount,
    bookmark_count: b.bookmarkCount, comment_count: b.commentCount, ai_type: b.aiType,
    illust_type: b.illustType, x_restrict: b.xRestrict, url: `${BASE}/artworks/${illustId}`,
    images: Object.fromEntries(["original", "regular", "small", "thumb", "mini"].filter((k) => urls[k]).map((k) => [k, urls[k]])),
    pages,
  };
}

async function getBytes(url) {
  const res = await axios.get(url, { headers: HEADERS, responseType: 'arraybuffer' });
  if (res.status !== 200) throw new PixivError(`HTTP ${res.status} saat mengunduh`);
  return Buffer.from(res.data);
}

async function postUpload(fname, content) {
  let err;
  try {
    const fd = new FormData();
    fd.append("file", new Blob([content]), fname);
    const up = await axios.post(UPLOAD_URL, fd, { headers: { "User-Agent": HEADERS["User-Agent"] } });
    if (up.status !== 200) throw new PixivError(`HTTP ${up.status}`);
    const j = up.data;
    const link = j?.data?.url || j?.url;
    if (link) return link;
    throw new PixivError(JSON.stringify(j).slice(0, 120));
  } catch (e) {
    if (/413/.test(e.message)) throw e;
    err = e;
  }
  try {
    const fd2 = new FormData();
    fd2.append("file", new Blob([content]), fname);
    const up2 = await axios.post(TMPFILES_URL, fd2, { headers: { "User-Agent": HEADERS["User-Agent"] } });
    if (up2.status !== 200) throw new PixivError(`HTTP ${up2.status}`);
    const j2 = up2.data;
    const u = j2?.data?.url;
    if (!u) throw new PixivError("tmpfiles: respons tak dikenal");
    return u.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  } catch {
    throw err || new PixivError("upload gagal di host utama & tmpfiles");
  }
}

async function uploadPage(pageInfo, id) {
  const base = `${id}_p${pageInfo.page}`;
  const ext = path.extname(new URL(pageInfo.original).pathname) || ".jpg";
  const fname = base + ext;
  const content = await getBytes(pageInfo.original);
  try {
    const link = await postUpload(fname, content);
    return { file: fname, size: content.length, url: link };
  } catch (e) {
    if (!/413/.test(e.message)) throw e;
  }
  if (pageInfo.regular) {
    try {
      const rc = await getBytes(pageInfo.regular);
      const rfname = base + ".jpg";
      const link = await postUpload(rfname, rc);
      return { file: rfname, size: rc.length, url: link };
    } catch {}
  }
  throw new PixivError("gambar melebihi batas ukuran server upload (413)");
}

async function uploadWithRetry(url, fname, retries = 3) {
  let err;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const content = await getBytes(url);
      const link = await postUpload(fname, content);
      return [link, content.length];
    } catch (e) {
      err = e;
      if (/413/.test(e.message)) break;
      await sleep(1000 + attempt * 1000);
    }
  }
  throw err;
}

async function uploadImages(illustId, d) {
  d = d || (await detail(illustId));
  let pages = d.pages ?? [];
  if (!pages.length && d.images.original) pages = [{ page: 0, original: d.images.original, regular: d.images.regular }];
  if (!pages.length) throw new PixivError("URL gambar tidak ditemukan");

  const files = [];
  const errors = [];
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    let res;
    let lastErr;
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      try {
        res = await uploadPage(pages[i], d.id);
      } catch (e) {
        lastErr = e;
        if (/413|batas ukuran/.test(e.message)) break;
        await sleep(1000 + attempt * 1000);
      }
    }
    if (res) files.push({ page: pages[i].page, ...res });
    else errors.push({ page: pages[i].page, error: lastErr?.message || "gagal" });
  }
  return [files, errors];
}

async function uploadThumbs(results) {
  const total = results.length;
  let done = 0;
  const work = async (r) => {
    if (r.thumb) {
      try {
        const [link] = await uploadWithRetry(r.thumb, `pixif_${r.id}_thumb`);
        r.image = link;
      } catch {}
    }
    done++;
  };
  const queue = [...results];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) await work(queue.shift());
    })
  );
  return results;
}

async function getPages(illustId) {
  const b = await ajax(`/ajax/illust/${illustId}/pages`, { lang: "en" });
  return b.map((p, i) => ({
    page: i, width: p.width, height: p.height,
    original: p.urls?.original, regular: p.urls?.regular, small: p.urls?.small,
  }));
}

async function downloadArtwork(illustId, { outDir = "downloads", allPages = false } = {}) {
  const d = await detail(illustId);
  const pageCount = d.page_count ?? 1;
  let targets;
  if (pageCount > 1) {
    const pages = await getPages(illustId);
    targets = allPages ? pages.map((p) => [p.page, p.original]) : [[0, pages[0].original]];
  } else {
    targets = [[0, d.images.original]];
  }
  if (targets.some(([, u]) => !u)) throw new PixivError("URL gambar tidak ditemukan");

  await mkdir(outDir, { recursive: true });
  const files = [];
  for (const [page, url] of targets) {
    const ext = path.extname(new URL(url).pathname) || ".jpg";
    const file = path.join(outDir, `${d.id}_p${page}${ext}`);
    const res = await axios.get(url, { headers: HEADERS, responseType: 'arraybuffer' });
    if (res.status !== 200) throw new PixivError(`HTTP ${res.status} untuk ${url}`);
    const buf = Buffer.from(res.data);
    await writeFile(file, buf);
    files.push({ page, file, bytes: buf.length });
    await sleep(300);
  }
  return { artwork: d, files };
}

async function randomPosts(n = 5, maxPage = 30) {
  const seen = new Set();
  const posts = [];
  const maxAttempts = n * 8;
  let attempts = 0;

  while (posts.length < n && attempts < maxAttempts) {
    attempts++;
    const kw = RANDOM_KEYWORDS[Math.floor(Math.random() * RANDOM_KEYWORDS.length)];
    const page = 1 + Math.floor(Math.random() * Math.min(maxPage, 40));
    let items;
    try {
      items = await search(kw, { page, limit: 60 });
    } catch {
      continue;
    }
    const usable = items.filter((it) => !seen.has(it.id));
    if (!usable.length) continue;

    const shuffled = usable.sort(() => Math.random() - 0.5).slice(0, n - posts.length);
    for (const p of shuffled) {
      seen.add(p.id);
      try {
        posts.push(await detail(p.id));
      } catch {}
      await sleep(400);
    }
  }

  if (posts.length < n) throw new PixivError(`hanya dapat ${posts.length} dari ${n} post`);
  return posts.slice(0, n);
}

module.exports = function (app) {
  // Endpoint: Search (Kategori Search)
  const handleSearch = async (req, res) => {
    const q = req.query.q || req.query.query;
    const { page = 1, limit, order = "date_d", no_upload = "false" } = req.query;
    if (!q) return res.status(400).json({ status: false, error: "Parameter 'q' wajib diisi" });

    try {
      let results = await search(q, {
        page: parseInt(page),
        order,
        limit: limit ? parseInt(limit) : null,
      });
      if (no_upload !== "true" && results.length) results = await uploadThumbs(results);
      res.status(200).json({ status: true, result: results });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  };
  app.get("/search/pixiv", handleSearch);
  app.get("/tools/pixiv/search", handleSearch);

  // Endpoint: Detail / Info (Kategori Info)
  const handleDetail = async (req, res) => {
    let id = req.query.id || req.query.url;
    const { no_upload = "false" } = req.query;
    if (id && typeof id === "string") {
      const match = id.match(/artworks\/(\d+)/) || id.match(/(\d+)/);
      if (match) id = match[1];
    }
    if (!id || !/^\d+$/.test(id)) return res.status(400).json({ status: false, error: "Parameter 'id' (angka atau link Pixiv) wajib diisi" });

    try {
      let d = await detail(id);
      if (no_upload !== "true") {
        const [files, errors] = await uploadImages(id, d);
        d.uploaded = files;
        d.upload_errors = errors;
      }
      res.status(200).json({ status: true, result: d });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  };
  app.get("/info/pixiv", handleDetail);
  app.get("/tools/pixiv/detail", handleDetail);

  // Endpoint: Download (Kategori Downloader)
  const handleDownload = async (req, res) => {
    let id = req.query.id || req.query.url;
    const { all_pages = "false", out_dir = "downloads" } = req.query;
    if (id && typeof id === "string") {
      const match = id.match(/artworks\/(\d+)/) || id.match(/(\d+)/);
      if (match) id = match[1];
    }
    if (!id || !/^\d+$/.test(id)) return res.status(400).json({ status: false, error: "Parameter 'id' (angka atau link Pixiv) wajib diisi" });

    try {
      const result = await downloadArtwork(id, {
        outDir: out_dir,
        allPages: all_pages === "true",
      });
      res.status(200).json({ status: true, result });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  };
  app.get("/download/pixiv", handleDownload);
  app.get("/tools/pixiv/download", handleDownload);

  // Endpoint: Random (Kategori Image)
  const handleRandom = async (req, res) => {
    const { num = 5, no_upload = "false" } = req.query;
    try {
      let posts = await randomPosts(parseInt(num) || 5);
      if (no_upload !== "true") {
        for (let i = 0; i < posts.length; i++) {
          try {
            const [files, errors] = await uploadImages(posts[i].id, posts[i]);
            posts[i].uploaded = files;
            posts[i].upload_errors = errors;
          } catch (e) {
            posts[i].uploaded = [];
            posts[i].upload_errors = [{ error: e.message }];
          }
        }
        posts = posts.filter((p) => p.uploaded?.length);
      }
      res.status(200).json({ status: true, result: posts });
    } catch (error) {
      res.status(500).json({ status: false, error: error.message });
    }
  };
  app.get("/image/pixiv", handleRandom);
  app.get("/image/pixiv-random", handleRandom);
  app.get("/tools/pixiv/random", handleRandom);
};