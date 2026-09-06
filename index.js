const express = require("express");
const chalk = require("chalk");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 4000;

// ========== DISCORD WEBHOOK ==========
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://discord.com/api/webhooks/1433251978791878669/DZ5HKcB9VMtMWgvBjszczCaEQ8jCpOS_qskHuh5uBtYiH7NyMqgqPvC_4-HmxFU53lQ9";

async function sendWebhook(content, embeds = null) {
    if (!WEBHOOK_URL) return;

    try {
        if (typeof fetch === "function") {
            await fetch(WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(
                    embeds
                        ? { content: content || null, embeds }
                        : { content }
                )
            });
        }
    } catch (err) {
        console.error(chalk.red(`[WebhookError] ${err.message}`));
    }
}

// ========== KIRIM NOTIF ==========
async function sendNotification(msg) {
    sendWebhook(msg);
}

// ========== KIRIM LOG API ==========
async function sendLog({ ip, method, endpoint, status, query, duration }) {
    const icons = { request: "🟡", success: "✅", error: "❌" };
    const colors = { request: 0x7289da, success: 0x57f287, error: 0xed4245 };

    const embed = [
        {
            title: `${icons[status]} API Activity - ${status.toUpperCase()}`,
            color: colors[status],
            fields: [
                { name: "IP", value: `\`${ip}\``, inline: true },
                { name: "Method", value: method, inline: true },
                { name: "Endpoint", value: endpoint },
                {
                    name: "Query",
                    value: `\`\`\`json\n${JSON.stringify(query || {}, null, 2)}\n\`\`\``
                },
                { name: "Duration", value: `${duration ?? "-"}ms`, inline: true },
                { name: "Time", value: new Date().toISOString() }
            ],
            footer: { text: "Daps API's Log System ✨" },
            timestamp: new Date()
        }
    ];

    sendWebhook(null, embed);
}

// ========== EXPRESS ==========
app.enable("trust proxy");
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.set("json spaces", 2);

// ========== STATIC FILES ==========
app.use(express.static(path.join(__dirname, "api-page")));
app.use("/src", express.static(path.join(__dirname, "src")));

// ========== LOAD OPENAPI ==========
const openApiPath = path.join(__dirname, "src", "openapi.json");
let openApi = {};

try {
    openApi = require("./src/openapi.json");
} catch {
    try {
        if (fs.existsSync(openApiPath)) {
            openApi = JSON.parse(fs.readFileSync(openApiPath, "utf8"));
        }
    } catch {
        console.warn(chalk.yellow("⚠️ openapi.json not found or invalid."));
    }
}

// ========== /openapi.json route ==========
app.get(["/openapi.json", "/src/openapi.json"], (req, res) => {
    if (openApi && Object.keys(openApi).length > 0) {
        return res.json(openApi);
    }
    if (fs.existsSync(openApiPath)) {
        return res.sendFile(openApiPath);
    }
    return res.status(404).json({ status: false, message: "openapi.json tidak ditemukan" });
});

// ========== /notifications.json route ==========
let notificationsData = [];
try {
    notificationsData = require("./src/notifications.json");
} catch {
    try {
        const notifPath = path.join(__dirname, "src", "notifications.json");
        if (fs.existsSync(notifPath)) {
            notificationsData = JSON.parse(fs.readFileSync(notifPath, "utf8"));
        }
    } catch {}
}

app.get(["/notifications.json", "/src/notifications.json"], (req, res) => {
    const p1 = path.join(__dirname, "api-page", "notifications.json");
    const p2 = path.join(__dirname, "src", "notifications.json");
    if (fs.existsSync(p1)) return res.sendFile(p1);
    if (fs.existsSync(p2)) return res.sendFile(p2);
    return res.json(notificationsData);
});

// ========== Helper match path OpenAPI ==========
function matchOpenApiPath(requestPath) {
    const paths = Object.keys(openApi.paths || {});
    for (const apiPath of paths) {
        const regex = new RegExp("^" + apiPath.replace(/{[^}]+}/g, "[^/]+") + "$");
        if (regex.test(requestPath)) return true;
    }
    return false;
}

// ========== JSON RESPONSE WRAPPER ==========
app.use((req, res, next) => {
    const original = res.json;
    res.json = function (data) {
        if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            data = {
                status: data.status ?? true,
                creator: openApi.info?.author || "Daps",
                ...data
            };
        }
        return original.call(this, data);
    };
    next();
});

// ========== ENDPOINT LOGGER ==========
const endpointStats = {};

