/**
 * Judul : Play Lagu dari Spotify
 * Base Url : spotidown.app
 * Author : t.me/Velzyguy
 */

const axios = require("axios");
const cheerio = require("cheerio");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function searchSpotiDown(query) {
  try {
    const resHome = await axios.get("https://spotidown.app/en6", {
      headers: {
        "User-Agent": USER_AGENT,
      },
    });

    const cookies = resHome.headers["set-cookie"] || [];
    const cookieHeader = cookies.map((c) => c.split(";")[0]).join("; ");

    const $1 = cheerio.load(resHome.data);
    const hiddenInputs = {};
    $1('form[name="spotifyurl"] input[type="hidden"]').each((_, el) => {
      const name = $1(el).attr("name");
      const val = $1(el).attr("value") || "";
      if (name) hiddenInputs[name] = val;
    });

    const paramsAction = new URLSearchParams();
    paramsAction.append("url", query);
    for (const [k, v] of Object.entries(hiddenInputs)) {
      paramsAction.append(k, v);
    }

    const resAction = await axios.post(
      "https://spotidown.app/action",
      paramsAction.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookieHeader,
          Referer: "https://spotidown.app/en6",
          Origin: "https://spotidown.app",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    const responseData =
      typeof resAction.data === "string"
        ? JSON.parse(resAction.data)
        : resAction.data;

    if (responseData.error) {
      throw new Error(responseData.message || "Gagal mencari lagu");
    }

    const $2 = cheerio.load(responseData.data);
    const firstForm = $2('form[name="submitspurl"]').first();

    if (!firstForm.length) {
      throw new Error("Lagu tidak ditemukan");
    }

    const rawData = firstForm.find('input[name="data"]').val();
    const baseVal = firstForm.find('input[name="base"]').val();
    const tokenVal = firstForm.find('input[name="token"]').val();

    let trackMeta = {};
    if (rawData) {
      try {
        const decoded = Buffer.from(rawData, "base64").toString("utf-8");
        trackMeta = JSON.parse(decoded);
      } catch (e) {
        // ignore
      }
    }

    const paramsTrack = new URLSearchParams();
    paramsTrack.append("data", rawData);
    paramsTrack.append("base", baseVal);
    paramsTrack.append("token", tokenVal);

    let downloadUrl = null;
    const resTrack = await axios.post(
      "https://spotidown.app/action/track",
      paramsTrack.toString(),
      {
        headers: {
          "User-Agent": USER_AGENT,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Cookie: cookieHeader,
          Referer: "https://spotidown.app/en6",
          Origin: "https://spotidown.app",
          "X-Requested-With": "XMLHttpRequest",
        },
      }
    );

    const trackRespData =
      typeof resTrack.data === "string"
        ? JSON.parse(resTrack.data)
        : resTrack.data;
    if (!trackRespData.error && trackRespData.data) {
      const $dl = cheerio.load(trackRespData.data);
      downloadUrl = $dl("a.abutton[href]").attr("href") || null;
    }

    return {
      title: trackMeta.name || null,
      artist: trackMeta.artist || null,
      album: trackMeta.album || null,
      duration: trackMeta.duration || null,
      image: trackMeta.cover || null,
      download_url: downloadUrl,
    };
  } catch (error) {
    throw error;
  }
}

module.exports = function (app) {
  const handleSpotify = async (req, res) => {
    const query = req.query.query || req.query.url || req.query.q;

    if (!query) {
      return res.status(400).json({
        status: false,
        error: "Parameter 'query' atau 'url' wajib diisi",
      });
    }

    try {
      const result = await searchSpotiDown(query);
      res.status(200).json({
        status: true,
        result,
      });
    } catch (err) {
      res.status(500).json({ status: false, error: err.message });
    }
  };

  app.get("/download/spotify", handleSpotify);
  app.get("/download/spotifyplay", handleSpotify);
  app.get("/download/spotify-play", handleSpotify);
};