app.use(async (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const method = req.method;
    const endpoint = req.originalUrl.split("?")[0];
    const query = req.query;
    const start = Date.now();

    try {
        // REQUEST LOG
        if (matchOpenApiPath(endpoint)) {
            sendLog({ ip, method, endpoint, status: "request", query });
            console.log(chalk.yellow(`🟡 [REQUEST] ${method} ${endpoint} | IP: ${ip}`));
        }

        next();

        res.on("finish", () => {
            if (!matchOpenApiPath(endpoint)) return;

            const duration = Date.now() - start;
            const isError = res.statusCode >= 400;
            const status = isError ? "error" : "success";

            if (!endpointStats[endpoint]) endpointStats[endpoint] = { total: 0, errors: 0, totalDuration: 0 };
            endpointStats[endpoint].total++;
            endpointStats[endpoint].totalDuration += duration;
            if (isError) endpointStats[endpoint].errors++;

            const avg = (endpointStats[endpoint].totalDuration / endpointStats[endpoint].total).toFixed(2);

            sendLog({ ip, method, endpoint, status, query, duration });

            console.log(
                chalk[isError ? "red" : "green"](
                    `${isError ? "❌" : "✅"} [${status.toUpperCase()}] ${method} ${endpoint} | ${res.statusCode} | ${duration}ms (Avg: ${avg}ms)`
                )
            );
        });
    } catch (err) {
        console.error(chalk.red(`❌ Middleware Error: ${err.message}`));
        res.status(500).json({ status: false, message: "Internal middleware error" });
    }
});

// ========== LOAD API ROUTES ==========
let totalRoutes = 0;
const apiFolder = path.join(__dirname, "src", "api");
const loadedRoutes = new Set();

if (fs.existsSync(apiFolder)) {
    try {
        fs.readdirSync(apiFolder).forEach((sub) => {
            const subPath = path.join(apiFolder, sub);
            if (fs.statSync(subPath).isDirectory()) {
                fs.readdirSync(subPath).forEach((file) => {
                    if (file.endsWith(".js")) {
                        try {
                            const fullPath = path.join(subPath, file);
                            const route = require(fullPath);
                            if (typeof route === "function") {
                                route(app);
                                loadedRoutes.add(file);
                                totalRoutes++;
                                console.log(chalk.bgYellow.black(`Loaded Route: ${file}`));
                                sendNotification(`✅ Loaded Route: ${file}`);
                            }
                        } catch (err) {
                            console.error(`Error loading route ${file}:`, err.message);
                        }
                    }
                });
            }
        });
    } catch (e) {
        console.warn("Dynamic route reading failed, fallback to static routes:", e.message);
    }
}

// Fallback static routes so Vercel / serverless bundlers include and register all routes
const staticRoutes = [
    { name: "spotify.js", fn: require("./src/api/download/spotify") },
    { name: "image-bluearchive.js", fn: require("./src/api/image/image-bluearchive") },
    { name: "detik.js", fn: require("./src/api/news/detik") },
    { name: "kontan.js", fn: require("./src/api/news/kontan") }
];

staticRoutes.forEach(({ name, fn }) => {
    if (!loadedRoutes.has(name) && typeof fn === "function") {
        try {
            fn(app);
            loadedRoutes.add(name);
            totalRoutes++;
            console.log(chalk.bgYellow.black(`Loaded Static Route: ${name}`));
        } catch (err) {
            console.error(`Error loading static route ${name}:`, err.message);
        }
    }
});

sendNotification(`🟢 Server started. Total Routes Loaded: ${totalRoutes}`);

// ========== MAIN ROUTES ==========
app.get("/", (req, res) => {
    const file = path.join(__dirname, "api-page", "index.html");
    if (fs.existsSync(file)) return res.sendFile(file);
    return res.json({ status: true, message: "Daps API is running" });
});

app.get("/docs", (req, res) => {
    const file = path.join(__dirname, "api-page", "docs.html");
    if (fs.existsSync(file)) return res.sendFile(file);
    return res.json({ status: true, message: "Docs page" });
});

app.use((req, res) => {
    const file = path.join(__dirname, "api-page", "404.html");
    if (fs.existsSync(file)) return res.status(404).sendFile(file);
    return res.status(404).json({ status: false, message: "Endpoint tidak ditemukan" });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    sendNotification(`🚨 Server Error: ${err.message}`);
    const file = path.join(__dirname, "api-page", "500.html");
    if (fs.existsSync(file)) return res.status(500).sendFile(file);
    return res.status(500).json({ status: false, message: "Internal Server Error", error: err.message });
});

// ========== START & EXPORT ==========
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(chalk.bgGreen.black(`Server running on port ${PORT}`));
    });
}

module.exports = app;
