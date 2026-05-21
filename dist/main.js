#!/usr/bin/env bun
import { PATHS, closeDb, configPath, countActiveAdminKeys, countActiveDebugKeys, createKey, ensurePaths, findKeyByHash, findKeyById, getDb, initDb, isDebugActive, listKeys, revokeKey, setDebugEnabled, tracesDir, updateKeyScope } from "./keys-BntVlM1P.js";
import { defineCommand, runMain } from "citty";
import consola, { consola as consola$1 } from "consola";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto$1, { randomUUID } from "node:crypto";
import fs$1 from "node:fs";
import { z } from "zod";
import clipboard from "clipboardy";
import { serve } from "srvx";
import invariant from "tiny-invariant";
import { getProxyForUrl } from "proxy-from-env";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { execSync, spawnSync } from "node:child_process";
import process$1 from "node:process";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Fragment, jsx, jsxs } from "hono/jsx/jsx-runtime";
import { streamSSE } from "hono/streaming";
import { events } from "fetch-event-stream";

//#region src/lib/state.ts
const state = {
	accountType: "individual",
	manualApprove: false,
	rateLimitWait: false,
	showToken: false
};

//#endregion
//#region src/services/version-cache.ts
const VERSION_CACHE_TTL_MS = 1440 * 60 * 1e3;

//#endregion
//#region src/services/get-copilot-chat-version.ts
/**
* Hard-coded fallback used when both the Marketplace API and the
* vscode-copilot-release GitHub releases are unreachable.
*
* Bump this periodically. Last bumped 2026-05-19 based on Marketplace
* extension query returning 0.48.1 for GitHub.copilot-chat.
*/
const FALLBACK = "0.48.1";
let cache$1;
async function fetchFromMarketplace() {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, 5e3);
	try {
		const parsed = (await (await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=3.0-preview.1"
			},
			body: JSON.stringify({
				filters: [{ criteria: [{
					filterType: 7,
					value: "GitHub.copilot-chat"
				}] }],
				flags: 529
			}),
			signal: controller.signal
		})).json())?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version;
		if (typeof parsed !== "string" || !parsed) throw new Error("Unexpected response shape");
		return parsed;
	} finally {
		clearTimeout(timeout);
	}
}
async function getCopilotChatVersion() {
	if (cache$1 && Date.now() - cache$1.fetchedAt < VERSION_CACHE_TTL_MS) return cache$1.version;
	let fetched = null;
	try {
		fetched = await fetchFromMarketplace();
	} catch {
		consola.warn("Failed to fetch Copilot Chat version from Marketplace, using fallback");
	}
	const isValid = fetched !== null && /^\d+\.\d+\.\d+$/.test(fetched);
	const version = isValid ? fetched : FALLBACK;
	if (isValid) cache$1 = {
		version,
		fetchedAt: Date.now()
	};
	else if (fetched !== null) {
		const safeVersion = fetched.slice(0, 40).replaceAll(/[^\x20-\x7E]/g, "?");
		consola.warn(`Invalid version format received: ${safeVersion}, using fallback`);
	}
	return version;
}

//#endregion
//#region src/services/get-vscode-version.ts
/**
* Hard-coded fallback used when both the official VSCode update API and the
* AUR PKGBUILD mirror are unreachable (offline / firewall / DNS issue).
*
* Bump this periodically — Copilot's upstream is lenient about
* `editor-version` header values but a wildly stale string could in theory
* trip future anti-abuse heuristics. Last bumped 2026-05-19 based on
* `update.code.visualstudio.com/api/releases/stable` returning 1.120.0.
*/
const FALLBACK$1 = "1.120.0";
let cache;
async function fetchFromOfficialApi() {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, 5e3);
	try {
		const versions = await (await fetch("https://update.code.visualstudio.com/api/releases/stable", { signal: controller.signal })).json();
		if (Array.isArray(versions) && versions.length > 0 && versions[0]) return versions[0];
		throw new Error("Unexpected response shape");
	} finally {
		clearTimeout(timeout);
	}
}
async function fetchFromAur() {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, 5e3);
	try {
		const match = (await (await fetch("https://aur.archlinux.org/cgit/aur.git/plain/PKGBUILD?h=visual-studio-code-bin", { signal: controller.signal })).text()).match(/pkgver=(\d+\.\d+\.\d+)/);
		if (match?.[1]) return match[1];
		throw new Error("Version not found in PKGBUILD");
	} finally {
		clearTimeout(timeout);
	}
}
async function getVSCodeVersion() {
	if (cache && Date.now() - cache.fetchedAt < VERSION_CACHE_TTL_MS) return cache.version;
	let fetched = null;
	try {
		fetched = await fetchFromOfficialApi();
	} catch {
		try {
			fetched = await fetchFromAur();
		} catch {
			consola.warn("Failed to fetch VS Code version from all sources, using fallback");
		}
	}
	const isValid = fetched !== null && /^\d+\.\d+\.\d+$/.test(fetched);
	const version = isValid ? fetched : FALLBACK$1;
	if (isValid) cache = {
		version,
		fetchedAt: Date.now()
	};
	else if (fetched !== null) {
		const safeVersion = fetched.slice(0, 40).replaceAll(/[^\x20-\x7E]/g, "?");
		consola.warn(`Invalid version format received: ${safeVersion}, using fallback`);
	}
	return version;
}

//#endregion
//#region src/lib/api-config.ts
const standardHeaders = () => ({
	"content-type": "application/json",
	accept: "application/json"
});
const API_VERSION = "2025-04-01";
const copilotBaseUrl = (state$1) => state$1.accountType === "individual" ? "https://api.githubcopilot.com" : `https://api.${state$1.accountType}.githubcopilot.com`;
/**
* Headers sent with every upstream request to mimic VS Code Copilot Chat traffic.
*
* Header sources:
*  - Authorization        — Copilot token from GitHub OAuth flow
*  - editor-version       — Auto-detected VS Code stable release (update.code.visualstudio.com)
*  - editor-plugin-version — Auto-detected GitHub.copilot-chat Marketplace version
*  - user-agent           — Same as editor-plugin-version, GitHubCopilotChat/<version>
*  - copilot-integration-id — Fixed "vscode-chat"
*  - openai-intent        — Fixed "conversation-panel"
*  - x-github-api-version — Fixed "2025-04-01" (verify periodically against VS Code source)
*  - x-request-id         — Per-request UUID via crypto.randomUUID()
*  - x-vscode-user-agent-library-version — Fixed "electron-fetch"
*  - copilot-vision-request — Added when request includes image content
*/
const copilotHeaders = (state$1, vision = false) => {
	const copilotVersion = state$1.copilotChatVersion ?? FALLBACK;
	const headers = {
		Authorization: `Bearer ${state$1.copilotToken}`,
		"content-type": standardHeaders()["content-type"],
		"copilot-integration-id": "vscode-chat",
		"editor-version": `vscode/${state$1.vsCodeVersion ?? FALLBACK$1}`,
		"editor-plugin-version": `copilot-chat/${copilotVersion}`,
		"user-agent": `GitHubCopilotChat/${copilotVersion}`,
		"openai-intent": "conversation-panel",
		"x-github-api-version": API_VERSION,
		"x-request-id": randomUUID(),
		"x-vscode-user-agent-library-version": "electron-fetch"
	};
	if (vision) headers["copilot-vision-request"] = "true";
	return headers;
};
const GITHUB_API_BASE_URL = "https://api.github.com";
const githubHeaders = (state$1) => {
	const copilotVersion = state$1.copilotChatVersion ?? FALLBACK;
	return {
		...standardHeaders(),
		authorization: `token ${state$1.githubToken}`,
		"editor-version": `vscode/${state$1.vsCodeVersion ?? FALLBACK$1}`,
		"editor-plugin-version": `copilot-chat/${copilotVersion}`,
		"user-agent": `GitHubCopilotChat/${copilotVersion}`,
		"x-github-api-version": API_VERSION,
		"x-vscode-user-agent-library-version": "electron-fetch"
	};
};
const GITHUB_BASE_URL = "https://github.com";
const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const GITHUB_APP_SCOPES = ["read:user"].join(" ");

//#endregion
//#region src/lib/error.ts
var HTTPError = class extends Error {
	response;
	constructor(message, response) {
		super(message);
		this.response = response;
	}
};
async function forwardError(c, error) {
	consola.error("Error occurred:", error);
	if (error instanceof HTTPError) {
		const errorText = await error.response.text();
		let errorJson;
		try {
			errorJson = JSON.parse(errorText);
		} catch {
			errorJson = errorText;
		}
		consola.error("HTTP error:", errorJson);
		return c.json({ error: {
			message: errorText,
			type: "error"
		} }, error.response.status);
	}
	return c.json({ error: {
		message: error.message,
		type: "error"
	} }, 500);
}

//#endregion
//#region src/services/github/get-copilot-token.ts
const getCopilotToken = async () => {
	const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/v2/token`, { headers: githubHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get Copilot token", response);
	return await response.json();
};

//#endregion
//#region src/services/github/get-device-code.ts
async function getDeviceCode() {
	const response = await fetch(`${GITHUB_BASE_URL}/login/device/code`, {
		method: "POST",
		headers: standardHeaders(),
		body: JSON.stringify({
			client_id: GITHUB_CLIENT_ID,
			scope: GITHUB_APP_SCOPES
		})
	});
	if (!response.ok) throw new HTTPError("Failed to get device code", response);
	return await response.json();
}

//#endregion
//#region src/services/github/get-user.ts
async function getGitHubUser() {
	const response = await fetch(`${GITHUB_API_BASE_URL}/user`, { headers: {
		authorization: `token ${state.githubToken}`,
		...standardHeaders()
	} });
	if (!response.ok) throw new HTTPError("Failed to get GitHub user", response);
	return await response.json();
}

//#endregion
//#region src/services/copilot/get-models.ts
const getModels = async () => {
	const response = await fetch(`${copilotBaseUrl(state)}/models`, { headers: copilotHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get models", response);
	return await response.json();
};

//#endregion
//#region src/lib/utils.ts
const sleep = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
const isNullish = (value) => value === null || value === void 0;
async function cacheModels() {
	state.models = await getModels();
}

//#endregion
//#region src/services/github/poll-access-token.ts
async function pollAccessToken(deviceCode) {
	const sleepDuration = (deviceCode.interval + 1) * 1e3;
	consola.debug(`Polling access token with interval of ${sleepDuration}ms`);
	while (true) {
		const response = await fetch(`${GITHUB_BASE_URL}/login/oauth/access_token`, {
			method: "POST",
			headers: standardHeaders(),
			body: JSON.stringify({
				client_id: GITHUB_CLIENT_ID,
				device_code: deviceCode.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code"
			})
		});
		if (!response.ok) {
			await sleep(sleepDuration);
			consola.error("Failed to poll access token:", await response.text());
			continue;
		}
		const json = await response.json();
		consola.debug("Polling access token response:", json);
		const { access_token } = json;
		if (access_token) return access_token;
		else await sleep(sleepDuration);
	}
}

//#endregion
//#region src/lib/token.ts
const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8");
const writeGithubToken = (token) => fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token);
/**
* Handle for the Copilot-token refresh timer. Stored module-level so the
* shutdown hook in start.ts can stop it cleanly, AND so a re-entry into
* setupCopilotToken (e.g. from tests) doesn't leak a previous interval.
*/
let copilotTokenRefreshTimer;
/** Cancel handle for stopCopilotTokenRefresh(). */
function stopCopilotTokenRefresh() {
	if (copilotTokenRefreshTimer !== void 0) {
		clearInterval(copilotTokenRefreshTimer);
		copilotTokenRefreshTimer = void 0;
	}
}
const setupCopilotToken = async () => {
	const { token, refresh_in } = await getCopilotToken();
	state.copilotToken = token;
	consola.debug("GitHub Copilot Token fetched successfully!");
	if (state.showToken) consola.info("Copilot token:", token);
	stopCopilotTokenRefresh();
	const refreshInterval = (refresh_in - 60) * 1e3;
	copilotTokenRefreshTimer = setInterval(() => {
		consola.debug("Refreshing Copilot token");
		(async () => {
			try {
				const { token: refreshed } = await getCopilotToken();
				state.copilotToken = refreshed;
				consola.debug("Copilot token refreshed");
				if (state.showToken) consola.info("Refreshed Copilot token:", refreshed);
			} catch (error) {
				consola.error("Failed to refresh Copilot token (continuing with existing token until next attempt):", error);
			}
		})();
	}, refreshInterval);
};
async function setupGitHubToken(options) {
	try {
		const githubToken = await readGithubToken();
		if (githubToken && !options?.force) {
			state.githubToken = githubToken;
			if (state.showToken) consola.info("GitHub token:", githubToken);
			await logUser();
			return;
		}
		consola.info("Not logged in, getting new access token");
		const response = await getDeviceCode();
		consola.debug("Device code response:", response);
		consola.info(`Please enter the code "${response.user_code}" in ${response.verification_uri}`);
		const token = await pollAccessToken(response);
		await writeGithubToken(token);
		state.githubToken = token;
		if (state.showToken) consola.info("GitHub token:", token);
		await logUser();
	} catch (error) {
		if (error instanceof HTTPError) {
			consola.error("Failed to get GitHub token:", await error.response.json());
			throw error;
		}
		consola.error("Failed to get GitHub token:", error);
		throw error;
	}
}
async function logUser() {
	const user = await getGitHubUser();
	consola.info(`Logged in as ${user.login}`);
}

//#endregion
//#region src/auth.ts
async function runAuth(options) {
	if (options.verbose) {
		consola.level = 5;
		consola.info("Verbose logging enabled");
	}
	state.showToken = options.showToken;
	await ensurePaths();
	await setupGitHubToken({ force: true });
	consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH);
}
const auth = defineCommand({
	meta: {
		name: "auth",
		description: "Run GitHub auth flow without running the server"
	},
	args: {
		verbose: {
			alias: "v",
			type: "boolean",
			default: false,
			description: "Enable verbose logging"
		},
		"show-token": {
			type: "boolean",
			default: false,
			description: "Show GitHub token on auth"
		}
	},
	run({ args }) {
		return runAuth({
			verbose: args.verbose,
			showToken: args["show-token"]
		});
	}
});

//#endregion
//#region src/services/github/get-copilot-usage.ts
const getCopilotUsage = async () => {
	const response = await fetch(`${GITHUB_API_BASE_URL}/copilot_internal/user`, { headers: githubHeaders(state) });
	if (!response.ok) throw new HTTPError("Failed to get Copilot usage", response);
	return await response.json();
};

//#endregion
//#region src/check-usage.ts
const checkUsage = defineCommand({
	meta: {
		name: "check-usage",
		description: "Show current GitHub Copilot usage/quota information"
	},
	async run() {
		await ensurePaths();
		await setupGitHubToken();
		try {
			const usage = await getCopilotUsage();
			const premium = usage.quota_snapshots.premium_interactions;
			const premiumTotal = premium.entitlement;
			const premiumUsed = premiumTotal - premium.remaining;
			const premiumPercentUsed = premiumTotal > 0 ? premiumUsed / premiumTotal * 100 : 0;
			const premiumPercentRemaining = premium.percent_remaining;
			function summarizeQuota(name, snap) {
				if (!snap) return `${name}: N/A`;
				const total = snap.entitlement;
				const used = total - snap.remaining;
				const percentUsed = total > 0 ? used / total * 100 : 0;
				const percentRemaining = snap.percent_remaining;
				return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`;
			}
			const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`;
			const chatLine = summarizeQuota("Chat", usage.quota_snapshots.chat);
			const completionsLine = summarizeQuota("Completions", usage.quota_snapshots.completions);
			consola.box(`Copilot Usage (plan: ${usage.copilot_plan})\nQuota resets: ${usage.quota_reset_date}\n\nQuotas:\n  ${premiumLine}\n  ${chatLine}\n  ${completionsLine}`);
		} catch (err) {
			consola.error("Failed to fetch Copilot usage:", err);
			process.exit(1);
		}
	}
});

//#endregion
//#region src/lib/config-store.ts
const ModelEntrySchema = z.object({
	upstream: z.string().regex(/^\w[\w.:-]*$/, "upstream must be a model ID (e.g. 'gpt-4o'), not a URL"),
	enabled: z.boolean().default(true),
	allowed_keys: z.array(z.string()).default(["*"]),
	default_effort: z.enum([
		"low",
		"medium",
		"high",
		"xhigh",
		""
	]).default("")
});
const RetentionSchema = z.object({
	events_days: z.number().int().min(0).default(90),
	traces_days: z.number().int().min(0).default(0),
	traces_max_bytes: z.number().int().min(0).default(104857600),
	audit_days: z.number().int().min(0).default(365)
});
const FeaturesSchema = z.object({
	auth: z.boolean().default(true),
	telemetry: z.boolean().default(false),
	debug: z.boolean().default(false)
});
const ConfigSchema = z.object({
	version: z.literal(1),
	models: z.preprocess((v) => v ?? {}, z.record(z.string(), ModelEntrySchema)),
	retention: z.preprocess((v) => v ?? {}, RetentionSchema),
	features: z.preprocess((v) => v ?? {}, FeaturesSchema),
	default_model_alias: z.string().default("")
}).superRefine((cfg, ctx) => {
	if (cfg.default_model_alias && !Object.hasOwn(cfg.models, cfg.default_model_alias)) ctx.addIssue({
		code: "custom",
		path: ["default_model_alias"],
		message: `default_model_alias "${cfg.default_model_alias}" is not defined in models. Add the alias to models first, or clear this field.`
	});
});
const DEFAULT_CONFIG = ConfigSchema.parse({ version: 1 });
let _currentConfig = DEFAULT_CONFIG;
function fsyncPath(targetPath) {
	if (os.platform() === "win32") return;
	const fd = fs$1.openSync(targetPath, "r");
	try {
		fs$1.fsyncSync(fd);
	} finally {
		fs$1.closeSync(fd);
	}
}
function saveConfig(config, filePath = configPath()) {
	const parsed = ConfigSchema.parse(config);
	const json = JSON.stringify(parsed, null, 2);
	const tmpPath = `${filePath}.${process.pid}.${crypto$1.randomBytes(4).toString("hex")}.tmp`;
	const dir = path.dirname(filePath);
	fs$1.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const fd = fs$1.openSync(tmpPath, "w", 384);
	try {
		fs$1.writeSync(fd, json);
		fs$1.fsyncSync(fd);
	} finally {
		fs$1.closeSync(fd);
	}
	fs$1.chmodSync(tmpPath, 384);
	fs$1.renameSync(tmpPath, filePath);
	fsyncPath(dir);
	_currentConfig = parsed;
}
async function loadConfig(filePath = configPath()) {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	let raw;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		consola$1.info(`config.json not found, writing defaults to ${filePath}`);
		saveConfig(DEFAULT_CONFIG, filePath);
		_currentConfig = DEFAULT_CONFIG;
		return DEFAULT_CONFIG;
	}
	try {
		const mode = fs$1.statSync(filePath).mode & 511;
		if (mode !== 384) consola$1.warn(`config.json has mode 0${mode.toString(8)}, expected 0600. Consider running: chmod 600 ${filePath}`);
	} catch {}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`config.json is not valid JSON: ${String(err)}`);
	}
	const result = ConfigSchema.safeParse(parsed);
	if (!result.success) throw new Error(`config.json schema validation failed: ${result.error.message}`);
	_currentConfig = result.data;
	return result.data;
}
let _overrides = {};
/** Set a runtime override that wins over the persisted config until cleared. */
function setRuntimeAuthOverride(value) {
	if (value === void 0) delete _overrides.authEnabled;
	else _overrides.authEnabled = value;
}
function applyOverrides(cfg) {
	if (_overrides.authEnabled === void 0) return cfg;
	return {
		...cfg,
		features: {
			...cfg.features,
			auth: _overrides.authEnabled
		}
	};
}
function deepFreeze(obj) {
	if (obj === null || typeof obj !== "object") return obj;
	Object.freeze(obj);
	for (const key of Object.keys(obj)) deepFreeze(obj[key]);
	return obj;
}
function getConfig() {
	return deepFreeze(applyOverrides(structuredClone(_currentConfig)));
}
function watchConfig(onChange, filePath = configPath()) {
	const dir = path.dirname(filePath);
	const filename = path.basename(filePath);
	let debounceTimer = null;
	const watcher = fs$1.watch(dir, (_eventType, changedFile) => {
		if (!changedFile || changedFile !== filename) return;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			(async () => {
				let raw;
				try {
					raw = await Bun.file(filePath).text();
				} catch (err) {
					consola$1.warn(`config.json reload failed (file unreadable), keeping previous config: ${String(err)}`);
					return;
				}
				let parsed;
				try {
					parsed = JSON.parse(raw);
				} catch (err) {
					consola$1.warn(`config.json reload failed (invalid JSON), keeping previous config: ${String(err)}`);
					return;
				}
				const result = ConfigSchema.safeParse(parsed);
				if (!result.success) {
					consola$1.warn(`config.json reload failed schema validation, keeping previous config: ${result.error.message}`);
					return;
				}
				_currentConfig = result.data;
				onChange(deepFreeze(applyOverrides(structuredClone(result.data))));
			})().catch((err) => {
				consola$1.error(`config.json reload: unexpected error in onChange callback: ${String(err)}`);
			});
		}, 250);
	});
	return () => {
		if (debounceTimer) clearTimeout(debounceTimer);
		watcher.close();
	};
}
async function initConfig(onChange, filePath = configPath()) {
	await loadConfig(filePath);
	return watchConfig(onChange ?? (() => {}), filePath);
}

//#endregion
//#region src/services/audit.ts
/** Returns the audit JSONL file path for a given date string (YYYY-MM-DD). */
function auditFilePath(dateStr) {
	return path.join(PATHS.APP_DIR, `audit-${dateStr}.jsonl`);
}
/** Returns today's date string in YYYY-MM-DD format (local time). */
function todayDateStr$1() {
	const d = /* @__PURE__ */ new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}
/**
* Append a single AuditEvent as a JSONL line.
* Opens the file with O_APPEND | O_CREAT, mode 0600 — atomically appends on
* POSIX systems (write(2) on O_APPEND is atomic for writes ≤ PIPE_BUF).
* Creates parent directory (0700) if needed.
*/
function appendAudit(event) {
	const filePath = auditFilePath(todayDateStr$1());
	const dir = path.dirname(filePath);
	fs$1.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const line = JSON.stringify(event) + os.EOL;
	const fd = fs$1.openSync(filePath, fs$1.constants.O_WRONLY | fs$1.constants.O_CREAT | fs$1.constants.O_APPEND, 384);
	try {
		fs$1.writeSync(fd, line);
	} finally {
		fs$1.closeSync(fd);
	}
}
/** Append an audit event, automatically setting ts = Date.now(). */
function audit(event) {
	appendAudit({
		ts: Date.now(),
		...event
	});
}
/**
* Delete audit JSONL files older than retention.audit_days.
* Files matching the pattern audit-YYYY-MM-DD.jsonl in APP_DIR are examined;
* any whose date is strictly older than (today − audit_days) are removed.
* Files that do not match the pattern are left untouched.
*/
function initAudit() {
	const retentionDays = getConfig().retention.audit_days;
	if (retentionDays === 0) return;
	const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1e3;
	const dir = PATHS.APP_DIR;
	let entries;
	try {
		entries = fs$1.readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
		if (!match) continue;
		const dateStr = match[1];
		if ((/* @__PURE__ */ new Date(`${dateStr}T00:00:00`)).getTime() < cutoffMs) try {
			fs$1.unlinkSync(path.join(dir, entry));
		} catch {}
	}
}

//#endregion
//#region src/lib/bootstrap.ts
const ADMIN_KEY_FILE = path.join(PATHS.APP_DIR, "admin.key.txt");
/**
* Returns true if the admin bootstrap file exists (operator hasn't read it yet).
*/
function bootstrapFilePending() {
	return fs$1.existsSync(ADMIN_KEY_FILE);
}
/**
* Run bootstrap: if auth is enabled and no admin keys exist, generate one.
* Called during startup AFTER initDb() and BEFORE HTTP listener binds.
*
* Logic:
* 1. If auth is disabled → no-op.
* 2. If admin keys already exist in DB → warn if file still present, return.
* 3. Otherwise → create first admin key and write to ADMIN_KEY_FILE.
*/
function runBootstrap() {
	const { features } = getConfig();
	if (!features.auth) return;
	if (countActiveAdminKeys() > 0) {
		if (bootstrapFilePending()) consola.warn(`Admin key file still present at ${ADMIN_KEY_FILE}. Delete it after reading:\n  rm ${ADMIN_KEY_FILE}`);
		return;
	}
	fs$1.mkdirSync(PATHS.APP_DIR, {
		recursive: true,
		mode: 448
	});
	const { plain } = createKey({
		tier: "admin",
		label: "bootstrap-admin"
	});
	try {
		fs$1.writeFileSync(ADMIN_KEY_FILE, plain + "\n", {
			mode: 384,
			flag: "wx"
		});
	} catch (err) {
		if (err.code === "EEXIST") {
			consola.warn(`Bootstrap key file already exists at ${ADMIN_KEY_FILE} (parallel start?). Using existing file.`);
			return;
		}
		consola.error(`Admin key created in DB but file write failed. Run 'copilot-api admin recover' to retrieve it. Error: ${String(err)}`);
		throw err;
	}
	audit({
		actor_key_id: "__system__",
		actor_tier: "system",
		action: "auth.bootstrap",
		after: { label: "bootstrap-admin" }
	});
	if (process.stdout.isTTY) {
		consola.success(`Admin key generated: ${plain}`);
		consola.info(`Also written to ${ADMIN_KEY_FILE} (delete after reading)`);
	} else consola.info(`Admin key written to ${ADMIN_KEY_FILE}. Read it and delete the file before restarting.`);
}

//#endregion
//#region src/cli/admin-recover.ts
const ADMIN_KEY_FILE_RECOVER = path.join(PATHS.APP_DIR, "admin.key.txt");
const adminRecover = defineCommand({
	meta: {
		name: "recover",
		description: "Mint a new admin key (requires local data-dir access as proof of operator identity)"
	},
	args: { force: {
		type: "boolean",
		description: "Create a new admin key even if active admin keys exist",
		default: false
	} },
	run({ args }) {
		try {
			fs$1.statSync(PATHS.APP_DIR);
		} catch {
			consola.error(`Cannot access data directory ${PATHS.APP_DIR}. Are you running as the correct user?`);
			process.exit(1);
		}
		initDb();
		const existing = countActiveAdminKeys();
		if (existing > 0 && !args.force) {
			consola.warn(`${existing} active admin key(s) already exist. Pass --force to create a new one anyway.`);
			process.exit(1);
		}
		if (fs$1.existsSync(ADMIN_KEY_FILE_RECOVER)) {
			consola.error(`${ADMIN_KEY_FILE_RECOVER} already exists. Read and delete it first:\n  cat ${ADMIN_KEY_FILE_RECOVER} && rm ${ADMIN_KEY_FILE_RECOVER}`);
			process.exit(1);
		}
		const { plain } = createKey({
			tier: "admin",
			label: "recovery-admin"
		});
		try {
			fs$1.writeFileSync(ADMIN_KEY_FILE_RECOVER, plain + "\n", {
				mode: 384,
				flag: "wx"
			});
		} catch (err) {
			consola.error(`Failed to write recovery key file: ${String(err)}`);
			process.exit(1);
		}
		if (process.stdout.isTTY) consola.success(`Recovery admin key generated: ${plain}`);
		else consola.info(`Recovery admin key written to ${ADMIN_KEY_FILE_RECOVER}. Read and delete the file.`);
		consola.info(`Also written to ${ADMIN_KEY_FILE_RECOVER}`);
	}
});

//#endregion
//#region src/debug.ts
async function getPackageVersion() {
	try {
		const packageJsonPath = new URL("../package.json", import.meta.url).pathname;
		return JSON.parse(await fs.readFile(packageJsonPath)).version;
	} catch {
		return "unknown";
	}
}
function getRuntimeInfo() {
	const isBun = typeof Bun !== "undefined";
	return {
		name: isBun ? "bun" : "node",
		version: isBun ? Bun.version : process.version.slice(1),
		platform: os.platform(),
		arch: os.arch()
	};
}
async function checkTokenExists() {
	try {
		if (!(await fs.stat(PATHS.GITHUB_TOKEN_PATH)).isFile()) return false;
		return (await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")).trim().length > 0;
	} catch {
		return false;
	}
}
async function getDebugInfo() {
	const [version, tokenExists] = await Promise.all([getPackageVersion(), checkTokenExists()]);
	return {
		version,
		runtime: getRuntimeInfo(),
		paths: {
			APP_DIR: PATHS.APP_DIR,
			GITHUB_TOKEN_PATH: PATHS.GITHUB_TOKEN_PATH
		},
		tokenExists
	};
}
function printDebugInfoPlain(info) {
	consola.info(`copilot-api debug

Version: ${info.version}
Runtime: ${info.runtime.name} ${info.runtime.version} (${info.runtime.platform} ${info.runtime.arch})

Paths:
- APP_DIR: ${info.paths.APP_DIR}
- GITHUB_TOKEN_PATH: ${info.paths.GITHUB_TOKEN_PATH}

Token exists: ${info.tokenExists ? "Yes" : "No"}`);
}
function printDebugInfoJson(info) {
	console.log(JSON.stringify(info, null, 2));
}
async function runDebug(options) {
	const debugInfo = await getDebugInfo();
	if (options.json) printDebugInfoJson(debugInfo);
	else printDebugInfoPlain(debugInfo);
}
const debug = defineCommand({
	meta: {
		name: "debug",
		description: "Print debug information about the application"
	},
	args: { json: {
		type: "boolean",
		default: false,
		description: "Output debug information as JSON"
	} },
	run({ args }) {
		return runDebug({ json: args.json });
	}
});

//#endregion
//#region src/admin/csrf.ts
const CSRF_SECRET = crypto$1.randomBytes(32);
function generateCsrfToken(sessionId) {
	return crypto$1.createHmac("sha256", CSRF_SECRET).update(sessionId).digest("base64url");
}
function verifyCsrfToken(sessionId, token) {
	const expected = generateCsrfToken(sessionId);
	if (expected.length !== token.length) return false;
	return crypto$1.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "x-csrf-token";
/** Build Set-Cookie value for the CSRF token cookie */
function csrfCookieValue(token) {
	const secure = process.env.ADMIN_INSECURE_HTTP === "true" ? "" : "; Secure";
	return `${CSRF_COOKIE}=${token}; SameSite=Strict${secure}; Path=/admin`;
}
/** Extract CSRF token from cookie string */
function extractCsrfCookie(cookieHeader) {
	if (!cookieHeader) return void 0;
	for (const part of cookieHeader.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name.trim() === CSRF_COOKIE) return rest.join("=").trim();
	}
}

//#endregion
//#region src/admin/session.ts
/** Session lifetime: 8 hours in milliseconds */
const SESSION_LIFETIME_MS = 480 * 60 * 1e3;
const SESSION_COOKIE = "sid";
function newSessionId() {
	return crypto$1.randomBytes(32).toString("hex");
}
/** Create a new session for the given key and return the session row. */
function createSession(keyId) {
	const db = getDb();
	const id = newSessionId();
	const now = Date.now();
	const expiresAt = now + SESSION_LIFETIME_MS;
	const csrfToken = generateCsrfToken(id);
	db.run(`INSERT INTO sessions (id, key_id, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`, [
		id,
		keyId,
		csrfToken,
		now,
		expiresAt
	]);
	return {
		id,
		key_id: keyId,
		csrf_token: csrfToken,
		created_at: now,
		expires_at: expiresAt
	};
}
/** Look up an active session by id, sliding its expiry. Returns null if not found or expired. */
function getSession(sessionId) {
	const db = getDb();
	const now = Date.now();
	const row = db.query(`SELECT id, key_id, csrf_token, created_at, expires_at
       FROM sessions WHERE id = ? AND expires_at > ?`).get(sessionId, now);
	if (!row) return null;
	const newExpiry = now + SESSION_LIFETIME_MS;
	db.run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, [newExpiry, sessionId]);
	return {
		...row,
		expires_at: newExpiry
	};
}
/** Destroy a session (logout). */
function deleteSession(sessionId) {
	getDb().run(`DELETE FROM sessions WHERE id = ?`, [sessionId]);
}
/** Sweep expired sessions (called on startup / periodically). */
function purgeExpiredSessions() {
	getDb().run(`DELETE FROM sessions WHERE expires_at <= ?`, [Date.now()]);
}
/**
* Whether session cookies should be flagged `Secure` (HTTPS-only). Defaults
* to true. When ADMIN_INSECURE_HTTP=true is set, the operator has opted into
* plain-HTTP admin access on LAN, and `Secure` must be dropped — browsers
* silently discard Secure cookies received over HTTP, which would manifest
* as a "login loop" (server sets cookies, browser drops them, next request
* has no session → redirect back to login).
*/
function cookieSecureFlag() {
	return process.env.ADMIN_INSECURE_HTTP === "true" ? "" : "; Secure";
}
/** Build the Set-Cookie header value for the session cookie. */
function sessionCookieValue(sessionId) {
	return `${SESSION_COOKIE}=${sessionId}; HttpOnly${cookieSecureFlag()}; SameSite=Strict; Path=/admin; Max-Age=${SESSION_LIFETIME_MS / 1e3}`;
}
/** Build a Set-Cookie value that clears the session cookie. */
function clearSessionCookieValue() {
	return `${SESSION_COOKIE}=; HttpOnly${cookieSecureFlag()}; SameSite=Strict; Path=/admin; Max-Age=0`;
}
/** Extract the session id from the Cookie header. */
function extractSessionId(cookieHeader) {
	if (!cookieHeader) return void 0;
	for (const part of cookieHeader.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name.trim() === SESSION_COOKIE) return rest.join("=").trim();
	}
}

//#endregion
//#region src/lib/auth-mode.ts
const IPV4_LOOPBACK_RE = /^127(?:\.\d{1,3}){3}$/;
const LOOPBACK_LITERALS = new Set([
	"::1",
	"[::1]",
	"localhost"
]);
const IPV6_LOOPBACK_LONG = new Set([
	"0:0:0:0:0:0:0:1",
	"0000:0000:0000:0000:0000:0000:0000:0001",
	"::ffff:127.0.0.1"
]);
function isLoopbackHost(host) {
	const trimmed = host.trim().toLowerCase();
	if (LOOPBACK_LITERALS.has(trimmed)) return true;
	const bare = trimmed.replaceAll(/^\[|\]$/g, "");
	if (bare === "::1") return true;
	if (IPV6_LOOPBACK_LONG.has(bare)) return true;
	if (IPV4_LOOPBACK_RE.test(bare)) return bare.split(".").every((octet) => {
		const n = Number.parseInt(octet, 10);
		return n >= 0 && n <= 255;
	});
	return false;
}
function formatBindAddress(host, port) {
	if (host.includes(":") && !host.startsWith("[")) return `[${host}]:${port}`;
	return `${host}:${port}`;
}
/**
* Decide the runtime auth mode, or throw if the combination is unsafe.
*
* Throws a descriptive Error (NOT process.exit) so callers can format it for
* tests as well as the CLI. The CLI catches and prints a red message.
*/
function resolveAuthMode(options) {
	const bindAddress = formatBindAddress(options.host, options.port);
	const configAuth = options.configAuth ?? true;
	if (!(options.noAuth || !configAuth)) return {
		authEnabled: true,
		label: "on",
		bindAddress
	};
	if (isLoopbackHost(options.host)) return {
		authEnabled: false,
		label: "off (loopback)",
		bindAddress
	};
	if (!options.acceptRisk) {
		const source = options.noAuth ? "--no-auth on a non-loopback host" : "features.auth=false (config.json) with a non-loopback bind";
		throw new Error(`REFUSING TO START: ${source} (${bindAddress}) is unsafe.\n\nAnyone who can reach this port will burn your GitHub Copilot quota
and may trigger GitHub abuse-detection (account suspension).

Either:
  1. Bind to loopback only:   --host 127.0.0.1
  2. Enable auth (recommended): drop --no-auth (and set features.auth=true)
  3. Explicitly accept the risk:
       --no-auth --i-accept-account-suspension-risk

See README → Admin Plane / Authentication.`);
	}
	return {
		authEnabled: false,
		label: "off (acknowledged risk)",
		bindAddress
	};
}
function logAuthModeBanner(result) {
	if (result.label === "on") {
		consola.info(`[auth] mode=on  bind=${result.bindAddress}`);
		return;
	}
	if (result.label === "off (loopback)") {
		consola.warn(`\x1B[33m[auth] mode=${result.label}  bind=${result.bindAddress}\n       Authentication is DISABLED. Only loopback is allowed in this mode.[0m`);
		return;
	}
	consola.warn(`\x1B[31m[auth] mode=${result.label}  bind=${result.bindAddress}\n       Authentication is DISABLED on a non-loopback bind. The operator has
       acknowledged the GitHub abuse-detection / Copilot-quota risk.[0m`);
}

//#endregion
//#region src/lib/proxy.ts
function initProxyFromEnv() {
	if (typeof Bun !== "undefined") return;
	try {
		const direct = new Agent();
		const proxies = /* @__PURE__ */ new Map();
		setGlobalDispatcher({
			dispatch(options, handler) {
				try {
					const origin = typeof options.origin === "string" ? new URL(options.origin) : options.origin;
					const raw = getProxyForUrl(origin.toString());
					const proxyUrl = raw && raw.length > 0 ? raw : void 0;
					if (!proxyUrl) {
						consola.debug(`HTTP proxy bypass: ${origin.hostname}`);
						return direct.dispatch(options, handler);
					}
					let agent = proxies.get(proxyUrl);
					if (!agent) {
						agent = new ProxyAgent(proxyUrl);
						proxies.set(proxyUrl, agent);
					}
					let label = proxyUrl;
					try {
						const u = new URL(proxyUrl);
						label = `${u.protocol}//${u.host}`;
					} catch {}
					consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`);
					return agent.dispatch(options, handler);
				} catch {
					return direct.dispatch(options, handler);
				}
			},
			close() {
				return direct.close();
			},
			destroy() {
				return direct.destroy();
			}
		});
		consola.debug("HTTP proxy configured from environment (per-URL)");
	} catch (err) {
		consola.debug("Proxy setup skipped:", err);
	}
}

//#endregion
//#region src/lib/shell.ts
function getShell() {
	const { platform, ppid, env } = process$1;
	if (platform === "win32") {
		try {
			const command = `wmic process get ParentProcessId,Name | findstr "${ppid}"`;
			if (execSync(command, { stdio: "pipe" }).toString().toLowerCase().includes("powershell.exe")) return "powershell";
		} catch {
			return "cmd";
		}
		return "cmd";
	} else {
		const shellPath = env.SHELL;
		if (shellPath) {
			if (shellPath.endsWith("zsh")) return "zsh";
			if (shellPath.endsWith("fish")) return "fish";
			if (shellPath.endsWith("bash")) return "bash";
		}
		return "sh";
	}
}
/**
* Generates a copy-pasteable script to set multiple environment variables
* and run a subsequent command.
* @param {EnvVars} envVars - An object of environment variables to set.
* @param {string} commandToRun - The command to run after setting the variables.
* @returns {string} The formatted script string.
*/
function generateEnvScript(envVars, commandToRun = "") {
	const shell = getShell();
	const filteredEnvVars = Object.entries(envVars).filter(([, value]) => value !== void 0);
	let commandBlock;
	switch (shell) {
		case "powershell":
			commandBlock = filteredEnvVars.map(([key, value]) => `$env:${key} = ${value}`).join("; ");
			break;
		case "cmd":
			commandBlock = filteredEnvVars.map(([key, value]) => `set ${key}=${value}`).join(" & ");
			break;
		case "fish":
			commandBlock = filteredEnvVars.map(([key, value]) => `set -gx ${key} ${value}`).join("; ");
			break;
		default: {
			const assignments = filteredEnvVars.map(([key, value]) => `${key}=${value}`).join(" ");
			commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : "";
			break;
		}
	}
	if (commandBlock && commandToRun) return `${commandBlock}${shell === "cmd" ? " & " : " && "}${commandToRun}`;
	return commandBlock || commandToRun;
}

//#endregion
//#region src/admin/layout.tsx
const ADMIN_SECURITY_HEADERS = {
	"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff"
};
const Layout = ({ title = "Admin", active, csrfToken, debugKeyCount = 0, children }) => {
	return /* @__PURE__ */ jsxs("html", {
		lang: "en",
		children: [/* @__PURE__ */ jsxs("head", { children: [
			/* @__PURE__ */ jsx("meta", { charset: "utf-8" }),
			/* @__PURE__ */ jsx("meta", {
				name: "viewport",
				content: "width=device-width, initial-scale=1.0"
			}),
			/* @__PURE__ */ jsxs("title", { children: [title, " — Copilot API Admin"] }),
			/* @__PURE__ */ jsx("link", {
				rel: "stylesheet",
				href: "/admin/assets/style.css"
			})
		] }), /* @__PURE__ */ jsxs("body", { children: [
			/* @__PURE__ */ jsxs("header", {
				class: "admin-header",
				children: [
					/* @__PURE__ */ jsx("div", {
						class: "admin-header__brand",
						children: /* @__PURE__ */ jsx("a", {
							href: "/admin",
							children: "Copilot API"
						})
					}),
					/* @__PURE__ */ jsx("nav", {
						class: "admin-nav",
						children: [
							{
								href: "/admin",
								label: "Overview",
								key: "index"
							},
							{
								href: "/admin/keys",
								label: "Keys",
								key: "keys"
							},
							{
								href: "/admin/usage",
								label: "Usage",
								key: "usage"
							},
							{
								href: "/admin/audit",
								label: "Audit",
								key: "audit"
							},
							{
								href: "/admin/traces",
								label: "Traces",
								key: "traces"
							},
							{
								href: "/admin/settings",
								label: "Settings",
								key: "settings"
							}
						].map((item) => /* @__PURE__ */ jsx("a", {
							href: item.href,
							class: `admin-nav__link${active === item.key ? " admin-nav__link--active" : ""}`,
							children: item.label
						}, item.key))
					}),
					/* @__PURE__ */ jsxs("form", {
						method: "post",
						action: "/admin/session/logout",
						class: "admin-header__logout",
						children: [csrfToken && /* @__PURE__ */ jsx("input", {
							type: "hidden",
							name: "csrf_token",
							value: csrfToken
						}), /* @__PURE__ */ jsx("button", {
							type: "submit",
							children: "Logout"
						})]
					})
				]
			}),
			debugKeyCount > 0 && /* @__PURE__ */ jsxs("div", {
				class: "debug-banner",
				role: "alert",
				children: [
					"⚠️ ",
					/* @__PURE__ */ jsx("strong", { children: "Debug mode active" }),
					" on ",
					debugKeyCount,
					" key",
					debugKeyCount === 1 ? "" : "s",
					" — prompts & responses are being persisted in plaintext. ",
					/* @__PURE__ */ jsx("a", {
						href: "/admin/keys",
						children: "Review →"
					})
				]
			}),
			/* @__PURE__ */ jsx("main", {
				class: "admin-main",
				children
			}),
			/* @__PURE__ */ jsx("footer", {
				class: "admin-footer",
				children: /* @__PURE__ */ jsx("span", { children: "Copilot API Admin" })
			})
		] })]
	});
};
const LoginLayout = ({ children }) => /* @__PURE__ */ jsxs("html", {
	lang: "en",
	children: [/* @__PURE__ */ jsxs("head", { children: [
		/* @__PURE__ */ jsx("meta", { charset: "utf-8" }),
		/* @__PURE__ */ jsx("meta", {
			name: "viewport",
			content: "width=device-width, initial-scale=1.0"
		}),
		/* @__PURE__ */ jsx("title", { children: "Login — Copilot API Admin" }),
		/* @__PURE__ */ jsx("link", {
			rel: "stylesheet",
			href: "/admin/assets/style.css"
		})
	] }), /* @__PURE__ */ jsx("body", {
		class: "login-page",
		children: /* @__PURE__ */ jsx("main", {
			class: "login-main",
			children
		})
	})]
});

//#endregion
//#region src/admin/audit/page.tsx
function pad2(n) {
	return String(n).padStart(2, "0");
}
function formatTs(ts) {
	const d = new Date(ts);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}
function shortKeyId(id) {
	if (id.startsWith("__")) return id;
	if (id.length <= 8) return id;
	return `…${id.slice(-8)}`;
}
function describeChange(ev) {
	if (ev.target) return ev.target;
	return "";
}
const Pager = ({ date, action, limit, offset, total, hasMore }) => {
	const qs = (off) => {
		const params = new URLSearchParams();
		params.set("date", date);
		if (action) params.set("action", action);
		params.set("limit", String(limit));
		params.set("offset", String(off));
		return `?${params.toString()}`;
	};
	const prevOff = Math.max(0, offset - limit);
	const nextOff = offset + limit;
	const showingFrom = total === 0 ? 0 : offset + 1;
	const showingTo = Math.min(offset + limit, total);
	return /* @__PURE__ */ jsxs("div", {
		class: "audit-pager",
		children: [/* @__PURE__ */ jsxs("span", {
			class: "muted",
			children: [
				"Showing ",
				showingFrom,
				"–",
				showingTo,
				" of ",
				total
			]
		}), /* @__PURE__ */ jsxs("div", {
			class: "audit-pager__buttons",
			children: [offset > 0 && /* @__PURE__ */ jsx("a", {
				class: "btn",
				href: qs(prevOff),
				children: "← Prev"
			}), hasMore && /* @__PURE__ */ jsx("a", {
				class: "btn",
				href: qs(nextOff),
				children: "Next →"
			})]
		})]
	});
};
const AuditPage = ({ csrfToken, date, actionFilter, events: events$1, total, limit, offset, hasMore, availableActions }) => /* @__PURE__ */ jsx(Layout, {
	title: "Audit",
	active: "audit",
	csrfToken,
	children: /* @__PURE__ */ jsxs("div", {
		class: "audit-page",
		children: [
			/* @__PURE__ */ jsx("h1", { children: "Audit log" }),
			/* @__PURE__ */ jsxs("p", {
				class: "muted",
				children: [
					"Append-only JSONL at",
					" ",
					/* @__PURE__ */ jsx("code", { children: "~/.local/share/copilot-api/audit-YYYY-MM-DD.jsonl" }),
					". Records admin actions (key CRUD, debug toggle, config edits) and security events (auth rejections, no-auth boot)."
				]
			}),
			/* @__PURE__ */ jsxs("form", {
				method: "get",
				action: "/admin/audit",
				class: "audit-filter",
				children: [
					/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "Date" }), /* @__PURE__ */ jsx("input", {
						type: "date",
						name: "date",
						value: date,
						required: true
					})] }),
					/* @__PURE__ */ jsxs("label", { children: [/* @__PURE__ */ jsx("span", { children: "Action" }), /* @__PURE__ */ jsxs("select", {
						name: "action",
						children: [/* @__PURE__ */ jsx("option", {
							value: "",
							children: "(all)"
						}), availableActions.map((a) => /* @__PURE__ */ jsx("option", {
							value: a,
							selected: a === actionFilter,
							children: a
						}, a))]
					})] }),
					/* @__PURE__ */ jsx("input", {
						type: "hidden",
						name: "limit",
						value: String(limit)
					}),
					/* @__PURE__ */ jsx("button", {
						type: "submit",
						class: "btn btn-primary",
						children: "Apply"
					}),
					/* @__PURE__ */ jsx("a", {
						class: "btn",
						href: "/admin/audit",
						children: "Reset"
					})
				]
			}),
			events$1.length === 0 ? /* @__PURE__ */ jsxs("p", {
				class: "muted",
				children: [
					"No audit events for ",
					/* @__PURE__ */ jsx("code", { children: date }),
					actionFilter ? /* @__PURE__ */ jsxs(Fragment, { children: [
						" ",
						"with action ",
						/* @__PURE__ */ jsx("code", { children: actionFilter })
					] }) : "",
					"."
				]
			}) : /* @__PURE__ */ jsxs("table", {
				class: "audit-table",
				children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
					/* @__PURE__ */ jsx("th", { children: "Time (UTC)" }),
					/* @__PURE__ */ jsx("th", { children: "Actor" }),
					/* @__PURE__ */ jsx("th", { children: "Tier" }),
					/* @__PURE__ */ jsx("th", { children: "Action" }),
					/* @__PURE__ */ jsx("th", { children: "Target" }),
					/* @__PURE__ */ jsx("th", { children: "IP" })
				] }) }), /* @__PURE__ */ jsx("tbody", { children: events$1.map((ev, i) => /* @__PURE__ */ jsxs("tr", { children: [
					/* @__PURE__ */ jsx("td", {
						class: "mono",
						children: formatTs(ev.ts)
					}),
					/* @__PURE__ */ jsx("td", {
						class: "mono",
						children: shortKeyId(ev.actor_key_id)
					}),
					/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("span", {
						class: `badge badge-${ev.actor_tier}`,
						children: ev.actor_tier
					}) }),
					/* @__PURE__ */ jsx("td", {
						class: "mono",
						children: ev.action
					}),
					/* @__PURE__ */ jsx("td", {
						class: "mono",
						children: describeChange(ev)
					}),
					/* @__PURE__ */ jsx("td", {
						class: "mono",
						children: ev.ip ?? ""
					})
				] }, `${ev.ts}-${i}`)) })]
			}),
			/* @__PURE__ */ jsx(Pager, {
				date,
				action: actionFilter,
				limit,
				offset,
				total,
				hasMore
			})
		]
	})
});

//#endregion
//#region src/admin/audit/route.tsx
function parseDateParam$1(dateParam) {
	if (dateParam !== void 0 && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return dateParam;
	return todayDateStr$1();
}
function parseIntParam$1(raw, fallback) {
	if (raw === void 0) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}
function isValidEvent$1(parsed) {
	return parsed !== null && typeof parsed === "object" && "ts" in parsed && "actor_key_id" in parsed && "action" in parsed;
}
function readAuditEvents$1(dateStr, actionFilter) {
	const filePath = auditFilePath(dateStr);
	let raw;
	try {
		raw = fs$1.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const events$1 = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (isValidEvent$1(parsed) && (actionFilter === void 0 || parsed.action === actionFilter)) events$1.push(parsed);
	}
	return events$1.reverse();
}
const auditAdminRoute = new Hono();
auditAdminRoute.get("/", (c) => {
	const dateStr = parseDateParam$1(c.req.query("date"));
	const actionFilterRaw = c.req.query("action");
	const actionFilter = actionFilterRaw && actionFilterRaw.length > 0 ? actionFilterRaw : void 0;
	const limit = Math.max(1, Math.min(500, parseIntParam$1(c.req.query("limit"), 100)));
	const offset = Math.max(0, parseIntParam$1(c.req.query("offset"), 0));
	const events$1 = readAuditEvents$1(dateStr, actionFilter);
	const total = events$1.length;
	const page = events$1.slice(offset, offset + limit);
	const hasMore = offset + limit < total;
	const availableActions = [...new Set(events$1.map((e) => e.action))].sort();
	const accept = c.req.header("accept") ?? "";
	if (accept.includes("application/json") && !accept.includes("text/html")) return c.json({
		events: page,
		total,
		has_more: hasMore
	});
	const session = c.get("session");
	return c.html(/* @__PURE__ */ jsx(AuditPage, {
		csrfToken: session.csrf_token,
		date: dateStr,
		actionFilter: actionFilter ?? "",
		events: page,
		total,
		limit,
		offset,
		hasMore,
		availableActions
	}), 200, ADMIN_SECURITY_HEADERS);
});

//#endregion
//#region src/admin/api/audit.ts
function parseDateParam(dateParam) {
	if (dateParam !== void 0 && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return dateParam;
	return todayDateStr$1();
}
function parseIntParam(raw, fallback) {
	if (raw === void 0) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : fallback;
}
function isValidEvent(parsed) {
	return parsed !== null && typeof parsed === "object" && "ts" in parsed && "actor_key_id" in parsed && "action" in parsed;
}
function readAuditEvents(dateStr, actionFilter) {
	const filePath = auditFilePath(dateStr);
	let raw;
	try {
		raw = fs$1.readFileSync(filePath, "utf8");
	} catch {
		return [];
	}
	const events$1 = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (isValidEvent(parsed) && (actionFilter === void 0 || parsed.action === actionFilter)) events$1.push(parsed);
	}
	return events$1.reverse();
}
const auditApiRoute = new Hono();
auditApiRoute.get("/", (c) => {
	const dateStr = parseDateParam(c.req.query("date"));
	const actionFilterRaw = c.req.query("action");
	const actionFilter = actionFilterRaw && actionFilterRaw.length > 0 ? actionFilterRaw : void 0;
	const limit = Math.max(1, Math.min(500, parseIntParam(c.req.query("limit"), 100)));
	const offset = Math.max(0, parseIntParam(c.req.query("offset"), 0));
	const events$1 = readAuditEvents(dateStr, actionFilter);
	const total = events$1.length;
	const page = events$1.slice(offset, offset + limit);
	const hasMore = offset + limit < total;
	const availableActions = [...new Set(events$1.map((e) => e.action))].sort();
	const buckets = [];
	for (let h = 0; h < 24; h++) buckets.push({ hour: `${h.toString().padStart(2, "0")}:00` });
	for (const ev of events$1) {
		const hour = new Date(ev.ts).getHours();
		const bucket = buckets[hour];
		if (!bucket) continue;
		bucket[ev.action] = (bucket[ev.action] ?? 0) + 1;
	}
	return c.json({
		date: dateStr,
		events: page,
		total,
		has_more: hasMore,
		available_actions: availableActions,
		hourly: buckets
	});
});

//#endregion
//#region src/admin/usage/queries.ts
const MINUTE_MS = 6e4;
const HOUR_MS$2 = 36e5;
const DAY_MS$5 = 864e5;
function chooseBucket(filter) {
	const span = Math.max(0, filter.until - filter.since);
	if (span <= 12 * HOUR_MS$2) return {
		bucketMs: MINUTE_MS,
		label: "per minute"
	};
	if (span <= 3.5 * DAY_MS$5) return {
		bucketMs: HOUR_MS$2,
		label: "per hour"
	};
	if (span <= 18 * DAY_MS$5) return {
		bucketMs: DAY_MS$5,
		label: "per day"
	};
	return {
		bucketMs: 7 * DAY_MS$5,
		label: "per week"
	};
}
/**
* Build a `(?,?,...)` placeholder string for a SQL IN clause.  Returns
* `undefined` when the input list is empty/undefined, so the caller can
* skip the WHERE-clause fragment entirely (an empty IN-list is a SQL error
* and would silently filter out every row anyway).
*/
function inPlaceholders(values) {
	if (!values || values.length === 0) return void 0;
	return values.map(() => "?").join(",");
}
/** Compose the WHERE clause shared by every dashboard query. */
function buildWhere$1(filter) {
	const parts = ["ts >= ?", "ts < ?"];
	const params = [filter.since, filter.until];
	const keyIn = inPlaceholders(filter.keyIds);
	if (keyIn !== void 0 && filter.keyIds) {
		parts.push(`key_id IN (${keyIn})`);
		params.push(...filter.keyIds);
	}
	const modelIn = inPlaceholders(filter.models);
	if (modelIn !== void 0 && filter.models) {
		parts.push(`model IN (${modelIn})`);
		params.push(...filter.models);
	}
	return {
		sql: parts.join(" AND "),
		params
	};
}
function requestsPerBucket(filter, bucketMs) {
	const where = buildWhere$1(filter);
	const sql = `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
            model AS model,
            COUNT(*) AS count
       FROM events
      WHERE ${where.sql}
      GROUP BY bucket, model
      ORDER BY bucket ASC, model ASC`;
	return getDb().query(sql).all(...where.params).map((r) => ({
		ts: r.bucket,
		model: r.model,
		count: r.count
	}));
}
/**
* Legacy alias kept for backwards-compat with any external caller that
* still imports `requestsPerMinute`.  Always returns minute buckets.
*/
function requestsPerMinute(filter) {
	return requestsPerBucket(filter, MINUTE_MS);
}
function tokensPerBucket(filter, bucketMs) {
	const where = buildWhere$1(filter);
	const sql = `SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
            COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM events
      WHERE ${where.sql}
      GROUP BY bucket
      ORDER BY bucket ASC`;
	return getDb().query(sql).all(...where.params).map((r) => ({
		ts: r.bucket,
		prompt_tokens: r.prompt_tokens,
		completion_tokens: r.completion_tokens
	}));
}
function tokensPerHour(filter) {
	return tokensPerBucket(filter, HOUR_MS$2);
}
function p95LatencyPerHour(filter) {
	const where = buildWhere$1(filter);
	const buckets = getDb().query(`SELECT (ts / ${HOUR_MS$2}) * ${HOUR_MS$2} AS bucket, COUNT(*) AS count
         FROM events
        WHERE ${where.sql}
        GROUP BY bucket
        ORDER BY bucket ASC`).all(...where.params);
	const tailParams = where.params.slice(2);
	const tailSql = where.sql.split(" AND ").slice(2).join(" AND ");
	const innerWhere = tailSql.length > 0 ? `ts >= ? AND ts < ? AND ${tailSql}` : `ts >= ? AND ts < ?`;
	const out = [];
	for (const b of buckets) {
		const offset = Math.floor(.95 * (b.count - 1));
		const bucketEnd = b.bucket + HOUR_MS$2;
		const innerSql = `SELECT latency_ms FROM events
        WHERE ${innerWhere}
        ORDER BY latency_ms ASC
        LIMIT 1 OFFSET ${offset}`;
		const row = getDb().query(innerSql).get(b.bucket, bucketEnd, ...tailParams);
		if (row) out.push({
			ts: b.bucket,
			p95: row.latency_ms
		});
	}
	return out;
}
function topKeysByTokens(filter, limit = 10) {
	const where = buildWhere$1(filter);
	const sql = `SELECT key_id,
            COALESCE(SUM(COALESCE(prompt_tokens, 0)
                       + COALESCE(completion_tokens, 0)), 0) AS tokens
       FROM events
      WHERE ${where.sql}
      GROUP BY key_id
      ORDER BY tokens DESC
      LIMIT ?`;
	return getDb().query(sql).all(...where.params, limit);
}
function topModelsByRequests(filter, limit = 10) {
	const where = buildWhere$1(filter);
	const sql = `SELECT model, COUNT(*) AS count
       FROM events
      WHERE ${where.sql}
      GROUP BY model
      ORDER BY count DESC
      LIMIT ?`;
	return getDb().query(sql).all(...where.params, limit);
}
function errorRateByKey(filter) {
	const where = buildWhere$1(filter);
	const sql = `SELECT key_id,
            COUNT(*)                                         AS total,
            SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)   AS errors
       FROM events
      WHERE ${where.sql}
      GROUP BY key_id
      ORDER BY errors DESC, total DESC`;
	return getDb().query(sql).all(...where.params).map((r) => ({
		key_id: r.key_id,
		total: r.total,
		errors: r.errors,
		rate: r.total === 0 ? 0 : r.errors / r.total
	}));
}
function streamEventsForCsv(filter) {
	const where = buildWhere$1(filter);
	const sql = `SELECT id, ts, key_id, model, upstream_model,
            prompt_tokens, completion_tokens, status, latency_ms,
            error, usage_unknown
       FROM events
      WHERE ${where.sql}
      ORDER BY ts ASC, id ASC`;
	return getDb().query(sql).iterate(...where.params);
}
function distinctModels() {
	return getDb().query("SELECT DISTINCT model FROM events ORDER BY model").all().map((r) => r.model);
}
function usageForKey(keyId, windowMs) {
	const db = getDb();
	const since = Date.now() - windowMs;
	const agg = db.query(`SELECT
         COUNT(*) AS total_requests,
         SUM(prompt_tokens) AS total_prompt,
         SUM(completion_tokens) AS total_completion,
         SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
         MAX(ts) AS last_ts
       FROM events
       WHERE key_id = ? AND ts >= ?`).get(keyId, since);
	const totalReq = agg?.total_requests ?? 0;
	if (totalReq === 0) return {
		total_requests: 0,
		total_prompt_tokens: 0,
		total_completion_tokens: 0,
		errors: 0,
		error_rate: 0,
		p95_latency_ms: null,
		last_used_ts: null
	};
	const offset = Math.floor(.95 * (totalReq - 1));
	const p95Row = db.query(`SELECT latency_ms FROM events
       WHERE key_id = ? AND ts >= ?
       ORDER BY latency_ms ASC
       LIMIT 1 OFFSET ${offset}`).get(keyId, since);
	const errors = agg?.errors ?? 0;
	return {
		total_requests: totalReq,
		total_prompt_tokens: agg?.total_prompt ?? 0,
		total_completion_tokens: agg?.total_completion ?? 0,
		errors,
		error_rate: totalReq > 0 ? errors / totalReq : 0,
		p95_latency_ms: p95Row?.latency_ms ?? null,
		last_used_ts: agg?.last_ts ?? null
	};
}
function recentCallsForKey(keyId, limit = 20) {
	return getDb().query(`SELECT id, ts, model, upstream_model, status, latency_ms,
              prompt_tokens, completion_tokens, error
         FROM events
         WHERE key_id = ?
         ORDER BY ts DESC
         LIMIT ?`).all(keyId, limit);
}
function latencyPercentiles(filter, bucketMs = HOUR_MS$2) {
	const where = buildWhere$1(filter);
	const buckets = getDb().query(`SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket, COUNT(*) AS count
         FROM events
        WHERE ${where.sql}
        GROUP BY bucket
        ORDER BY bucket ASC`).all(...where.params);
	const tailParams = where.params.slice(2);
	const tailSql = where.sql.split(" AND ").slice(2).join(" AND ");
	const innerWhere = tailSql.length > 0 ? `ts >= ? AND ts < ? AND ${tailSql}` : `ts >= ? AND ts < ?`;
	const out = [];
	for (const b of buckets) {
		if (b.count === 0) continue;
		const bucketEnd = b.bucket + bucketMs;
		const pick = (frac) => {
			const offset = Math.floor(frac * (b.count - 1));
			const innerSql = `SELECT latency_ms FROM events
            WHERE ${innerWhere}
            ORDER BY latency_ms ASC
            LIMIT 1 OFFSET ${offset}`;
			return getDb().query(innerSql).get(b.bucket, bucketEnd, ...tailParams)?.latency_ms ?? 0;
		};
		out.push({
			ts: b.bucket,
			p50: pick(.5),
			p95: pick(.95),
			p99: pick(.99)
		});
	}
	return out;
}
function errorBreakdownByStatus(filter) {
	const where = buildWhere$1(filter);
	const sql = `SELECT status,
              COUNT(*) AS count,
              MAX(error) AS sample_error
         FROM events
        WHERE ${where.sql} AND status >= 400
        GROUP BY status
        ORDER BY count DESC, status ASC`;
	return getDb().query(sql).all(...where.params);
}

//#endregion
//#region src/admin/api/keys.ts
const UUID_RE$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE$1 = 50;
const MAX_LABEL_LEN$1 = 200;
const DAY_MS$4 = 864e5;
function safeAudit$1(event) {
	try {
		audit(event);
	} catch (err) {
		consola.error(`[admin] audit failed (continuing): ${String(err)}`);
	}
}
function parseAllowedModels$1(raw) {
	if (raw === void 0 || raw === null) return void 0;
	if (!Array.isArray(raw)) return void 0;
	return raw.filter((m) => typeof m === "string");
}
function parseRateLimit(raw) {
	if (raw === void 0) return void 0;
	if (raw === null || raw === "") return null;
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
	if (!Number.isFinite(n) || n < 0) return null;
	return n;
}
/** Serialise a KeyRow for the client. Adds parsed allowed_models + debug status. */
function serializeKey(row) {
	let allowedModels;
	try {
		allowedModels = JSON.parse(row.allowed_models);
	} catch {
		allowedModels = ["*"];
	}
	return {
		id: row.id,
		tier: row.tier,
		label: row.label,
		allowed_models: allowedModels,
		rate_limit_override: row.rate_limit_override,
		debug_enabled: row.debug_enabled === 1,
		debug_active: isDebugActive(row),
		debug_expires_at: row.debug_expires_at,
		created_at: row.created_at,
		revoked_at: row.revoked_at
	};
}
const keysRoute = new Hono();
keysRoute.get("/", (c) => {
	const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
	const pageSize = Math.min(100, Math.max(1, Number.parseInt(c.req.query("page_size") ?? `${PAGE_SIZE$1}`, 10) || PAGE_SIZE$1));
	const offset = (page - 1) * pageSize;
	const { rows, total } = listKeys(pageSize, offset);
	const debugKeyCount = countActiveDebugKeys();
	const activeCount = rows.filter((r) => r.revoked_at === null).length;
	return c.json({
		items: rows.map(serializeKey),
		pagination: {
			page,
			page_size: pageSize,
			total,
			total_pages: Math.max(1, Math.ceil(total / pageSize))
		},
		summary: {
			total_keys: total,
			active_on_page: activeCount,
			debug_active: debugKeyCount
		}
	});
});
keysRoute.post("/", async (c) => {
	const session = c.get("session");
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const label = typeof body.label === "string" ? body.label.trim() : "";
	if (!label) return c.json({ error: "Label is required" }, 400);
	if (label.length > MAX_LABEL_LEN$1) return c.json({ error: `Label too long (max ${MAX_LABEL_LEN$1} chars)` }, 400);
	const tier = body.tier === "admin" || body.tier === "client" ? body.tier : "client";
	const allowedModels = parseAllowedModels$1(body.allowed_models);
	if (allowedModels !== void 0 && allowedModels.length === 0) return c.json({ error: "Select at least one allowed model (or '*')" }, 400);
	const rateLimit = parseRateLimit(body.rate_limit_override);
	const debugEnabled = body.debug_enabled === true;
	const debugConfirm = body.debug_confirm === true;
	if (debugEnabled && !debugConfirm) return c.json({ error: "Debug enable requires debug_confirm: true" }, 400);
	try {
		const { plain, row } = createKey({
			tier,
			label,
			allowedModels: allowedModels ?? ["*"],
			rateLimitOverride: rateLimit === null ? void 0 : rateLimit,
			debugEnabled
		});
		safeAudit$1({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "key.create",
			target: row.id,
			after: {
				label,
				tier,
				allowed_models: allowedModels ?? ["*"],
				rate_limit_override: rateLimit ?? null,
				debug_enabled: debugEnabled
			}
		});
		return c.json({
			key: serializeKey(row),
			plain
		}, 201);
	} catch (err) {
		return c.json({ error: String(err) }, 400);
	}
});
keysRoute.get("/:id", (c) => {
	const id = c.req.param("id");
	if (!UUID_RE$1.test(id)) return c.json({ error: "Not found" }, 404);
	const row = findKeyById(id);
	if (!row) return c.json({ error: "Not found" }, 404);
	const config = getConfig();
	const usage_24h = usageForKey(id, DAY_MS$4);
	const usage_7d = usageForKey(id, 7 * DAY_MS$4);
	const usage_30d = usageForKey(id, 30 * DAY_MS$4);
	const recent = recentCallsForKey(id, 20);
	return c.json({
		key: serializeKey(row),
		usage: {
			"24h": usage_24h,
			"7d": usage_7d,
			"30d": usage_30d
		},
		recent_calls: recent,
		available_aliases: Object.keys(config.models),
		retention_traces_days: config.retention.traces_days
	});
});
keysRoute.post("/:id/revoke", (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!UUID_RE$1.test(id)) return c.json({ error: "Not found" }, 404);
	if (!findKeyById(id)) return c.json({ error: "Not found" }, 404);
	const changed = revokeKey(id);
	if (changed) safeAudit$1({
		actor_key_id: session.key_id,
		actor_tier: "admin",
		action: "key.revoke",
		target: id
	});
	const updated = findKeyById(id);
	return c.json({
		ok: true,
		revoked: changed,
		key: updated ? serializeKey(updated) : null
	});
});
keysRoute.post("/:id/scope", async (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!UUID_RE$1.test(id)) return c.json({ error: "Not found" }, 404);
	const row = findKeyById(id);
	if (!row) return c.json({ error: "Not found" }, 404);
	if (row.revoked_at !== null) return c.json({ error: "Key is revoked" }, 400);
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const allowedModels = parseAllowedModels$1(body.allowed_models);
	if (allowedModels === void 0) return c.json({ error: "allowed_models is required" }, 400);
	if (allowedModels.length === 0) return c.json({ error: "Select at least one allowed model (or '*')" }, 400);
	const rateLimit = parseRateLimit(body.rate_limit_override);
	const rateLimitFinal = rateLimit === void 0 ? null : rateLimit;
	try {
		const changed = updateKeyScope(id, allowedModels, rateLimitFinal);
		if (changed) safeAudit$1({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "key.scope_update",
			target: id,
			after: {
				allowed_models: allowedModels,
				rate_limit_override: rateLimitFinal
			}
		});
		const updated = findKeyById(id);
		return c.json({
			ok: true,
			changed,
			key: updated ? serializeKey(updated) : null
		});
	} catch (err) {
		return c.json({ error: String(err) }, 400);
	}
});
keysRoute.post("/:id/debug", async (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!UUID_RE$1.test(id)) return c.json({ error: "Not found" }, 404);
	const row = findKeyById(id);
	if (!row) return c.json({ error: "Not found" }, 404);
	if (row.revoked_at !== null) return c.json({ error: "Key is revoked" }, 400);
	let body = {};
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	let auditAction;
	if (body.action === "renew") {
		setDebugEnabled(id, true);
		auditAction = "key.debug_renew";
	} else if (body.enabled === true) {
		if (body.confirm !== true) return c.json({ error: "Debug enable requires confirm: true" }, 400);
		setDebugEnabled(id, true);
		auditAction = "key.debug_enable";
	} else {
		setDebugEnabled(id, false);
		auditAction = "key.debug_disable";
	}
	safeAudit$1({
		actor_key_id: session.key_id,
		actor_tier: "admin",
		action: auditAction,
		target: id
	});
	const updated = findKeyById(id);
	return c.json({
		ok: true,
		key: updated ? serializeKey(updated) : null
	});
});

//#endregion
//#region src/admin/api/logs.ts
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
function parseTs(raw) {
	if (!raw) return null;
	const t = Date.parse(raw);
	if (Number.isFinite(t)) return t;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}
function statusClause(status) {
	if (status === "ok") return { sql: "status < 400" };
	if (status === "error") return { sql: "status >= 400" };
	if (status && /^\d+$/.test(status)) return {
		sql: "status = ?",
		param: Number.parseInt(status, 10)
	};
	return null;
}
function kindClause(kind) {
	if (kind === "messages") return "model NOT LIKE '%/%'";
	if (kind === "other") return "model LIKE '%/%'";
	return null;
}
function buildWhere(c, options = {}) {
	const parts = [];
	const params = [];
	const since = parseTs(c.req.query("since"));
	const until = parseTs(c.req.query("until"));
	if (since !== null) {
		parts.push("ts >= ?");
		params.push(since);
	}
	if (until !== null) {
		parts.push("ts < ?");
		params.push(until);
	}
	const keyIds = (c.req.queries("key_id") ?? []).filter((v) => v.length > 0);
	const models = (c.req.queries("model") ?? []).filter((v) => v.length > 0);
	if (keyIds.length > 0) {
		parts.push(`key_id IN (${keyIds.map(() => "?").join(",")})`);
		params.push(...keyIds);
	}
	if (models.length > 0) {
		parts.push(`model IN (${models.map(() => "?").join(",")})`);
		params.push(...models);
	}
	const status = statusClause(c.req.query("status"));
	if (status) {
		parts.push(status.sql);
		if (status.param !== void 0) params.push(status.param);
	}
	if (!options.excludeKind) {
		const kindSql = kindClause(c.req.query("kind"));
		if (kindSql) parts.push(kindSql);
	}
	const q = c.req.query("q");
	if (q && q.length > 0) {
		parts.push("(key_id LIKE ? OR model LIKE ? OR error LIKE ?)");
		const like = `%${q}%`;
		params.push(like, like, like);
	}
	return {
		sql: parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`,
		params
	};
}
const logsRoute = new Hono();
logsRoute.get("/", (c) => {
	const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(c.req.query("limit") ?? `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT));
	const offset = Math.max(0, Number.parseInt(c.req.query("offset") ?? "0", 10) || 0);
	const where = buildWhere(c);
	const db = getDb();
	const countSql = `SELECT COUNT(*) AS n FROM events ${where.sql}`;
	const total = db.query(countSql).get(...where.params)?.n ?? 0;
	const rowsSql = `SELECT * FROM events ${where.sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`;
	const rows = db.query(rowsSql).all(...where.params, limit, offset);
	const keyIds = [...new Set(rows.map((r) => r.key_id))];
	const labelById = /* @__PURE__ */ new Map();
	if (keyIds.length > 0) {
		const placeholders = keyIds.map(() => "?").join(",");
		const labelRows = db.query(`SELECT id, label FROM keys WHERE id IN (${placeholders})`).all(...keyIds);
		for (const r of labelRows) labelById.set(r.id, r.label);
	}
	const allModels = db.query("SELECT DISTINCT model FROM events WHERE model NOT LIKE '%/%' ORDER BY model").all().map((r) => r.model);
	const whereNoKind = buildWhere(c, { excludeKind: true });
	const kindCountsRow = db.query(`SELECT
         SUM(CASE WHEN model NOT LIKE '%/%' THEN 1 ELSE 0 END) AS messages,
         SUM(CASE WHEN model LIKE '%/%' THEN 1 ELSE 0 END) AS other
       FROM events ${whereNoKind.sql}`).get(...whereNoKind.params);
	const kindCounts = {
		messages: kindCountsRow?.messages ?? 0,
		other: kindCountsRow?.other ?? 0
	};
	return c.json({
		items: rows.map((r) => ({
			...r,
			key_label: labelById.get(r.key_id) ?? null
		})),
		total,
		limit,
		offset,
		all_models: allModels,
		kind_counts: kindCounts
	});
});
logsRoute.get("/traces", (c) => {
	const dir = tracesDir();
	let entries;
	try {
		entries = fs$1.readdirSync(dir).filter((f) => f.startsWith("traces-") && f.endsWith(".jsonl")).map((f) => {
			const stat = fs$1.statSync(path.join(dir, f));
			return {
				name: f,
				size: stat.size,
				mtime: stat.mtimeMs
			};
		}).sort((a, b) => b.mtime - a.mtime);
	} catch {
		entries = [];
	}
	return c.json({
		items: entries,
		dir
	});
});
function dateStrForTs(ts) {
	const d = new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
function describeKeyDebugState(row, eventTs) {
	if (!row) return "The event's key no longer exists in this database — it may have been deleted, or the event was recorded by a different server instance writing to a different data directory.";
	const labelDisplay = row.label ?? "(no label)";
	if (row.revoked_at !== null) return `Key ${labelDisplay} is currently revoked.`;
	if (row.debug_enabled !== 1) return `Key ${labelDisplay} currently has debug OFF — enable it on the Keys page, then re-run the request to capture future calls.`;
	if (row.debug_expires_at !== null && row.debug_expires_at <= eventTs) return `Key ${labelDisplay} had debug enabled but the 24h TTL had already expired by the time of this request.`;
	return `Key ${labelDisplay} has debug ON now, but it was likely off when this request (at ${new Date(eventTs).toLocaleString()}) was served. Make a fresh request to capture a trace.`;
}
logsRoute.get("/:id/trace", (c) => {
	const idRaw = c.req.param("id");
	const id = Number.parseInt(idRaw, 10);
	if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Bad id" }, 400);
	const db = getDb();
	const event = db.query(`SELECT id, ts, key_id, model FROM events WHERE id = ?`).get(id);
	if (!event) return c.json({ error: "Event not found" }, 404);
	const keyRow = db.query(`SELECT label, debug_enabled, debug_expires_at, revoked_at
         FROM keys WHERE id = ?`).get(event.key_id);
	const keyDiag = describeKeyDebugState(keyRow, event.ts);
	const dateStr = dateStrForTs(event.ts);
	const filePath = path.join(tracesDir(), `traces-${dateStr}.jsonl`);
	let raw;
	try {
		raw = fs$1.readFileSync(filePath, "utf8");
	} catch {
		return c.json({
			error: "no_capture",
			reason: `No trace file exists for ${dateStr}. ${keyDiag} Capture only fires when debug mode is on *at the moment* the request is served.`,
			event,
			key_diagnosis: keyDiag
		}, 404);
	}
	let best = null;
	let bestDelta = Infinity;
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (parsed.key_id !== event.key_id) continue;
		const delta = Math.abs((parsed.ts ?? 0) - event.ts);
		if (delta > 2e3) continue;
		if (delta < bestDelta) {
			bestDelta = delta;
			best = parsed;
		}
	}
	if (!best) return c.json({
		error: "no_capture",
		reason: `Trace file ${dateStr} exists but no line matches event #${id} (key + ts within 2s). ${keyDiag} The most common cause is that debug was off when this exact request fired.`,
		event,
		key_diagnosis: keyDiag
	}, 404);
	return c.json({
		event,
		trace: best,
		file: `traces-${dateStr}.jsonl`
	});
});

//#endregion
//#region src/lib/build-identity.ts
let cached = null;
let inflight = null;
const STARTED_AT = Date.now();
async function getBuildIdentity() {
	if (cached) return cached;
	if (inflight) return inflight;
	inflight = computeBuildIdentity().then((id) => {
		cached = id;
		inflight = null;
		return id;
	});
	return inflight;
}
/**
* Walk upward from the bundled / source file location until we find a
* package.json. Handles both layouts in one shot.
*/
async function findRepoRoot() {
	let dir = path.dirname(new URL(import.meta.url).pathname);
	for (let i = 0; i < 6; i++) try {
		await fs.access(path.join(dir, "package.json"));
		return dir;
	} catch {
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}
async function computeBuildIdentity() {
	const repoRoot = await findRepoRoot();
	let version = "unknown";
	if (repoRoot) try {
		version = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"))).version;
	} catch {}
	let branch = null;
	let commit = null;
	let commitTime = null;
	if (repoRoot) {
		branch = runGit([
			"rev-parse",
			"--abbrev-ref",
			"HEAD"
		], repoRoot);
		commit = runGit([
			"rev-parse",
			"--short",
			"HEAD"
		], repoRoot);
		commitTime = runGit([
			"log",
			"-1",
			"--format=%cI"
		], repoRoot);
	}
	return {
		version,
		branch: branch || void 0,
		commit: commit || void 0,
		commit_time: commitTime || void 0,
		started_at: STARTED_AT
	};
}
function runGit(args, cwd) {
	try {
		const res = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: 1e3
		});
		if (res.status !== 0) return null;
		return res.stdout.trim() || null;
	} catch {
		return null;
	}
}

//#endregion
//#region src/admin/api/me.ts
const meRoute = new Hono();
meRoute.get("/", async (c) => {
	const session = c.get("session");
	const key = findKeyById(session.key_id);
	const build = await getBuildIdentity();
	return c.json({
		authenticated: true,
		key_id: session.key_id,
		label: key?.label ?? null,
		tier: "admin",
		csrf_token: session.csrf_token,
		auth_mode_label: state.authModeLabel ?? "on",
		bind_address: state.bindAddress ?? "unknown",
		build
	});
});

//#endregion
//#region src/admin/api/logout.ts
const logoutRoute = new Hono();
logoutRoute.post("/", (c) => {
	const cookieHeader = c.req.header("cookie");
	const sessionId = extractSessionId(cookieHeader);
	if (sessionId) deleteSession(sessionId);
	const secure = process.env.ADMIN_INSECURE_HTTP === "true" ? "" : "; Secure";
	const headers = new Headers({ "Content-Type": "application/json" });
	headers.append("Set-Cookie", clearSessionCookieValue());
	headers.append("Set-Cookie", `csrf=; Path=/admin; Max-Age=0; SameSite=Strict${secure}`);
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers
	});
});

//#endregion
//#region src/admin/api/models.ts
const DAY_MS$3 = 1440 * 60 * 1e3;
const modelsRoute = new Hono();
modelsRoute.get("/upstream", (c) => {
	const items = (state.models?.data ?? []).map((m) => ({ ...m }));
	items.sort((a, b) => {
		const aP = a.model_picker_enabled;
		const bP = b.model_picker_enabled;
		if (aP !== bP) return aP ? -1 : 1;
		const aV = a.vendor ?? "";
		const bV = b.vendor ?? "";
		if (aV !== bV) return aV.localeCompare(bV);
		const aI = a.id ?? "";
		const bI = b.id ?? "";
		return aI.localeCompare(bI);
	});
	return c.json({
		items,
		count: items.length
	});
});
modelsRoute.post("/refresh", async (c) => {
	try {
		await cacheModels();
		return c.json({
			ok: true,
			catalog_size: state.models?.data.length ?? 0
		});
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return c.json({
			ok: false,
			error: msg
		}, 502);
	}
});
modelsRoute.get("/", (c) => {
	const config = getConfig();
	const aliases = Object.entries(config.models);
	const since = Date.now() - DAY_MS$3;
	const db = getDb();
	const aggRows = db.query(`SELECT model,
              COUNT(*) AS count,
              SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
              MAX(ts) AS last_used
         FROM events
         WHERE ts >= ?
         GROUP BY model`).all(since);
	const aggByAlias = /* @__PURE__ */ new Map();
	for (const r of aggRows) aggByAlias.set(r.model, r);
	const upstreamRows = db.query(`SELECT model, upstream_model, ts
         FROM events
         WHERE ts >= ?
         ORDER BY ts DESC`).all(since);
	const latestUpstreamByAlias = /* @__PURE__ */ new Map();
	for (const r of upstreamRows) if (!latestUpstreamByAlias.has(r.model)) latestUpstreamByAlias.set(r.model, r.upstream_model);
	const capsByUpstream = /* @__PURE__ */ new Map();
	for (const m of state.models?.data ?? []) capsByUpstream.set(m.id, {
		vendor: m.vendor,
		version: m.version,
		family: m.capabilities.family,
		type: m.capabilities.type,
		tokenizer: m.capabilities.tokenizer,
		limits: m.capabilities.limits,
		supports: m.capabilities.supports,
		preview: m.preview,
		model_picker_enabled: m.model_picker_enabled,
		model_picker_category: m.model_picker_category,
		supported_endpoints: m.supported_endpoints,
		policy: m.policy
	});
	const items = aliases.map(([alias, entry]) => {
		const agg = aggByAlias.get(alias);
		const requests = agg?.count ?? 0;
		const errors = agg?.errors ?? 0;
		const caps = capsByUpstream.get(entry.upstream) ?? null;
		return {
			alias,
			upstream: entry.upstream,
			enabled: entry.enabled,
			allowed_keys: entry.allowed_keys,
			detected_upstream: latestUpstreamByAlias.get(alias) ?? null,
			requests_24h: requests,
			errors_24h: errors,
			error_rate_24h: requests === 0 ? 0 : errors / requests,
			last_used: agg?.last_used ?? null,
			capabilities: caps
		};
	});
	const aliases_in_use = items.filter((i) => i.requests_24h > 0).length;
	const aliases_with_errors = items.filter((i) => i.errors_24h > 0).length;
	return c.json({
		items,
		summary: {
			total_aliases: items.length,
			aliases_in_use,
			aliases_with_errors,
			catalog_size: state.models?.data.length ?? 0
		}
	});
});
modelsRoute.get("/:alias", (c) => {
	const alias = c.req.param("alias");
	const entry = getConfig().models[alias];
	if (!entry) return c.json({ error: "Alias not found" }, 404);
	const db = getDb();
	const recent = db.query(`SELECT ts, key_id, upstream_model, status, latency_ms,
              prompt_tokens, completion_tokens, error
         FROM events
         WHERE model = ?
         ORDER BY ts DESC
         LIMIT 20`).all(alias);
	const errors_24h = db.query(`SELECT ts, key_id, status, error
         FROM events
         WHERE model = ? AND ts >= ? AND status >= 400
         ORDER BY ts DESC
         LIMIT 20`).all(alias, Date.now() - DAY_MS$3);
	const upstreamModel = state.models?.data.find((m) => m.id === entry.upstream);
	return c.json({
		alias,
		config: entry,
		upstream_info: upstreamModel ? {
			id: upstreamModel.id,
			name: upstreamModel.name,
			vendor: upstreamModel.vendor,
			version: upstreamModel.version,
			preview: upstreamModel.preview,
			capabilities: upstreamModel.capabilities
		} : null,
		recent_calls: recent,
		errors_24h
	});
});

//#endregion
//#region src/admin/api/overview.ts
const DAY_MS$2 = 1440 * 60 * 1e3;
const overviewRoute = new Hono();
overviewRoute.get("/", (c) => {
	const now = Date.now();
	const since = now - DAY_MS$2;
	const filter = {
		since,
		until: now
	};
	const db = getDb();
	const agg = db.query(`SELECT
         COUNT(*)                                        AS total_requests,
         SUM(prompt_tokens)                              AS total_prompt,
         SUM(completion_tokens)                          AS total_completion,
         SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END)  AS errors
       FROM events
       WHERE ts >= ?`).get(since);
	const totalReq = agg?.total_requests ?? 0;
	const errors = agg?.errors ?? 0;
	const p95Series = p95LatencyPerHour(filter);
	const p95_24h = p95Series.length === 0 ? null : Math.max(...p95Series.map((p) => p.p95));
	const keyCount = db.query(`SELECT
         SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active_keys,
         COUNT(*) AS total_keys
       FROM keys`).get() ?? {
		active_keys: 0,
		total_keys: 0
	};
	const kpis = {
		total_requests_24h: totalReq,
		total_prompt_tokens_24h: agg?.total_prompt ?? 0,
		total_completion_tokens_24h: agg?.total_completion ?? 0,
		errors_24h: errors,
		error_rate_24h: totalReq > 0 ? errors / totalReq : 0,
		p95_latency_ms_24h: p95_24h,
		active_keys: keyCount.active_keys,
		debug_keys: countActiveDebugKeys(),
		total_keys: keyCount.total_keys
	};
	const series_requests_24h = requestsPerMinute(filter);
	const top_models_24h = topModelsByRequests(filter, 8).map((m) => ({
		model: m.model,
		requests: m.count
	}));
	const topKeysRaw = topKeysByTokens(filter, 5);
	const labelById = /* @__PURE__ */ new Map();
	if (topKeysRaw.length > 0) {
		const placeholders = topKeysRaw.map(() => "?").join(",");
		const rows = db.query(`SELECT id, label FROM keys WHERE id IN (${placeholders})`).all(...topKeysRaw.map((r) => r.key_id));
		for (const r of rows) labelById.set(r.id, r.label);
	}
	const topKeyAgg = /* @__PURE__ */ new Map();
	if (topKeysRaw.length > 0) {
		const placeholders = topKeysRaw.map(() => "?").join(",");
		const rows = db.query(`SELECT key_id,
                COALESCE(SUM(prompt_tokens), 0)     AS prompt,
                COALESCE(SUM(completion_tokens), 0) AS completion,
                COUNT(*)                            AS requests
           FROM events
          WHERE ts >= ? AND key_id IN (${placeholders})
          GROUP BY key_id`).all(since, ...topKeysRaw.map((r) => r.key_id));
		for (const r of rows) topKeyAgg.set(r.key_id, {
			prompt_tokens: r.prompt ?? 0,
			completion_tokens: r.completion ?? 0,
			requests: r.requests
		});
	}
	const top_keys_24h = topKeysRaw.map((k) => {
		const a = topKeyAgg.get(k.key_id) ?? {
			prompt_tokens: 0,
			completion_tokens: 0,
			requests: 0
		};
		return {
			key_id: k.key_id,
			label: labelById.get(k.key_id) ?? null,
			prompt_tokens: a.prompt_tokens,
			completion_tokens: a.completion_tokens,
			requests: a.requests
		};
	});
	const recentRaw = db.query(`SELECT id, ts, key_id, model, status, latency_ms,
              prompt_tokens, completion_tokens
         FROM events
         ORDER BY ts DESC
         LIMIT 10`).all();
	const recentKeyIds = [...new Set(recentRaw.map((r) => r.key_id))];
	const recentLabels = /* @__PURE__ */ new Map();
	if (recentKeyIds.length > 0) {
		const placeholders = recentKeyIds.map(() => "?").join(",");
		const rows = db.query(`SELECT id, label FROM keys WHERE id IN (${placeholders})`).all(...recentKeyIds);
		for (const r of rows) recentLabels.set(r.id, r.label);
	}
	const recent_calls = recentRaw.map((r) => ({
		id: r.id,
		ts: r.ts,
		key_id: r.key_id,
		key_label: recentLabels.get(r.key_id) ?? null,
		model: r.model,
		status: r.status,
		latency_ms: r.latency_ms,
		prompt_tokens: r.prompt_tokens,
		completion_tokens: r.completion_tokens
	}));
	const config = getConfig();
	const system = {
		auth_mode_label: state.authModeLabel ?? (config.features.auth ? "on" : "off (loopback)"),
		bind_address: state.bindAddress ?? "unknown",
		config_version: config.version,
		vscode_version: state.vsCodeVersion ?? null,
		copilot_chat_version: state.copilotChatVersion ?? null
	};
	return c.json({
		kpis,
		series_requests_24h,
		top_models_24h,
		top_keys_24h,
		recent_calls,
		system
	});
});

//#endregion
//#region src/admin/api/settings.ts
const settingsApiRoute = new Hono();
settingsApiRoute.get("/", (c) => {
	return c.json({ config: getConfig() });
});
settingsApiRoute.put("/", async (c) => {
	const session = c.get("session");
	let body;
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}
	const before = getConfig();
	const parsed = ConfigSchema.safeParse(body);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		return c.json({ error: `Validation failed: ${msg}` }, 400);
	}
	parsed.data.features.auth = before.features.auth;
	try {
		saveConfig(parsed.data);
	} catch (err) {
		return c.json({ error: `Save failed: ${String(err)}` }, 400);
	}
	try {
		audit({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "config.update",
			before: { ...before },
			after: { ...parsed.data }
		});
	} catch {}
	return c.json({
		ok: true,
		config: parsed.data
	});
});

//#endregion
//#region src/admin/api/usage.ts
const HOUR_MS$1 = 36e5;
const DAY_MS$1 = 24 * HOUR_MS$1;
const MAX_WINDOW_MS = 90 * DAY_MS$1;
const ALLOWED_RANGES$1 = [
	"1h",
	"24h",
	"7d",
	"30d",
	"custom"
];
function parseRange$1(raw) {
	if (raw && ALLOWED_RANGES$1.includes(raw)) return raw;
	return "24h";
}
function rangeSpanMs$1(range) {
	switch (range) {
		case "1h": return HOUR_MS$1;
		case "24h": return 24 * HOUR_MS$1;
		case "7d": return 7 * DAY_MS$1;
		case "30d": return 30 * DAY_MS$1;
		default: return 24 * HOUR_MS$1;
	}
}
function parseIsoOrEpoch(raw) {
	if (!raw) return null;
	const t = Date.parse(raw);
	if (Number.isFinite(t)) return t;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) ? n : null;
}
function parseFilter$1(c) {
	const range = parseRange$1(c.req.query("range"));
	const now = Date.now();
	let since;
	let until;
	if (range === "custom") {
		const sinceRaw = parseIsoOrEpoch(c.req.query("since"));
		until = parseIsoOrEpoch(c.req.query("until")) ?? now;
		since = sinceRaw ?? until - DAY_MS$1;
		if (since >= until) since = until - HOUR_MS$1;
		if (until - since > MAX_WINDOW_MS) since = until - MAX_WINDOW_MS;
	} else {
		until = now;
		since = until - rangeSpanMs$1(range);
	}
	const key_ids = (c.req.queries("key_id") ?? []).filter((v) => v.length > 0);
	const models = (c.req.queries("model") ?? []).filter((v) => v.length > 0);
	return {
		range,
		since,
		until,
		key_ids,
		models
	};
}
function toDbFilter(f) {
	return {
		since: f.since,
		until: f.until,
		keyIds: f.key_ids.length > 0 ? f.key_ids : void 0,
		models: f.models.length > 0 ? f.models : void 0
	};
}
const usageRoute$1 = new Hono();
usageRoute$1.get("/", (c) => {
	const filter = parseFilter$1(c);
	const dbFilter = toDbFilter(filter);
	const bucket = chooseBucket(dbFilter);
	let rpm = [];
	let tokens = [];
	let latency = [];
	let top_models = [];
	let top_keys_raw = [];
	let errors_by_status = [];
	let error_rates = [];
	let all_models = [];
	try {
		rpm = requestsPerBucket(dbFilter, bucket.bucketMs);
		tokens = tokensPerBucket(dbFilter, bucket.bucketMs);
		latency = latencyPercentiles(dbFilter, bucket.bucketMs);
		top_models = topModelsByRequests(dbFilter, 10);
		top_keys_raw = topKeysByTokens(dbFilter, 10);
		errors_by_status = errorBreakdownByStatus(dbFilter);
		error_rates = errorRateByKey(dbFilter);
		all_models = distinctModels();
	} catch (err) {
		consola.error(`[admin/api/usage] dashboard query failed: ${String(err)}`);
	}
	let totalRequests = 0;
	let totalErrors = 0;
	for (const r of error_rates) {
		totalRequests += r.total;
		totalErrors += r.errors;
	}
	let totalTokens = 0;
	for (const t of tokens) totalTokens += t.prompt_tokens + t.completion_tokens;
	const stats = {
		total_requests: totalRequests,
		total_tokens: totalTokens,
		error_rate: totalRequests === 0 ? 0 : totalErrors / totalRequests,
		errors: totalErrors,
		p95_latency_ms: latency.length === 0 ? null : Math.max(...latency.map((p) => p.p95))
	};
	const db = getDb();
	const labelById = /* @__PURE__ */ new Map();
	const top_key_ids = top_keys_raw.map((k) => k.key_id);
	if (top_key_ids.length > 0) {
		const placeholders = top_key_ids.map(() => "?").join(",");
		const rows = db.query(`SELECT id, label FROM keys WHERE id IN (${placeholders})`).all(...top_key_ids);
		for (const r of rows) labelById.set(r.id, r.label);
	}
	const top_keys = top_keys_raw.map((k) => ({
		key_id: k.key_id,
		label: labelById.get(k.key_id) ?? null,
		tokens: k.tokens,
		requests: error_rates.find((e) => e.key_id === k.key_id)?.total ?? 0
	}));
	const all_keys = listKeys(500, 0).rows.filter((k) => k.revoked_at === null).map((k) => ({
		id: k.id,
		label: k.label
	}));
	return c.json({
		filter,
		stats,
		activity: {
			rpm,
			tokens,
			latency,
			bucket_ms: bucket.bucketMs,
			bucket_label: bucket.label
		},
		top_models,
		top_keys,
		errors_by_status,
		all_keys,
		all_models
	});
});
const CSV_HEADERS$1 = [
	"id",
	"ts",
	"key_id",
	"model",
	"upstream_model",
	"prompt_tokens",
	"completion_tokens",
	"status",
	"latency_ms",
	"error",
	"usage_unknown"
];
const NEEDS_QUOTING$1 = /[",\r\n]/;
const RISKY_LEAD$1 = /^[=+\-@\t\r]/;
function csvField$1(value) {
	if (value === null) return "";
	let s = String(value);
	if (RISKY_LEAD$1.test(s)) s = `'${s}`;
	if (!NEEDS_QUOTING$1.test(s)) return s;
	return `"${s.replaceAll(`"`, `""`)}"`;
}
function eventRowToCsv$1(row) {
	return CSV_HEADERS$1.map((h) => csvField$1(row[h])).join(",");
}
usageRoute$1.get("/export.csv", (c) => {
	const filter = parseFilter$1(c);
	const dbFilter = toDbFilter(filter);
	const tsTag = (/* @__PURE__ */ new Date()).toISOString().replaceAll(/[:.]/g, "-");
	const headerLine = CSV_HEADERS$1.join(",");
	const encoder$1 = new TextEncoder();
	const iter = streamEventsForCsv(dbFilter);
	let wroteHeader = false;
	const stream = new ReadableStream({
		pull(controller) {
			try {
				if (!wroteHeader) {
					controller.enqueue(encoder$1.encode(`${headerLine}\n`));
					wroteHeader = true;
					return;
				}
				const result = iter.next();
				if (result.done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder$1.encode(`${eventRowToCsv$1(result.value)}\n`));
			} catch (err) {
				consola.error(`[admin/api/usage] CSV export pull failed: ${String(err)}`);
				controller.error(err);
				iter.return?.();
			}
		},
		cancel(reason) {
			consola.debug(`[admin/api/usage] CSV export cancelled: ${String(reason ?? "client_disconnect")}`);
			iter.return?.();
		}
	});
	return c.body(stream, 200, {
		"Content-Type": "text/csv; charset=utf-8",
		"Content-Disposition": `attachment; filename="usage-${tsTag}.csv"`,
		"Cache-Control": "no-store"
	});
});

//#endregion
//#region src/admin/api/route.ts
const apiApp = new Hono();
apiApp.route("/me", meRoute);
apiApp.route("/logout", logoutRoute);
apiApp.route("/overview", overviewRoute);
apiApp.route("/keys", keysRoute);
apiApp.route("/usage", usageRoute$1);
apiApp.route("/logs", logsRoute);
apiApp.route("/models", modelsRoute);
apiApp.route("/audit", auditApiRoute);
apiApp.route("/settings", settingsApiRoute);

//#endregion
//#region src/admin/index.tsx
function getDbCounts() {
	const db = getDb();
	const keyRow = db.query("SELECT COUNT(*) as count FROM keys WHERE revoked_at IS NULL").get();
	const sessionRow = db.query("SELECT COUNT(*) as count FROM sessions WHERE expires_at > ?").get(Date.now());
	return {
		keys: keyRow?.count ?? 0,
		activeSessions: sessionRow?.count ?? 0
	};
}
const indexApp = new Hono();
indexApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
indexApp.get("/", (c) => {
	const session = c.get("session");
	const config = getConfig();
	const counts = getDbCounts();
	const keyIdSuffix = session.key_id.slice(-4);
	const debugKeyCount = countActiveDebugKeys();
	const authModeLabel = state.authModeLabel ?? (config.features.auth ? "on" : "off (loopback)");
	const bindAddress = state.bindAddress ?? "unknown";
	return c.html(/* @__PURE__ */ jsxs(Layout, {
		title: "Overview",
		active: "index",
		csrfToken: session.csrf_token,
		debugKeyCount,
		children: [/* @__PURE__ */ jsx("h1", { children: "Overview" }), /* @__PURE__ */ jsxs("div", {
			class: "status-grid",
			children: [
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Config Version" }), /* @__PURE__ */ jsx("dd", { children: config.version })]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Auth Mode" }), /* @__PURE__ */ jsx("dd", { children: authModeLabel })]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Bind Address" }), /* @__PURE__ */ jsx("dd", {
						class: "mono",
						children: bindAddress
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Active Keys" }), /* @__PURE__ */ jsx("dd", { children: counts.keys })]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Active Sessions" }), /* @__PURE__ */ jsx("dd", { children: counts.activeSessions })]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "status-card",
					children: [/* @__PURE__ */ jsx("dt", { children: "Your Key ID (last 4)" }), /* @__PURE__ */ jsxs("dd", {
						class: "mono",
						children: ["…", keyIdSuffix]
					})]
				})
			]
		})]
	}));
});

//#endregion
//#region src/admin/keys/list.tsx
function fmtDate(ms) {
	return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function fmtModels(jsonStr) {
	try {
		return JSON.parse(jsonStr).join(", ");
	} catch {
		return jsonStr;
	}
}
const KeyList = ({ keys, total, page, pageSize, csrfToken }) => {
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const prevPage = page > 1 ? page - 1 : null;
	const nextPage = page < totalPages ? page + 1 : null;
	return /* @__PURE__ */ jsxs("div", {
		class: "keys-list",
		children: [
			/* @__PURE__ */ jsxs("div", {
				class: "keys-list__header",
				children: [/* @__PURE__ */ jsx("h1", { children: "API Keys" }), /* @__PURE__ */ jsx("a", {
					href: "/admin/keys/new",
					class: "btn btn-primary",
					children: "+ New Key"
				})]
			}),
			/* @__PURE__ */ jsxs("p", {
				class: "keys-list__count",
				children: [
					total,
					" key",
					total !== 1 ? "s" : "",
					" total"
				]
			}),
			/* @__PURE__ */ jsx("div", {
				class: "table-wrap",
				children: /* @__PURE__ */ jsxs("table", {
					class: "keys-table",
					children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
						/* @__PURE__ */ jsx("th", { children: "ID (last 8)" }),
						/* @__PURE__ */ jsx("th", { children: "Label" }),
						/* @__PURE__ */ jsx("th", { children: "Tier" }),
						/* @__PURE__ */ jsx("th", { children: "Models" }),
						/* @__PURE__ */ jsx("th", { children: "Rate Limit" }),
						/* @__PURE__ */ jsx("th", { children: "Debug" }),
						/* @__PURE__ */ jsx("th", { children: "Created" }),
						/* @__PURE__ */ jsx("th", { children: "Status" }),
						/* @__PURE__ */ jsx("th", { children: "Actions" })
					] }) }), /* @__PURE__ */ jsx("tbody", { children: keys.map((k) => /* @__PURE__ */ jsx(KeyRow, {
						row: k,
						csrfToken
					}, k.id)) })]
				})
			}),
			/* @__PURE__ */ jsxs("div", {
				class: "pagination",
				children: [
					prevPage !== null && /* @__PURE__ */ jsx("a", {
						href: `/admin/keys?page=${prevPage}`,
						class: "btn btn-sm",
						children: "← Prev"
					}),
					/* @__PURE__ */ jsxs("span", {
						class: "pagination__info",
						children: [
							"Page ",
							page,
							" of ",
							totalPages
						]
					}),
					nextPage !== null && /* @__PURE__ */ jsx("a", {
						href: `/admin/keys?page=${nextPage}`,
						class: "btn btn-sm",
						children: "Next →"
					})
				]
			}),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/keys.js" })
		]
	});
};
const KeyRow = ({ row, csrfToken }) => {
	const isRevoked = row.revoked_at !== null;
	const debugOn = isDebugActive(row);
	const idSuffix = row.id.slice(-8);
	const expiresStr = row.debug_expires_at ? ` (exp ${fmtDate(row.debug_expires_at)})` : "";
	return /* @__PURE__ */ jsxs("tr", {
		class: isRevoked ? "row-revoked" : "",
		children: [
			/* @__PURE__ */ jsx("td", {
				class: "mono",
				title: row.id,
				children: idSuffix
			}),
			/* @__PURE__ */ jsx("td", { children: row.label ?? /* @__PURE__ */ jsx("span", {
				class: "muted",
				children: "—"
			}) }),
			/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("span", {
				class: `badge badge-${row.tier}`,
				children: row.tier
			}) }),
			/* @__PURE__ */ jsx("td", {
				class: "models-cell",
				children: fmtModels(row.allowed_models)
			}),
			/* @__PURE__ */ jsx("td", { children: row.rate_limit_override !== null ? `${row.rate_limit_override}s` : "default" }),
			/* @__PURE__ */ jsx("td", { children: debugOn ? /* @__PURE__ */ jsxs("span", {
				class: "badge badge-debug",
				title: `Debug on${expiresStr}`,
				children: ["ON", expiresStr]
			}) : /* @__PURE__ */ jsx("span", {
				class: "muted",
				children: "off"
			}) }),
			/* @__PURE__ */ jsx("td", { children: fmtDate(row.created_at) }),
			/* @__PURE__ */ jsx("td", { children: isRevoked ? /* @__PURE__ */ jsx("span", {
				class: "badge badge-revoked",
				children: "revoked"
			}) : /* @__PURE__ */ jsx("span", {
				class: "badge badge-active",
				children: "active"
			}) }),
			/* @__PURE__ */ jsxs("td", {
				class: "actions-cell",
				children: [/* @__PURE__ */ jsx("a", {
					href: `/admin/keys/${row.id}`,
					class: "btn btn-sm",
					children: "Edit"
				}), !isRevoked && /* @__PURE__ */ jsxs("form", {
					method: "post",
					action: `/admin/keys/${row.id}/revoke`,
					class: "inline-form",
					"data-confirm": "Revoke this key? This cannot be undone.",
					children: [/* @__PURE__ */ jsx("input", {
						type: "hidden",
						name: "csrf_token",
						value: csrfToken
					}), /* @__PURE__ */ jsx("button", {
						type: "submit",
						class: "btn btn-sm btn-danger",
						children: "Revoke"
					})]
				})]
			})
		]
	});
};

//#endregion
//#region src/admin/keys/detail.tsx
const KeyMeta = ({ row, expiresStr }) => {
	const debugOn = isDebugActive(row);
	return /* @__PURE__ */ jsx("div", {
		class: "key-meta",
		children: /* @__PURE__ */ jsxs("dl", { children: [
			/* @__PURE__ */ jsx("dt", { children: "Full ID" }),
			/* @__PURE__ */ jsx("dd", {
				class: "mono",
				children: row.id
			}),
			/* @__PURE__ */ jsx("dt", { children: "Tier" }),
			/* @__PURE__ */ jsx("dd", { children: /* @__PURE__ */ jsx("span", {
				class: `badge badge-${row.tier}`,
				children: row.tier
			}) }),
			/* @__PURE__ */ jsx("dt", { children: "Created" }),
			/* @__PURE__ */ jsx("dd", { children: fmtDate(row.created_at) }),
			/* @__PURE__ */ jsx("dt", { children: "Models" }),
			/* @__PURE__ */ jsx("dd", { children: fmtModels(row.allowed_models) }),
			/* @__PURE__ */ jsx("dt", { children: "Rate Limit" }),
			/* @__PURE__ */ jsx("dd", { children: row.rate_limit_override !== null ? `${row.rate_limit_override}s` : "default" }),
			/* @__PURE__ */ jsx("dt", { children: "Debug Mode" }),
			/* @__PURE__ */ jsx("dd", { children: debugOn ? /* @__PURE__ */ jsxs("span", {
				class: "badge badge-debug",
				children: ["ON", expiresStr]
			}) : "off" })
		] })
	});
};
function fmtRelativeTs(ts) {
	if (ts === null) return "Never used";
	const ageMs = Date.now() - ts;
	if (ageMs < 6e4) return "just now";
	if (ageMs < 36e5) return `${Math.floor(ageMs / 6e4)}m ago`;
	if (ageMs < 864e5) return `${Math.floor(ageMs / 36e5)}h ago`;
	return `${Math.floor(ageMs / 864e5)}d ago`;
}
const UsageStatRow = ({ label, usage }) => /* @__PURE__ */ jsxs("tr", { children: [
	/* @__PURE__ */ jsx("th", { children: label }),
	/* @__PURE__ */ jsx("td", { children: usage.total_requests }),
	/* @__PURE__ */ jsx("td", { children: usage.total_prompt_tokens }),
	/* @__PURE__ */ jsx("td", { children: usage.total_completion_tokens }),
	/* @__PURE__ */ jsxs("td", { children: [
		(usage.error_rate * 100).toFixed(1),
		"% (",
		usage.errors,
		")"
	] }),
	/* @__PURE__ */ jsx("td", { children: usage.p95_latency_ms !== null ? `${usage.p95_latency_ms} ms` : "—" })
] });
const UsageSection = ({ usage24h, usage7d, usage30d, recent, keyId }) => /* @__PURE__ */ jsxs("section", {
	class: "key-section",
	children: [
		/* @__PURE__ */ jsx("h2", { children: "Usage" }),
		/* @__PURE__ */ jsxs("p", {
			class: "muted",
			children: [
				"Last used: ",
				/* @__PURE__ */ jsx("strong", { children: fmtRelativeTs(usage30d.last_used_ts) }),
				" ",
				"\xA0·\xA0",
				" ",
				/* @__PURE__ */ jsx("a", {
					href: `/admin/usage?range=24h&key_id=${keyId}`,
					children: "Open full dashboard →"
				})
			]
		}),
		/* @__PURE__ */ jsxs("table", {
			class: "usage-stats",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsx("th", { children: "Window" }),
				/* @__PURE__ */ jsx("th", { children: "Requests" }),
				/* @__PURE__ */ jsx("th", { children: "Prompt tokens" }),
				/* @__PURE__ */ jsx("th", { children: "Completion tokens" }),
				/* @__PURE__ */ jsx("th", { children: "Error rate" }),
				/* @__PURE__ */ jsx("th", { children: "p95 latency" })
			] }) }), /* @__PURE__ */ jsxs("tbody", { children: [
				/* @__PURE__ */ jsx(UsageStatRow, {
					label: "24h",
					usage: usage24h
				}),
				/* @__PURE__ */ jsx(UsageStatRow, {
					label: "7d",
					usage: usage7d
				}),
				/* @__PURE__ */ jsx(UsageStatRow, {
					label: "30d",
					usage: usage30d
				})
			] })]
		}),
		recent.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("h3", { children: "Recent calls (newest 20)" }), /* @__PURE__ */ jsxs("table", {
			class: "usage-recent",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsx("th", { children: "Time" }),
				/* @__PURE__ */ jsx("th", { children: "Model" }),
				/* @__PURE__ */ jsx("th", { children: "Status" }),
				/* @__PURE__ */ jsx("th", { children: "Latency" }),
				/* @__PURE__ */ jsx("th", { children: "Tokens (p/c)" }),
				/* @__PURE__ */ jsx("th", { children: "Error" })
			] }) }), /* @__PURE__ */ jsx("tbody", { children: recent.map((r, i) => /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsx("td", { children: fmtDate(r.ts) }),
				/* @__PURE__ */ jsx("td", { children: r.model }),
				/* @__PURE__ */ jsx("td", { children: r.status }),
				/* @__PURE__ */ jsxs("td", { children: [r.latency_ms, " ms"] }),
				/* @__PURE__ */ jsxs("td", { children: [
					r.prompt_tokens ?? "?",
					" / ",
					r.completion_tokens ?? "?"
				] }),
				/* @__PURE__ */ jsx("td", { children: r.error ?? "" })
			] }, i)) })]
		})] }),
		recent.length === 0 && /* @__PURE__ */ jsx("p", {
			class: "muted",
			children: /* @__PURE__ */ jsx("em", { children: "No calls recorded for this key yet." })
		})
	]
});
const EditScopeForm = ({ row, csrfToken, allowedModels, availableAliases }) => {
	const orphans = allowedModels.filter((m) => m !== "*" && !availableAliases.includes(m));
	return /* @__PURE__ */ jsxs("section", {
		class: "key-section",
		children: [/* @__PURE__ */ jsx("h2", { children: "Edit Scope" }), /* @__PURE__ */ jsxs("form", {
			method: "post",
			action: `/admin/keys/${row.id}/scope`,
			children: [
				/* @__PURE__ */ jsx("input", {
					type: "hidden",
					name: "csrf_token",
					value: csrfToken
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "form-field",
					children: [/* @__PURE__ */ jsx("label", { children: "Allowed Models" }), /* @__PURE__ */ jsxs("div", {
						class: "checkbox-group",
						children: [
							/* @__PURE__ */ jsxs("label", {
								class: "checkbox-item",
								children: [/* @__PURE__ */ jsx("input", {
									type: "checkbox",
									name: "allowed_models",
									value: "*",
									checked: allowedModels.includes("*")
								}), /* @__PURE__ */ jsx("span", { children: "* (all models)" })]
							}),
							availableAliases.map((alias) => /* @__PURE__ */ jsxs("label", {
								class: "checkbox-item",
								children: [/* @__PURE__ */ jsx("input", {
									type: "checkbox",
									name: "allowed_models",
									value: alias,
									checked: allowedModels.includes(alias)
								}), /* @__PURE__ */ jsx("span", { children: alias })]
							}, alias)),
							orphans.map((alias) => /* @__PURE__ */ jsxs("label", {
								class: "checkbox-item",
								children: [/* @__PURE__ */ jsx("input", {
									type: "checkbox",
									name: "allowed_models",
									value: alias,
									checked: true
								}), /* @__PURE__ */ jsxs("span", { children: [
									alias,
									" ",
									/* @__PURE__ */ jsx("em", {
										class: "muted",
										children: "(not in config — untick to remove)"
									})
								] })]
							}, alias))
						]
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					class: "form-field",
					children: [/* @__PURE__ */ jsx("label", {
						for: "rate_limit_edit",
						children: "Rate Limit (s, blank = default)"
					}), /* @__PURE__ */ jsx("input", {
						id: "rate_limit_edit",
						type: "number",
						name: "rate_limit_override",
						value: row.rate_limit_override?.toString() ?? "",
						min: "0",
						placeholder: "blank = use server default"
					})]
				}),
				/* @__PURE__ */ jsx("button", {
					type: "submit",
					class: "btn btn-primary",
					children: "Save Scope"
				})
			]
		})]
	});
};
const DebugEnabledControls = ({ row, csrfToken, tracesDays, expiresStr }) => /* @__PURE__ */ jsxs(Fragment, { children: [
	/* @__PURE__ */ jsxs("p", {
		class: "debug-warning",
		children: [
			"Debug is ",
			/* @__PURE__ */ jsx("strong", { children: "ON" }),
			". Traces persist in plaintext. Retention:",
			" ",
			tracesDays,
			" days.",
			expiresStr
		]
	}),
	/* @__PURE__ */ jsxs("form", {
		method: "post",
		action: `/admin/keys/${row.id}/debug`,
		style: "display:inline",
		children: [
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "csrf_token",
				value: csrfToken
			}),
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "debug_enabled",
				value: "0"
			}),
			/* @__PURE__ */ jsx("button", {
				type: "submit",
				class: "btn btn-sm",
				children: "Disable Debug"
			})
		]
	}),
	/* @__PURE__ */ jsxs("form", {
		method: "post",
		action: `/admin/keys/${row.id}/debug`,
		style: "display:inline",
		children: [
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "csrf_token",
				value: csrfToken
			}),
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "action",
				value: "renew"
			}),
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "debug_confirm",
				value: "yes"
			}),
			/* @__PURE__ */ jsx("button", {
				type: "submit",
				class: "btn btn-sm btn-warning",
				children: "Renew 24h TTL"
			})
		]
	})
] });
const DebugDisabledControls = ({ row, csrfToken, tracesDays }) => /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsxs("div", {
	id: "debug-modal",
	class: "modal",
	style: "display:none",
	children: [/* @__PURE__ */ jsx("div", { class: "modal-backdrop" }), /* @__PURE__ */ jsxs("div", {
		class: "modal-box",
		children: [
			/* @__PURE__ */ jsx("h2", { children: "⚠️ Enable Debug Mode?" }),
			/* @__PURE__ */ jsxs("p", { children: [
				"Prompts and responses for this key will be persisted in plaintext at",
				" ",
				/* @__PURE__ */ jsx("code", { children: "~/.local/share/copilot-api/traces/" }),
				"."
			] }),
			/* @__PURE__ */ jsxs("p", { children: [
				/* @__PURE__ */ jsx("strong", { children: "Retention:" }),
				" ",
				tracesDays,
				" days.",
				" ",
				/* @__PURE__ */ jsx("strong", { children: "Auto-disables in 24 hours" }),
				" unless renewed."
			] }),
			/* @__PURE__ */ jsxs("div", {
				class: "modal-actions",
				children: [/* @__PURE__ */ jsx("button", {
					type: "button",
					id: "debug-confirm",
					class: "btn btn-danger",
					children: "I understand — enable debug"
				}), /* @__PURE__ */ jsx("button", {
					type: "button",
					id: "debug-cancel",
					class: "btn",
					children: "Cancel"
				})]
			})
		]
	})]
}), /* @__PURE__ */ jsxs("form", {
	method: "post",
	action: `/admin/keys/${row.id}/debug`,
	id: "debug-form",
	children: [
		/* @__PURE__ */ jsx("input", {
			type: "hidden",
			name: "csrf_token",
			value: csrfToken
		}),
		/* @__PURE__ */ jsx("input", {
			type: "hidden",
			name: "debug_enabled",
			value: "1"
		}),
		/* @__PURE__ */ jsx("input", {
			type: "hidden",
			id: "debug-confirm-field",
			name: "debug_confirm",
			value: ""
		}),
		/* @__PURE__ */ jsx("button", {
			type: "submit",
			id: "debug-btn",
			class: "btn btn-warning",
			children: "Enable Debug (24h)"
		})
	]
})] });
const RevokeSection = ({ row, csrfToken }) => /* @__PURE__ */ jsxs("section", {
	class: "key-section key-section--danger",
	children: [/* @__PURE__ */ jsx("h2", { children: "Danger Zone" }), /* @__PURE__ */ jsxs("form", {
		method: "post",
		action: `/admin/keys/${row.id}/revoke`,
		"data-confirm": "Revoke this key? This cannot be undone.",
		children: [/* @__PURE__ */ jsx("input", {
			type: "hidden",
			name: "csrf_token",
			value: csrfToken
		}), /* @__PURE__ */ jsx("button", {
			type: "submit",
			class: "btn btn-danger",
			children: "Revoke Key"
		})]
	})]
});
const KeyDetail = ({ row, csrfToken, tracesDays, availableAliases, error, success, usage24h, usage7d, usage30d, recent }) => {
	const isRevoked = row.revoked_at !== null;
	const debugOn = isDebugActive(row);
	const idSuffix = row.id.slice(-8);
	const expiresStr = row.debug_expires_at ? ` — auto-disables ${fmtDate(row.debug_expires_at)}` : "";
	let allowedModels = ["*"];
	try {
		allowedModels = JSON.parse(row.allowed_models);
	} catch {}
	return /* @__PURE__ */ jsxs("div", {
		class: "key-detail",
		children: [
			/* @__PURE__ */ jsxs("div", {
				class: "key-detail__header",
				children: [
					/* @__PURE__ */ jsxs("h1", { children: ["Key ", /* @__PURE__ */ jsxs("span", {
						class: "mono",
						children: ["…", idSuffix]
					})] }),
					row.label && /* @__PURE__ */ jsx("p", {
						class: "key-label",
						children: row.label
					}),
					isRevoked && /* @__PURE__ */ jsxs("p", {
						class: "badge badge-revoked badge-lg",
						children: ["Revoked ", fmtDate(row.revoked_at ?? 0)]
					})
				]
			}),
			error && /* @__PURE__ */ jsx("p", {
				class: "form-error",
				children: error
			}),
			success && /* @__PURE__ */ jsx("p", {
				class: "form-success",
				children: success
			}),
			/* @__PURE__ */ jsx(KeyMeta, {
				row,
				expiresStr
			}),
			/* @__PURE__ */ jsx(UsageSection, {
				usage24h,
				usage7d,
				usage30d,
				recent,
				keyId: row.id
			}),
			!isRevoked && /* @__PURE__ */ jsxs(Fragment, { children: [
				/* @__PURE__ */ jsx(EditScopeForm, {
					row,
					csrfToken,
					allowedModels,
					availableAliases
				}),
				/* @__PURE__ */ jsxs("section", {
					class: "key-section",
					children: [/* @__PURE__ */ jsx("h2", { children: "Debug Mode" }), debugOn ? /* @__PURE__ */ jsx(DebugEnabledControls, {
						row,
						csrfToken,
						tracesDays,
						expiresStr
					}) : /* @__PURE__ */ jsx(DebugDisabledControls, {
						row,
						csrfToken,
						tracesDays
					})]
				}),
				/* @__PURE__ */ jsx(RevokeSection, {
					row,
					csrfToken
				})
			] }),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/keys.js" })
		]
	});
};

//#endregion
//#region src/admin/keys/new.tsx
const DebugConfirmModal = ({ tracesDays }) => /* @__PURE__ */ jsxs("div", {
	id: "debug-modal",
	class: "modal",
	style: "display:none",
	children: [/* @__PURE__ */ jsx("div", { class: "modal-backdrop" }), /* @__PURE__ */ jsxs("div", {
		class: "modal-box",
		children: [
			/* @__PURE__ */ jsx("h2", { children: "⚠️ Enable Debug Mode?" }),
			/* @__PURE__ */ jsxs("p", { children: [
				"Prompts and responses for this key will be persisted in plaintext at",
				" ",
				/* @__PURE__ */ jsx("code", { children: "~/.local/share/copilot-api/traces/" }),
				"."
			] }),
			/* @__PURE__ */ jsxs("p", { children: [
				/* @__PURE__ */ jsx("strong", { children: "Retention:" }),
				" ",
				tracesDays,
				" days.",
				" ",
				/* @__PURE__ */ jsx("strong", { children: "Auto-disables in 24 hours" }),
				" unless renewed."
			] }),
			/* @__PURE__ */ jsx("p", { children: "This can expose sensitive information. Only enable for debugging." }),
			/* @__PURE__ */ jsxs("div", {
				class: "modal-actions",
				children: [/* @__PURE__ */ jsx("button", {
					type: "button",
					id: "debug-confirm",
					class: "btn btn-danger",
					children: "I understand — enable debug"
				}), /* @__PURE__ */ jsx("button", {
					type: "button",
					id: "debug-cancel",
					class: "btn",
					children: "Cancel"
				})]
			})
		]
	})]
});
const NewKeyFormFields = ({ modelAliases }) => /* @__PURE__ */ jsxs(Fragment, { children: [
	/* @__PURE__ */ jsxs("div", {
		class: "form-field",
		children: [/* @__PURE__ */ jsx("label", {
			for: "label",
			children: "Label *"
		}), /* @__PURE__ */ jsx("input", {
			id: "label",
			type: "text",
			name: "label",
			placeholder: "e.g. claude-code-laptop",
			required: true,
			maxlength: "200"
		})]
	}),
	/* @__PURE__ */ jsxs("div", {
		class: "form-field",
		children: [/* @__PURE__ */ jsx("label", {
			for: "tier",
			children: "Tier"
		}), /* @__PURE__ */ jsxs("select", {
			id: "tier",
			name: "tier",
			children: [/* @__PURE__ */ jsx("option", {
				value: "client",
				children: "client"
			}), /* @__PURE__ */ jsx("option", {
				value: "admin",
				children: "admin"
			})]
		})]
	}),
	/* @__PURE__ */ jsxs("div", {
		class: "form-field",
		children: [
			/* @__PURE__ */ jsx("label", { children: "Allowed Models" }),
			/* @__PURE__ */ jsxs("div", {
				class: "checkbox-group",
				children: [/* @__PURE__ */ jsxs("label", {
					class: "checkbox-item",
					children: [/* @__PURE__ */ jsx("input", {
						type: "checkbox",
						name: "allowed_models",
						value: "*",
						checked: true
					}), /* @__PURE__ */ jsx("span", { children: "* (all models)" })]
				}), modelAliases.map((alias) => /* @__PURE__ */ jsxs("label", {
					class: "checkbox-item",
					children: [/* @__PURE__ */ jsx("input", {
						type: "checkbox",
						name: "allowed_models",
						value: alias
					}), /* @__PURE__ */ jsx("span", { children: alias })]
				}, alias))]
			}),
			/* @__PURE__ */ jsx("input", {
				type: "hidden",
				name: "allowed_models_present",
				value: "1"
			})
		]
	}),
	/* @__PURE__ */ jsxs("div", {
		class: "form-field",
		children: [/* @__PURE__ */ jsx("label", {
			for: "rate_limit",
			children: "Rate Limit (seconds between requests)"
		}), /* @__PURE__ */ jsx("input", {
			id: "rate_limit",
			type: "number",
			name: "rate_limit_override",
			placeholder: "blank = use server default",
			min: "0"
		})]
	}),
	/* @__PURE__ */ jsxs("div", {
		class: "form-field",
		children: [/* @__PURE__ */ jsxs("label", {
			class: "checkbox-item",
			id: "debug-label",
			children: [/* @__PURE__ */ jsx("input", {
				type: "checkbox",
				name: "debug_enabled",
				id: "debug-checkbox",
				value: "1"
			}), /* @__PURE__ */ jsx("span", { children: "Enable debug mode (persists traces for 24h)" })]
		}), /* @__PURE__ */ jsx("input", {
			type: "hidden",
			id: "debug-confirm-field",
			name: "debug_confirm",
			value: ""
		})]
	})
] });
const NewKeyForm = ({ csrfToken, error, tracesDays }) => {
	const config = getConfig();
	const modelAliases = Object.keys(config.models);
	return /* @__PURE__ */ jsxs("div", {
		class: "new-key-form",
		children: [
			/* @__PURE__ */ jsx("h1", { children: "Create New API Key" }),
			error && /* @__PURE__ */ jsx("p", {
				class: "form-error",
				children: error
			}),
			/* @__PURE__ */ jsx(DebugConfirmModal, { tracesDays }),
			/* @__PURE__ */ jsxs("form", {
				method: "post",
				action: "/admin/keys/new",
				id: "new-key-form",
				children: [
					/* @__PURE__ */ jsx("input", {
						type: "hidden",
						name: "csrf_token",
						value: csrfToken
					}),
					/* @__PURE__ */ jsx(NewKeyFormFields, { modelAliases }),
					/* @__PURE__ */ jsxs("div", {
						class: "form-actions",
						children: [/* @__PURE__ */ jsx("button", {
							type: "submit",
							class: "btn btn-primary",
							children: "Create Key"
						}), /* @__PURE__ */ jsx("a", {
							href: "/admin/keys",
							class: "btn",
							children: "Cancel"
						})]
					})
				]
			}),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/keys.js" })
		]
	});
};
const KeyCreatedBanner = ({ plain, keyId }) => /* @__PURE__ */ jsxs("div", {
	class: "key-created-banner",
	children: [
		/* @__PURE__ */ jsx("h2", { children: "✅ Key Created" }),
		/* @__PURE__ */ jsxs("p", { children: [/* @__PURE__ */ jsx("strong", { children: "Copy this key now." }), " It will never be shown again after you leave this page."] }),
		/* @__PURE__ */ jsxs("div", {
			class: "key-value-row",
			children: [/* @__PURE__ */ jsx("code", {
				id: "plain-key",
				class: "key-value",
				children: plain
			}), /* @__PURE__ */ jsx("button", {
				type: "button",
				id: "copy-btn",
				class: "btn btn-sm",
				children: "Copy"
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "key-gate",
			children: [/* @__PURE__ */ jsxs("label", {
				class: "checkbox-item",
				children: [/* @__PURE__ */ jsx("input", {
					type: "checkbox",
					id: "copied-gate"
				}), /* @__PURE__ */ jsx("span", { children: "I have copied this key and stored it safely" })]
			}), /* @__PURE__ */ jsx("a", {
				href: `/admin/keys/${keyId}`,
				id: "continue-link",
				class: "btn btn-primary",
				style: "pointer-events:none;opacity:0.5",
				children: "Continue to key details →"
			})]
		}),
		/* @__PURE__ */ jsx("script", { src: "/admin/assets/keys.js" })
	]
});

//#endregion
//#region src/admin/keys/route.tsx
const flashStore = /* @__PURE__ */ new Map();
const FLASH_TTL_MS = 300 * 1e3;
function createFlash(plain, keyId) {
	const token = crypto$1.randomUUID();
	flashStore.set(token, {
		plain,
		keyId,
		expires: Date.now() + FLASH_TTL_MS
	});
	const now = Date.now();
	for (const [k, v] of flashStore) if (v.expires < now) flashStore.delete(k);
	return token;
}
function consumeFlash(token) {
	const entry = flashStore.get(token);
	if (!entry) return null;
	flashStore.delete(token);
	if (entry.expires < Date.now()) return null;
	return entry;
}
const PAGE_SIZE = 50;
const MAX_LABEL_LEN = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
* Parse the allowed_models field from a parsed form body.
*
* Behaviour:
* - field absent AND `allowed_models_present` sentinel absent → undefined
*   (caller decides: for /new this becomes the default; for /scope it means
*   "no field, no update").
* - field present (even if empty array) → return the explicit list. An
*   empty list is a privilege-narrowing operation that callers must REJECT
*   rather than widen to "*".
*/
function parseAllowedModels(body) {
	const raw = body["allowed_models"];
	const hasSentinel = typeof body["allowed_models_present"] === "string" && body["allowed_models_present"] === "1";
	let list;
	if (Array.isArray(raw)) list = raw.filter((m) => typeof m === "string");
	else if (typeof raw === "string" && raw.length > 0) list = [raw];
	else list = [];
	return {
		explicit: hasSentinel || list.length > 0,
		models: list
	};
}
function parseIntOrNull(raw) {
	if (!raw || raw.trim() === "") return null;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : null;
}
function parsePageParam(raw) {
	if (!raw) return 1;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 1 ? n : 1;
}
function isUuid(value) {
	return UUID_RE.test(value);
}
/** Best-effort audit: log but never let a failing audit break a mutation. */
function safeAudit(event) {
	try {
		audit(event);
	} catch (err) {
		consola.error(`[admin] audit failed (continuing): ${String(err)}`);
	}
}
const keysApp = new Hono();
keysApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
keysApp.get("/", (c) => {
	const session = c.get("session");
	const page = parsePageParam(c.req.query("page"));
	const offset = (page - 1) * PAGE_SIZE;
	const { rows, total } = listKeys(PAGE_SIZE, offset);
	const debugKeyCount = countActiveDebugKeys();
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Keys",
		active: "keys",
		csrfToken: session.csrf_token,
		debugKeyCount,
		children: /* @__PURE__ */ jsx(KeyList, {
			keys: rows,
			total,
			page,
			pageSize: PAGE_SIZE,
			csrfToken: session.csrf_token
		})
	}));
});
keysApp.get("/new", (c) => {
	const session = c.get("session");
	const config = getConfig();
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "New Key",
		active: "keys",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(NewKeyForm, {
			csrfToken: session.csrf_token,
			tracesDays: config.retention.traces_days
		})
	}));
});
keysApp.post("/new", async (c) => {
	const session = c.get("session");
	const body = await c.req.parseBody({ all: true });
	const config = getConfig();
	const renderErr = (msg) => c.html(/* @__PURE__ */ jsx(Layout, {
		title: "New Key",
		active: "keys",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(NewKeyForm, {
			csrfToken: session.csrf_token,
			tracesDays: config.retention.traces_days,
			error: msg
		})
	}), 400);
	const label = typeof body["label"] === "string" ? body["label"].trim() : "";
	if (!label) return renderErr("Label is required");
	if (label.length > MAX_LABEL_LEN) return renderErr(`Label too long (max ${MAX_LABEL_LEN} chars)`);
	const tier = body["tier"] === "admin" || body["tier"] === "client" ? body["tier"] : "client";
	const { explicit, models } = parseAllowedModels(body);
	if (explicit && models.length === 0) return renderErr("Select at least one allowed model (or '*')");
	const allowedModels = explicit ? models : ["*"];
	const rateLimitOverride = parseIntOrNull(body["rate_limit_override"]) ?? void 0;
	const debugEnabled = body["debug_enabled"] === "1";
	if (debugEnabled && body["debug_confirm"] !== "yes") return renderErr("Debug mode requires explicit confirmation. Re-check the box and confirm the modal.");
	try {
		const { plain, row } = createKey({
			tier,
			label,
			allowedModels,
			rateLimitOverride,
			debugEnabled
		});
		safeAudit({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "key.create",
			target: row.id,
			after: {
				label,
				tier,
				allowed_models: allowedModels,
				rate_limit_override: rateLimitOverride ?? null,
				debug_enabled: debugEnabled
			}
		});
		const flashToken = createFlash(plain, row.id);
		return c.redirect(`/admin/keys/created?flash=${flashToken}`, 303);
	} catch (err) {
		return renderErr(String(err));
	}
});
keysApp.get("/created", (c) => {
	const session = c.get("session");
	const flashToken = c.req.query("flash") ?? "";
	const entry = consumeFlash(flashToken);
	if (!entry) return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Key Lost",
		active: "keys",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsxs("div", {
			class: "form-error",
			children: [
				/* @__PURE__ */ jsx("strong", { children: "Plaintext no longer available." }),
				" The one-time view of this key has been consumed or expired (server may have restarted). Revoke this key and create a new one if you didn't copy it.",
				" ",
				/* @__PURE__ */ jsx("a", {
					href: "/admin/keys",
					children: "Back to keys"
				})
			]
		})
	}), 410);
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Key Created",
		active: "keys",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(KeyCreatedBanner, {
			plain: entry.plain,
			keyId: entry.keyId
		})
	}));
});
keysApp.get("/:id", (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.text("Key not found", 404);
	const row = findKeyById(id);
	if (!row) return c.text("Key not found", 404);
	const config = getConfig();
	const success = c.req.query("success");
	const DAY = 864e5;
	const usage24h = usageForKey(id, DAY);
	const usage7d = usageForKey(id, 7 * DAY);
	const usage30d = usageForKey(id, 30 * DAY);
	const recent = recentCallsForKey(id, 20);
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Key Detail",
		active: "keys",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(KeyDetail, {
			row,
			csrfToken: session.csrf_token,
			tracesDays: config.retention.traces_days,
			availableAliases: Object.keys(config.models),
			success,
			usage24h,
			usage7d,
			usage30d,
			recent
		})
	}));
});
keysApp.post("/:id/revoke", (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.text("Key not found", 404);
	if (!findKeyById(id)) return c.text("Key not found", 404);
	if (revokeKey(id)) safeAudit({
		actor_key_id: session.key_id,
		actor_tier: "admin",
		action: "key.revoke",
		target: id
	});
	return c.redirect(`/admin/keys?success=revoked`, 303);
});
keysApp.post("/:id/scope", async (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.text("Key not found", 404);
	const row = findKeyById(id);
	if (!row) return c.text("Key not found", 404);
	if (row.revoked_at !== null) return c.text("Key is revoked", 400);
	const body = await c.req.parseBody({ all: true });
	const { explicit, models } = parseAllowedModels(body);
	const config = getConfig();
	const renderErr = (msg, status) => {
		const DAY = 864e5;
		return c.html(/* @__PURE__ */ jsx(Layout, {
			title: "Key Detail",
			active: "keys",
			csrfToken: session.csrf_token,
			children: /* @__PURE__ */ jsx(KeyDetail, {
				row: findKeyById(id) ?? row,
				csrfToken: session.csrf_token,
				tracesDays: config.retention.traces_days,
				availableAliases: Object.keys(config.models),
				error: msg,
				usage24h: usageForKey(id, DAY),
				usage7d: usageForKey(id, 7 * DAY),
				usage30d: usageForKey(id, 30 * DAY),
				recent: recentCallsForKey(id, 20)
			})
		}), status);
	};
	if (!explicit) return renderErr("Form did not submit any allowed_models field", 400);
	if (models.length === 0) return renderErr("Select at least one allowed model (or '*')", 400);
	const rateLimitOverride = parseIntOrNull(body["rate_limit_override"]);
	try {
		if (updateKeyScope(id, models, rateLimitOverride)) safeAudit({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "key.scope_update",
			target: id,
			after: {
				allowed_models: models,
				rate_limit_override: rateLimitOverride
			}
		});
		return c.redirect(`/admin/keys/${id}?success=scope_updated`, 303);
	} catch (err) {
		return renderErr(String(err), 400);
	}
});
keysApp.post("/:id/debug", async (c) => {
	const session = c.get("session");
	const id = c.req.param("id");
	if (!isUuid(id)) return c.text("Key not found", 404);
	const row = findKeyById(id);
	if (!row) return c.text("Key not found", 404);
	if (row.revoked_at !== null) return c.text("Key is revoked", 400);
	const body = await c.req.parseBody();
	const action = body["action"];
	const enabledRaw = body["debug_enabled"];
	const confirm = body["debug_confirm"];
	let auditAction;
	if (action === "renew") {
		setDebugEnabled(id, true);
		auditAction = "key.debug_renew";
	} else if (enabledRaw === "1" || enabledRaw === "true") {
		if (confirm !== "yes") return c.text("Debug enable requires explicit confirmation (debug_confirm=yes)", 400);
		setDebugEnabled(id, true);
		auditAction = "key.debug_enable";
	} else {
		setDebugEnabled(id, false);
		auditAction = "key.debug_disable";
	}
	safeAudit({
		actor_key_id: session.key_id,
		actor_tier: "admin",
		action: auditAction,
		target: id
	});
	return c.redirect(`/admin/keys/${id}?success=debug_updated`, 303);
});

//#endregion
//#region src/admin/login.tsx
const loginApp = new Hono();
loginApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
function errorMessage(error) {
	if (error === "invalid") return "Invalid or insufficient key. Admin keys only.";
	if (error === "missing") return "Please enter your admin API key.";
}
loginApp.get("/", (c) => {
	const errorMsg = errorMessage(c.req.query("error"));
	return c.html(/* @__PURE__ */ jsx(LoginLayout, { children: /* @__PURE__ */ jsxs("div", {
		class: "login-card",
		children: [
			/* @__PURE__ */ jsx("h1", { children: "Admin Login" }),
			/* @__PURE__ */ jsx("p", {
				class: "login-hint",
				children: "Paste an admin-tier API key to continue."
			}),
			errorMsg && /* @__PURE__ */ jsx("p", {
				class: "login-error",
				children: errorMsg
			}),
			/* @__PURE__ */ jsxs("form", {
				method: "post",
				action: "/admin/login",
				children: [
					/* @__PURE__ */ jsx("label", {
						for: "key",
						children: "API Key"
					}),
					/* @__PURE__ */ jsx("input", {
						id: "key",
						type: "password",
						name: "key",
						placeholder: "sk-cap-…",
						autocomplete: "current-password",
						required: true
					}),
					/* @__PURE__ */ jsx("button", {
						type: "submit",
						children: "Login"
					})
				]
			})
		]
	}) }));
});
loginApp.post("/", async (c) => {
	const body = await c.req.parseBody();
	const key = typeof body["key"] === "string" ? body["key"].trim() : "";
	if (!key) return c.redirect("/admin/login?error=missing", 303);
	const hash = crypto$1.createHash("sha256").update(key).digest("hex");
	const keyRecord = findKeyByHash(hash);
	if (!keyRecord || keyRecord.revoked_at !== null || keyRecord.tier !== "admin") return c.redirect("/admin/login?error=invalid", 303);
	getDb().run("DELETE FROM sessions WHERE key_id = ?", [keyRecord.id]);
	const session = createSession(keyRecord.id);
	const csrfToken = generateCsrfToken(session.id);
	const headers = new Headers();
	headers.append("Set-Cookie", sessionCookieValue(session.id));
	headers.append("Set-Cookie", csrfCookieValue(csrfToken));
	headers.set("Location", "/admin");
	return new Response(null, {
		status: 303,
		headers
	});
});

//#endregion
//#region src/admin/session-middleware.ts
const LOOPBACK_RE = /^(?:127\.\d+\.\d+\.\d+|::1|localhost)$/;
/**
* Constant-time string equality. Used to compare CSRF tokens against the
* canonical value stored in the sessions table so a server restart doesn't
* force users to re-login (the HMAC secret changes across processes but
* the DB token does not).
*/
function constantTimeEq(a, b) {
	if (a.length !== b.length) return false;
	try {
		return crypto$1.timingSafeEqual(Buffer.from(a), Buffer.from(b));
	} catch {
		return false;
	}
}
function stripBracketsAndPort(host) {
	const ipv6Match = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
	if (ipv6Match) return ipv6Match[1];
	const colonIdx = host.lastIndexOf(":");
	return colonIdx === -1 ? host : host.slice(0, colonIdx);
}
function isLoopback(hostOrHostname) {
	const bare = hostOrHostname.replaceAll(/^\[|\]$/g, "");
	return LOOPBACK_RE.test(bare);
}
/**
* Returns true when the request is safe to serve:
* - over HTTPS (regardless of host), or
* - over HTTP but only from a loopback address, or
* - the operator has explicitly opted into plain HTTP via the
*   `ADMIN_INSECURE_HTTP=true` env var (LAN-only convenience for
*   self-hosted setups behind a trusted network — session cookies travel
*   in the clear and CAN be sniffed; never expose to the open internet).
*
* X-Forwarded-Proto is only consulted when the TRUST_PROXY env var is set to
* "true". Without that flag, any client could forge the header and bypass the
* HTTPS requirement.
*/
function isRequestAllowed(c) {
	if (process.env.ADMIN_INSECURE_HTTP === "true") return true;
	const trustProxy = process.env.TRUST_PROXY === "true";
	const proto = c.req.header("x-forwarded-proto") ?? "";
	const host = c.req.header("host") ?? "";
	const url = new URL(c.req.url);
	if (trustProxy && proto === "https" || url.protocol === "https:") return true;
	const hostNoPort = stripBracketsAndPort(host);
	return isLoopback(hostNoPort) || isLoopback(url.hostname);
}
const sessionMiddleware = async (c, next) => {
	if (!isRequestAllowed(c)) return c.text("HTTPS required for non-loopback access", 403);
	const cookieHeader = c.req.header("cookie");
	const sessionId = extractSessionId(cookieHeader);
	const isJsonApi = c.req.path.startsWith("/admin/api/");
	if (!sessionId) {
		if (isJsonApi) return c.json({ error: "Not authenticated" }, 401);
		return c.redirect("/admin/login", 302);
	}
	const method = c.req.method.toUpperCase();
	if (method !== "GET" && method !== "HEAD") {
		const fetchSite = c.req.header("sec-fetch-site");
		const tokenHeader = c.req.header(CSRF_HEADER);
		const tokenCookie = extractCsrfCookie(cookieHeader);
		if (!(process.env.ADMIN_INSECURE_HTTP === "true") && fetchSite !== "same-origin") {
			consola.warn("[admin] CSRF: Sec-Fetch-Site must be same-origin");
			return c.json({ error: "CSRF: Sec-Fetch-Site must be same-origin" }, 403);
		}
		const tokenBody = await extractCsrfBody(c);
		const effectiveToken = tokenHeader ?? tokenBody;
		if (!effectiveToken || !tokenCookie) {
			consola.warn("[admin] CSRF: missing token");
			return c.json({ error: "CSRF: missing token" }, 403);
		}
		const dbToken = getSession(sessionId)?.csrf_token;
		const matchesHmac = verifyCsrfToken(sessionId, effectiveToken) && verifyCsrfToken(sessionId, tokenCookie);
		const matchesDb = dbToken !== void 0 && constantTimeEq(effectiveToken, dbToken) && constantTimeEq(tokenCookie, dbToken);
		if (!matchesHmac && !matchesDb) {
			consola.warn("[admin] CSRF: token mismatch");
			return c.json({ error: "CSRF: token mismatch" }, 403);
		}
	}
	const session = getSession(sessionId);
	if (!session) {
		const headers = new Headers();
		headers.set("Set-Cookie", clearSessionCookieValue());
		if (isJsonApi) {
			headers.set("Content-Type", "application/json");
			return new Response(JSON.stringify({ error: "Session expired" }), {
				status: 401,
				headers
			});
		}
		headers.set("Location", "/admin/login");
		return new Response(null, {
			status: 302,
			headers
		});
	}
	c.set("session", session);
	await next();
	c.res.headers.append("Set-Cookie", sessionCookieValue(session.id));
};
/**
* Defense-in-depth guard: re-verify the underlying key is still admin-tier
* and not revoked, on every request to a session-protected admin route.
*
* The login flow already rejects non-admin keys (src/admin/login.tsx), so the
* only way to obtain a session is to authenticate as admin.  This middleware
* protects against a regression in that flow, AND against the case where the
* key is revoked after the session is created (in which case the session
* must be terminated and the user redirected to login).
*/
const requireAdminSession = async (c, next) => {
	const session = c.get("session");
	const { findKeyById: findKeyById$1 } = await import("./keys-BipyZOMr.js");
	const key = findKeyById$1(session.key_id);
	if (!key || key.revoked_at !== null || key.tier !== "admin") {
		deleteSession(session.id);
		const headers = new Headers();
		headers.set("Set-Cookie", clearSessionCookieValue());
		if (c.req.path.startsWith("/admin/api/")) {
			headers.set("Content-Type", "application/json");
			return new Response(JSON.stringify({ error: "Key revoked" }), {
				status: 401,
				headers
			});
		}
		headers.set("Location", "/admin/login");
		return new Response(null, {
			status: 302,
			headers
		});
	}
	await next();
};
/** Try to read a CSRF token from an application/x-www-form-urlencoded body.
*
* Important: we parse with `{ all: true }` so multi-value form fields
* (e.g. allowed_models checkboxes) come back as arrays. Hono caches the
* parsed body on the request object, and the FIRST call's options win — if
* we used the default (all=false), downstream handlers would see flattened
* single-value fields no matter what they request later. (See keys/route.tsx
* scope edit for the affected handler.)
*/
async function extractCsrfBody(c) {
	if (!(c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded")) return void 0;
	try {
		const val = (await c.req.parseBody({ all: true }))["csrf_token"];
		if (typeof val === "string") return val;
		if (Array.isArray(val) && typeof val[0] === "string") return val[0];
		return;
	} catch {
		return;
	}
}
const sessionApp = new Hono();
sessionApp.post("/logout", (c) => {
	const cookieHeader = c.req.header("cookie");
	const sessionId = extractSessionId(cookieHeader);
	if (sessionId) deleteSession(sessionId);
	const headers = new Headers({ Location: "/admin/login" });
	headers.set("Set-Cookie", clearSessionCookieValue());
	return new Response(null, {
		status: 303,
		headers
	});
});

//#endregion
//#region src/admin/settings/page.tsx
const SettingsPage = ({ config, csrfToken, error, success }) => /* @__PURE__ */ jsxs("div", {
	class: "settings-page",
	children: [
		/* @__PURE__ */ jsx("h1", { children: "Settings" }),
		error && /* @__PURE__ */ jsx("p", {
			class: "form-error",
			children: error
		}),
		success && /* @__PURE__ */ jsx("p", {
			class: "form-success",
			children: success
		}),
		/* @__PURE__ */ jsxs("p", {
			class: "muted",
			children: [
				"Edits are written atomically to",
				" ",
				/* @__PURE__ */ jsx("code", { children: "~/.local/share/copilot-api/config.json" }),
				" and hot-reloaded on the next request. Authentication state is intentionally not editable from this page — change it via CLI flags or by editing the file directly."
			]
		}),
		/* @__PURE__ */ jsxs("form", {
			method: "post",
			action: "/admin/settings",
			id: "settings-form",
			class: "settings-form",
			children: [
				/* @__PURE__ */ jsx("input", {
					type: "hidden",
					name: "csrf_token",
					value: csrfToken
				}),
				/* @__PURE__ */ jsx(ModelsSection, { models: config.models }),
				/* @__PURE__ */ jsx(RetentionSection, { retention: config.retention }),
				/* @__PURE__ */ jsx(FeaturesSection, { features: config.features }),
				/* @__PURE__ */ jsxs("div", {
					class: "form-actions",
					children: [/* @__PURE__ */ jsx("button", {
						type: "submit",
						class: "btn btn-primary",
						children: "Save Settings"
					}), /* @__PURE__ */ jsx("a", {
						href: "/admin",
						class: "btn",
						children: "Cancel"
					})]
				})
			]
		})
	]
});
const ModelsSection = ({ models }) => /* @__PURE__ */ jsxs("section", {
	class: "settings-section",
	children: [
		/* @__PURE__ */ jsx("h2", { children: "Model Aliases" }),
		/* @__PURE__ */ jsxs("p", {
			class: "muted",
			children: [
				"Map a user-facing alias to an upstream Copilot model id. Set",
				/* @__PURE__ */ jsx("code", { children: " enabled=false" }),
				" to hide an alias from ",
				/* @__PURE__ */ jsx("code", { children: "/v1/models" }),
				"."
			]
		}),
		/* @__PURE__ */ jsxs("table", {
			class: "settings-table",
			children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
				/* @__PURE__ */ jsx("th", { children: "Alias" }),
				/* @__PURE__ */ jsx("th", { children: "Upstream" }),
				/* @__PURE__ */ jsx("th", { children: "Enabled" }),
				/* @__PURE__ */ jsx("th", {})
			] }) }), /* @__PURE__ */ jsxs("tbody", {
				id: "models-tbody",
				children: [Object.entries(models).map(([alias, entry], i) => /* @__PURE__ */ jsx(ModelRow, {
					index: i,
					alias,
					entry
				}, alias)), /* @__PURE__ */ jsx(ModelRow, {
					index: Object.keys(models).length,
					alias: "",
					entry: {
						upstream: "",
						enabled: true,
						allowed_keys: ["*"]
					}
				})]
			})]
		}),
		/* @__PURE__ */ jsx("p", {
			class: "muted",
			children: /* @__PURE__ */ jsx("em", { children: "Tip: leave alias blank to delete that row when you save. Add a new row by filling the empty trailing row." })
		})
	]
});
const RetentionSection = ({ retention }) => /* @__PURE__ */ jsxs("section", {
	class: "settings-section",
	children: [/* @__PURE__ */ jsx("h2", { children: "Retention" }), /* @__PURE__ */ jsxs("div", {
		class: "form-grid",
		children: [
			/* @__PURE__ */ jsxs("label", { children: [
				/* @__PURE__ */ jsx("span", { children: "events_days" }),
				/* @__PURE__ */ jsx("input", {
					type: "number",
					name: "retention_events_days",
					min: "0",
					value: String(retention.events_days)
				}),
				/* @__PURE__ */ jsx("small", {
					class: "muted",
					children: "Telemetry rows older than this are deleted hourly."
				})
			] }),
			/* @__PURE__ */ jsxs("label", { children: [
				/* @__PURE__ */ jsx("span", { children: "traces_days" }),
				/* @__PURE__ */ jsx("input", {
					type: "number",
					name: "retention_traces_days",
					min: "0",
					value: String(retention.traces_days)
				}),
				/* @__PURE__ */ jsxs("small", {
					class: "muted",
					children: [/* @__PURE__ */ jsx("strong", { children: "0 = in-memory only" }), " (live tail works, nothing on disk). Set > 0 to opt into on-disk persistence."]
				})
			] }),
			/* @__PURE__ */ jsxs("label", { children: [
				/* @__PURE__ */ jsx("span", { children: "traces_max_bytes" }),
				/* @__PURE__ */ jsx("input", {
					type: "number",
					name: "retention_traces_max_bytes",
					min: "0",
					value: String(retention.traces_max_bytes)
				}),
				/* @__PURE__ */ jsx("small", {
					class: "muted",
					children: "Hard cap on total bytes of trace JSONL files. Oldest day evicted when exceeded."
				})
			] }),
			/* @__PURE__ */ jsxs("label", { children: [
				/* @__PURE__ */ jsx("span", { children: "audit_days" }),
				/* @__PURE__ */ jsx("input", {
					type: "number",
					name: "retention_audit_days",
					min: "0",
					value: String(retention.audit_days)
				}),
				/* @__PURE__ */ jsx("small", {
					class: "muted",
					children: "Audit JSONL retention."
				})
			] })
		]
	})]
});
const FeaturesSection = ({ features }) => /* @__PURE__ */ jsxs("section", {
	class: "settings-section",
	children: [
		/* @__PURE__ */ jsx("h2", { children: "Features" }),
		/* @__PURE__ */ jsxs("div", {
			class: "form-grid",
			children: [/* @__PURE__ */ jsxs("label", {
				class: "checkbox-item",
				children: [/* @__PURE__ */ jsx("input", {
					type: "checkbox",
					name: "features_telemetry",
					value: "1",
					checked: features.telemetry
				}), /* @__PURE__ */ jsx("span", { children: "Telemetry (placeholder, currently unused)" })]
			}), /* @__PURE__ */ jsxs("label", {
				class: "checkbox-item",
				children: [/* @__PURE__ */ jsx("input", {
					type: "checkbox",
					name: "features_debug",
					value: "1",
					checked: features.debug
				}), /* @__PURE__ */ jsx("span", { children: "Debug (placeholder, currently unused)" })]
			})]
		}),
		/* @__PURE__ */ jsxs("p", {
			class: "muted",
			children: [
				"Auth (",
				/* @__PURE__ */ jsx("code", { children: "features.auth" }),
				") is intentionally not editable here. To disable authentication, restart with ",
				/* @__PURE__ */ jsx("code", { children: "--no-auth" }),
				" (loopback only) or set ",
				/* @__PURE__ */ jsx("code", { children: "features.auth=false" }),
				" in config.json directly. See",
				" ",
				/* @__PURE__ */ jsx("code", { children: "--i-accept-account-suspension-risk" }),
				" for non-loopback exposure."
			]
		})
	]
});
const ModelRow = ({ index, alias, entry }) => /* @__PURE__ */ jsxs("tr", { children: [
	/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("input", {
		type: "text",
		name: `model_${index}_alias`,
		value: alias,
		placeholder: "(leave blank to skip)",
		maxlength: "100"
	}) }),
	/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("input", {
		type: "text",
		name: `model_${index}_upstream`,
		value: entry.upstream,
		placeholder: "claude-sonnet-4.5",
		maxlength: "200"
	}) }),
	/* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx("input", {
		type: "checkbox",
		name: `model_${index}_enabled`,
		value: "1",
		checked: entry.enabled !== false
	}) }),
	/* @__PURE__ */ jsx("td", {})
] });

//#endregion
//#region src/admin/settings/route.tsx
const settingsApp = new Hono();
settingsApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
settingsApp.get("/", (c) => {
	const session = c.get("session");
	const success = c.req.query("success");
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Settings",
		active: "settings",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(SettingsPage, {
			config: getConfig(),
			csrfToken: session.csrf_token,
			success: success === "1" ? "Settings saved" : void 0
		})
	}));
});
settingsApp.post("/", async (c) => {
	const session = c.get("session");
	const body = await c.req.parseBody({ all: true });
	const before = getConfig();
	const candidate = buildCandidate(body, before);
	const parsed = ConfigSchema.safeParse(candidate);
	if (!parsed.success) {
		const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
		return renderSettingsError(c, session, `Validation failed: ${msg}`);
	}
	parsed.data.features.auth = before.features.auth;
	try {
		saveConfig(parsed.data);
	} catch (err) {
		return renderSettingsError(c, session, `Save failed: ${String(err)}`);
	}
	try {
		audit({
			actor_key_id: session.key_id,
			actor_tier: "admin",
			action: "config.update",
			before: { ...before },
			after: { ...parsed.data }
		});
	} catch {}
	return c.redirect("/admin/settings?success=1", 303);
});
function renderSettingsError(c, session, msg) {
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Settings",
		active: "settings",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(SettingsPage, {
			config: getConfig(),
			csrfToken: session.csrf_token,
			error: msg
		})
	}), 400);
}
const MAX_MODEL_ROWS = 100;
function buildCandidate(body, before) {
	const models = {};
	for (let i = 0; i < MAX_MODEL_ROWS; i++) {
		const alias = strField(body, `model_${i}_alias`);
		const upstream = strField(body, `model_${i}_upstream`);
		if (alias === void 0 && upstream === void 0) continue;
		if (!alias || !upstream) continue;
		const enabled = body[`model_${i}_enabled`] === "1";
		const allowed_keys = before.models[alias]?.allowed_keys ?? ["*"];
		models[alias] = {
			upstream,
			enabled,
			allowed_keys
		};
	}
	return {
		version: 1,
		models,
		retention: {
			events_days: intField(body, "retention_events_days", 90),
			traces_days: intField(body, "retention_traces_days", 0),
			traces_max_bytes: intField(body, "retention_traces_max_bytes", 104857600),
			audit_days: intField(body, "retention_audit_days", 365)
		},
		features: {
			auth: before.features.auth,
			telemetry: body["features_telemetry"] === "1",
			debug: body["features_debug"] === "1"
		}
	};
}
function strField(body, name) {
	const v = body[name];
	if (typeof v !== "string") return void 0;
	return v.trim();
}
function intField(body, name, fallback) {
	const v = body[name];
	if (typeof v !== "string") return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

//#endregion
//#region src/services/trace-broadcaster.ts
const HEARTBEAT_MS = 15e3;
const QUEUE_BYTES_CAP = 1 * 1024 * 1024;
const MAX_SUBSCRIBERS = 4;
const RING_SIZE = 100;
const subscribers = /* @__PURE__ */ new Set();
const ring = [];
let monotonicId = 0;
const encoder = new TextEncoder();
const PLACEHOLDER_CONTROLLER = {
	desiredSize: 0,
	close() {},
	enqueue() {},
	error() {}
};
function sseFrame(id, line) {
	const data = line.endsWith("\n") ? line.slice(0, -1) : line;
	return encoder.encode(`id: ${id}\ndata: ${data}\n\n`);
}
function heartbeatFrame() {
	return encoder.encode(`: ping\n\n`);
}
function flushQueue(sub) {
	if (sub.closed) return;
	if (sub.pending) return;
	while (sub.queue.length > 0) {
		const item = sub.queue.shift();
		if (!item) break;
		sub.queueBytes -= item.bytes.byteLength;
		try {
			sub.controller.enqueue(item.bytes);
		} catch {
			closeSubscriber(sub);
			return;
		}
	}
}
function pushToSubscriber(sub, id, bytes) {
	while (sub.queue.length > 0 && sub.queueBytes + bytes.byteLength > QUEUE_BYTES_CAP) {
		const dropped = sub.queue.shift();
		if (!dropped) break;
		sub.queueBytes -= dropped.bytes.byteLength;
	}
	if (bytes.byteLength > QUEUE_BYTES_CAP) consola.warn(`[trace-broadcaster] frame ${bytes.byteLength}B exceeds queue cap ${QUEUE_BYTES_CAP}B`);
	sub.queue.push({
		id,
		bytes
	});
	sub.queueBytes += bytes.byteLength;
	flushQueue(sub);
}
function closeSubscriber(sub) {
	if (sub.closed) return;
	sub.closed = true;
	if (sub.heartbeat) {
		clearInterval(sub.heartbeat);
		sub.heartbeat = null;
	}
	subscribers.delete(sub);
	try {
		sub.controller.close();
	} catch {}
}
/**
* Push a redacted trace line to every active subscriber and append it to
* the replay ring. The caller (trace-writer) is responsible for ensuring
* the line has already been redacted AND asserted clean.
*/
function broadcastTrace(line) {
	const id = ++monotonicId;
	ring.push({
		id,
		line
	});
	while (ring.length > RING_SIZE) ring.shift();
	const bytes = sseFrame(id, line);
	for (const sub of subscribers) pushToSubscriber(sub, id, bytes);
}
/**
* Subscribe to live trace events.
*
* Returns a ReadableStream that emits SSE-framed lines plus a periodic
* heartbeat. When the downstream client cancels, the heartbeat is cleared
* and the subscriber is removed.
*
* `lastEventId` (parsed from the request's Last-Event-ID header) lets
* reconnecting clients replay anything still in the ring with id >
* lastEventId.
*
* Rejects with `ok: false` once MAX_SUBSCRIBERS are already attached —
* callers should turn this into an HTTP 503.
*/
function subscribe(opts = {}) {
	if (subscribers.size >= MAX_SUBSCRIBERS) return {
		ok: false,
		reason: "too_many_subscribers"
	};
	const sub = {
		controller: PLACEHOLDER_CONTROLLER,
		queue: [],
		queueBytes: 0,
		pending: false,
		heartbeat: null,
		closed: false
	};
	subscribers.add(sub);
	return {
		ok: true,
		stream: new ReadableStream({
			start(controller) {
				sub.controller = controller;
				if (opts.lastEventId !== void 0) {
					for (const entry of ring) if (entry.id > opts.lastEventId) pushToSubscriber(sub, entry.id, sseFrame(entry.id, entry.line));
				}
				try {
					controller.enqueue(encoder.encode(`retry: 10000\n\n`));
					controller.enqueue(heartbeatFrame());
				} catch {
					closeSubscriber(sub);
					return;
				}
				sub.heartbeat = setInterval(() => {
					if (sub.closed) return;
					try {
						sub.controller.enqueue(heartbeatFrame());
					} catch {
						closeSubscriber(sub);
					}
				}, HEARTBEAT_MS);
			},
			cancel() {
				closeSubscriber(sub);
			}
		})
	};
}

//#endregion
//#region src/admin/traces/route.tsx
const tracesApp = new Hono();
tracesApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
tracesApp.get("/", (c) => {
	const session = c.get("session");
	return c.html(/* @__PURE__ */ jsxs(Layout, {
		title: "Traces",
		active: "traces",
		csrfToken: session.csrf_token,
		children: [
			/* @__PURE__ */ jsx("h1", { children: "Debug capture — live tail" }),
			/* @__PURE__ */ jsxs("p", {
				class: "text-muted",
				children: [
					"Streaming redacted trace events from /admin/traces/stream. Capture is only active for keys with debug mode enabled (see",
					" ",
					/* @__PURE__ */ jsx("a", {
						href: "/admin/keys",
						children: "Keys"
					}),
					")."
				]
			}),
			/* @__PURE__ */ jsx("pre", {
				id: "trace-log",
				class: "trace-log",
				"aria-live": "polite"
			}),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/traces.js" })
		]
	}));
});
tracesApp.get("/stream", (c) => {
	const lastEventIdHeader = c.req.header("last-event-id");
	let lastEventId;
	if (lastEventIdHeader !== void 0) {
		const n = Number.parseInt(lastEventIdHeader, 10);
		if (Number.isFinite(n) && n >= 0) lastEventId = n;
	}
	const result = subscribe({ lastEventId });
	if (!result.ok) return c.json({ error: "Too many concurrent SSE subscribers; try again later" }, 503);
	return c.body(result.stream, 200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Accel-Buffering": "no",
		Connection: "keep-alive"
	});
});
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
* Wrap a Node Readable into a Web ReadableStream so Hono can pipe it back
* without blocking the event loop. fs.createReadStream streams bytes in
* 64 KB chunks and respects backpressure via `pause()`/`resume()` which the
* adapter triggers from the ReadableStream pull/cancel callbacks.
*/
function nodeStreamToWeb(filePath) {
	const nodeStream = fs$1.createReadStream(filePath, { highWaterMark: 64 * 1024 });
	return new ReadableStream({
		start(controller) {
			nodeStream.on("data", (chunk) => {
				const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				controller.enqueue(bytes);
				if ((controller.desiredSize ?? 0) <= 0) nodeStream.pause();
			});
			nodeStream.on("end", () => {
				controller.close();
			});
			nodeStream.on("error", (err) => {
				controller.error(err);
			});
		},
		pull() {
			nodeStream.resume();
		},
		cancel(reason) {
			consola.debug(`[admin/traces] download cancelled: ${String(reason ?? "client_disconnect")}`);
			nodeStream.destroy();
		}
	});
}
tracesApp.get("/:filename", (c) => {
	const filename = c.req.param("filename");
	if (!filename.endsWith(".jsonl")) return c.text("Not Found", 404);
	const date = filename.slice(0, -6);
	if (!DATE_RE.test(date)) return c.text("Bad Request", 400);
	const base = tracesDir();
	const baseWithSep = base + path.sep;
	const fullPath = path.join(base, `traces-${date}.jsonl`);
	if (!fullPath.startsWith(baseWithSep)) {
		consola.warn(`[admin/traces] rejected path-traversal attempt: ${filename}`);
		return c.text("Bad Request", 400);
	}
	let resolved;
	try {
		resolved = fs$1.realpathSync.native(fullPath);
	} catch (err) {
		if (err.code === "ENOENT") return c.text("Not Found", 404);
		consola.warn(`[admin/traces] realpath failed for ${filename}: ${String(err)}`);
		return c.text("Bad Request", 400);
	}
	if (!resolved.startsWith(baseWithSep)) {
		consola.warn(`[admin/traces] rejected symlink escape: ${filename} → ${resolved}`);
		return c.text("Bad Request", 400);
	}
	const stream = nodeStreamToWeb(resolved);
	return c.body(stream, 200, {
		"Content-Type": "application/x-ndjson; charset=utf-8",
		"Content-Disposition": `attachment; filename="traces-${date}.jsonl"`,
		"Cache-Control": "no-store"
	});
});

//#endregion
//#region src/admin/usage/page.tsx
const RANGE_OPTIONS = [
	{
		value: "1h",
		label: "Last 1 hour"
	},
	{
		value: "24h",
		label: "Last 24 hours"
	},
	{
		value: "7d",
		label: "Last 7 days"
	},
	{
		value: "30d",
		label: "Last 30 days"
	},
	{
		value: "custom",
		label: "Custom"
	}
];
function fmtIsoLocal(ms) {
	return new Date(ms).toISOString().slice(0, 16);
}
const FilterForm = ({ filter, allKeys, allModels }) => /* @__PURE__ */ jsxs("form", {
	method: "get",
	action: "/admin/usage",
	class: "usage-filter",
	children: [
		/* @__PURE__ */ jsxs("div", {
			class: "form-field",
			children: [/* @__PURE__ */ jsx("label", {
				for: "range",
				children: "Range"
			}), /* @__PURE__ */ jsx("select", {
				id: "range",
				name: "range",
				children: RANGE_OPTIONS.map((opt) => /* @__PURE__ */ jsx("option", {
					value: opt.value,
					selected: filter.range === opt.value,
					children: opt.label
				}, opt.value))
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "form-field",
			children: [/* @__PURE__ */ jsx("label", {
				for: "since",
				children: "Since (UTC)"
			}), /* @__PURE__ */ jsx("input", {
				id: "since",
				type: "datetime-local",
				name: "since",
				value: fmtIsoLocal(filter.since)
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "form-field",
			children: [/* @__PURE__ */ jsx("label", {
				for: "until",
				children: "Until (UTC)"
			}), /* @__PURE__ */ jsx("input", {
				id: "until",
				type: "datetime-local",
				name: "until",
				value: fmtIsoLocal(filter.until)
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "form-field",
			children: [/* @__PURE__ */ jsx("label", {
				for: "keys",
				children: "Keys"
			}), /* @__PURE__ */ jsx("select", {
				id: "keys",
				name: "key_id",
				multiple: true,
				size: "4",
				children: allKeys.map((k) => /* @__PURE__ */ jsx("option", {
					value: k.id,
					selected: filter.keyIds.includes(k.id),
					children: k.label ?? k.id.slice(-8)
				}, k.id))
			})]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "form-field",
			children: [/* @__PURE__ */ jsx("label", {
				for: "models",
				children: "Models"
			}), /* @__PURE__ */ jsx("select", {
				id: "models",
				name: "model",
				multiple: true,
				size: "4",
				children: allModels.map((m) => /* @__PURE__ */ jsx("option", {
					value: m,
					selected: filter.models.includes(m),
					children: m
				}, m))
			})]
		}),
		/* @__PURE__ */ jsx("div", {
			class: "form-actions",
			children: /* @__PURE__ */ jsx("button", {
				type: "submit",
				class: "btn btn-primary",
				children: "Apply"
			})
		})
	]
});
const StatsRow = ({ stats }) => /* @__PURE__ */ jsxs("div", {
	class: "status-grid",
	children: [
		/* @__PURE__ */ jsxs("div", {
			class: "status-card",
			children: [/* @__PURE__ */ jsx("dt", { children: "Total Requests" }), /* @__PURE__ */ jsx("dd", { children: stats.totalRequests.toLocaleString() })]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "status-card",
			children: [/* @__PURE__ */ jsx("dt", { children: "Total Tokens" }), /* @__PURE__ */ jsx("dd", { children: stats.totalTokens.toLocaleString() })]
		}),
		/* @__PURE__ */ jsxs("div", {
			class: "status-card",
			children: [/* @__PURE__ */ jsx("dt", { children: "Error Rate" }), /* @__PURE__ */ jsxs("dd", { children: [(stats.errorRate * 100).toFixed(2), "%"] })]
		})
	]
});
const ChartContainers = () => /* @__PURE__ */ jsxs("div", {
	class: "usage-charts",
	children: [
		/* @__PURE__ */ jsxs("section", {
			class: "usage-chart",
			children: [/* @__PURE__ */ jsx("h2", { children: "Requests per minute" }), /* @__PURE__ */ jsx("div", {
				id: "chart-rpm",
				class: "chart-box"
			})]
		}),
		/* @__PURE__ */ jsxs("section", {
			class: "usage-chart",
			children: [/* @__PURE__ */ jsx("h2", { children: "Tokens per hour" }), /* @__PURE__ */ jsx("div", {
				id: "chart-tph",
				class: "chart-box"
			})]
		}),
		/* @__PURE__ */ jsxs("section", {
			class: "usage-chart",
			children: [/* @__PURE__ */ jsx("h2", { children: "p95 latency per hour (ms)" }), /* @__PURE__ */ jsx("div", {
				id: "chart-p95",
				class: "chart-box"
			})]
		})
	]
});
const TopKeysTable = ({ rows }) => /* @__PURE__ */ jsxs("section", {
	class: "usage-table-section",
	children: [/* @__PURE__ */ jsx("h2", { children: "Top keys by tokens" }), rows.length === 0 ? /* @__PURE__ */ jsx("p", {
		class: "muted",
		children: "No data."
	}) : /* @__PURE__ */ jsxs("table", {
		class: "keys-table",
		children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [/* @__PURE__ */ jsx("th", { children: "Key (last 8)" }), /* @__PURE__ */ jsx("th", { children: "Tokens" })] }) }), /* @__PURE__ */ jsx("tbody", { children: rows.map((r) => /* @__PURE__ */ jsxs("tr", { children: [/* @__PURE__ */ jsx("td", {
			class: "mono",
			children: r.key_id.slice(-8)
		}), /* @__PURE__ */ jsx("td", { children: r.tokens.toLocaleString() })] }, r.key_id)) })]
	})]
});
const TopModelsTable = ({ rows }) => /* @__PURE__ */ jsxs("section", {
	class: "usage-table-section",
	children: [/* @__PURE__ */ jsx("h2", { children: "Top models by requests" }), rows.length === 0 ? /* @__PURE__ */ jsx("p", {
		class: "muted",
		children: "No data."
	}) : /* @__PURE__ */ jsxs("table", {
		class: "keys-table",
		children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [/* @__PURE__ */ jsx("th", { children: "Model" }), /* @__PURE__ */ jsx("th", { children: "Requests" })] }) }), /* @__PURE__ */ jsx("tbody", { children: rows.map((r) => /* @__PURE__ */ jsxs("tr", { children: [/* @__PURE__ */ jsx("td", { children: r.model }), /* @__PURE__ */ jsx("td", { children: r.count.toLocaleString() })] }, r.model)) })]
	})]
});
const ErrorRateTable = ({ rows }) => /* @__PURE__ */ jsxs("section", {
	class: "usage-table-section",
	children: [/* @__PURE__ */ jsx("h2", { children: "Error rate by key" }), rows.length === 0 ? /* @__PURE__ */ jsx("p", {
		class: "muted",
		children: "No data."
	}) : /* @__PURE__ */ jsxs("table", {
		class: "keys-table",
		children: [/* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
			/* @__PURE__ */ jsx("th", { children: "Key (last 8)" }),
			/* @__PURE__ */ jsx("th", { children: "Total" }),
			/* @__PURE__ */ jsx("th", { children: "Errors" }),
			/* @__PURE__ */ jsx("th", { children: "Rate" })
		] }) }), /* @__PURE__ */ jsx("tbody", { children: rows.map((r) => /* @__PURE__ */ jsxs("tr", { children: [
			/* @__PURE__ */ jsx("td", {
				class: "mono",
				children: r.key_id.slice(-8)
			}),
			/* @__PURE__ */ jsx("td", { children: r.total.toLocaleString() }),
			/* @__PURE__ */ jsx("td", { children: r.errors.toLocaleString() }),
			/* @__PURE__ */ jsxs("td", { children: [(r.rate * 100).toFixed(2), "%"] })
		] }, r.key_id)) })]
	})]
});
const UsagePage = (props) => {
	const { filter, allKeys, allModels, stats, rpm, tokens, latency, topKeys, topModels, errorRates, exportQuery } = props;
	const payload = JSON.stringify({
		rpm,
		tokens,
		latency,
		filter
	}).replaceAll("<", String.raw`\u003c`).replaceAll(">", String.raw`\u003e`).replaceAll("&", String.raw`\u0026`).replaceAll("\u2028", String.raw`\u2028`).replaceAll("\u2029", String.raw`\u2029`);
	return /* @__PURE__ */ jsxs("div", {
		class: "usage-page",
		children: [
			/* @__PURE__ */ jsx("link", {
				rel: "stylesheet",
				href: "/admin/assets/uplot.min.css"
			}),
			/* @__PURE__ */ jsxs("div", {
				class: "usage-header",
				children: [/* @__PURE__ */ jsx("h1", { children: "Usage" }), /* @__PURE__ */ jsx("a", {
					href: `/admin/usage/export.csv${exportQuery ? `?${exportQuery}` : ""}`,
					class: "btn btn-primary",
					download: true,
					children: "Download CSV"
				})]
			}),
			/* @__PURE__ */ jsx(FilterForm, {
				filter,
				allKeys,
				allModels
			}),
			/* @__PURE__ */ jsx(StatsRow, { stats }),
			stats.totalRequests === 0 ? /* @__PURE__ */ jsx("p", {
				class: "muted usage-empty",
				children: "No events in the selected window. Generate some traffic and refresh."
			}) : /* @__PURE__ */ jsxs(Fragment, { children: [
				/* @__PURE__ */ jsx(ChartContainers, {}),
				/* @__PURE__ */ jsx(TopKeysTable, { rows: topKeys }),
				/* @__PURE__ */ jsx(TopModelsTable, { rows: topModels }),
				/* @__PURE__ */ jsx(ErrorRateTable, { rows: errorRates })
			] }),
			/* @__PURE__ */ jsx("script", {
				type: "application/json",
				id: "usage-data",
				dangerouslySetInnerHTML: { __html: payload }
			}),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/uplot.min.js" }),
			/* @__PURE__ */ jsx("script", { src: "/admin/assets/usage.js" })
		]
	});
};

//#endregion
//#region src/admin/usage/route.tsx
const ALLOWED_RANGES = [
	"1h",
	"24h",
	"7d",
	"30d",
	"custom"
];
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
function rangeSpanMs(range) {
	switch (range) {
		case "1h": return HOUR_MS;
		case "24h": return 24 * HOUR_MS;
		case "7d": return 7 * DAY_MS;
		case "30d": return 30 * DAY_MS;
		default: return 24 * HOUR_MS;
	}
}
function parseRange(raw) {
	if (raw && ALLOWED_RANGES.includes(raw)) return raw;
	return "24h";
}
function parseDateTime(raw) {
	if (!raw) return null;
	const candidate = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) ? `${raw}Z` : raw;
	const t = Date.parse(candidate);
	return Number.isFinite(t) ? t : null;
}
function queryAll(c, key) {
	return (c.req.queries(key) ?? []).filter((v) => v.length > 0);
}
function parseFilter(c) {
	const range = parseRange(c.req.query("range"));
	const now = Date.now();
	const MAX_WINDOW_MS$1 = 90 * DAY_MS;
	let since;
	let until;
	if (range === "custom") {
		const sinceRaw = parseDateTime(c.req.query("since"));
		until = parseDateTime(c.req.query("until")) ?? now;
		since = sinceRaw ?? until - DAY_MS;
		if (since >= until) since = until - HOUR_MS;
		if (until - since > MAX_WINDOW_MS$1) since = until - MAX_WINDOW_MS$1;
	} else {
		until = now;
		since = until - rangeSpanMs(range);
	}
	return {
		range,
		since,
		until,
		keyIds: queryAll(c, "key_id"),
		models: queryAll(c, "model")
	};
}
function toQueryString(filter) {
	const params = new URLSearchParams();
	params.set("range", filter.range);
	if (filter.range === "custom") {
		params.set("since", new Date(filter.since).toISOString());
		params.set("until", new Date(filter.until).toISOString());
	}
	for (const k of filter.keyIds) params.append("key_id", k);
	for (const m of filter.models) params.append("model", m);
	return params.toString();
}
function computeStats(errorRates, tokens) {
	let totalRequests = 0;
	let totalErrors = 0;
	for (const r of errorRates) {
		totalRequests += r.total;
		totalErrors += r.errors;
	}
	let totalTokens = 0;
	for (const t of tokens) totalTokens += t.prompt_tokens + t.completion_tokens;
	const errorRate = totalRequests === 0 ? 0 : totalErrors / totalRequests;
	return {
		totalRequests,
		totalTokens,
		errorRate
	};
}
const NEEDS_QUOTING = /[",\r\n]/;
const RISKY_LEAD = /^[=+\-@\t\r]/;
function csvField(value) {
	if (value === null) return "";
	let s = String(value);
	if (RISKY_LEAD.test(s)) s = `'${s}`;
	if (!NEEDS_QUOTING.test(s)) return s;
	return `"${s.replaceAll(`"`, `""`)}"`;
}
const CSV_HEADERS = [
	"id",
	"ts",
	"key_id",
	"model",
	"upstream_model",
	"prompt_tokens",
	"completion_tokens",
	"status",
	"latency_ms",
	"error",
	"usage_unknown"
];
function eventRowToCsv(row) {
	return CSV_HEADERS.map((h) => csvField(row[h])).join(",");
}
function emptyFilter(filter) {
	return {
		since: filter.since,
		until: filter.until,
		keyIds: filter.keyIds.length > 0 ? filter.keyIds : void 0,
		models: filter.models.length > 0 ? filter.models : void 0
	};
}
function loadDashboard(filter) {
	try {
		return {
			rpm: requestsPerMinute(filter),
			tokens: tokensPerHour(filter),
			latency: p95LatencyPerHour(filter),
			topKeys: topKeysByTokens(filter),
			topModels: topModelsByRequests(filter),
			errorRates: errorRateByKey(filter),
			allModels: distinctModels()
		};
	} catch (err) {
		consola.error(`[admin/usage] dashboard query failed: ${String(err)}`);
		return {
			rpm: [],
			tokens: [],
			latency: [],
			topKeys: [],
			topModels: [],
			errorRates: [],
			allModels: []
		};
	}
}
const usageApp = new Hono();
usageApp.use("*", async (c, next) => {
	await next();
	for (const [k, v] of Object.entries(ADMIN_SECURITY_HEADERS)) c.header(k, v);
});
usageApp.get("/", (c) => {
	const session = c.get("session");
	const filter = parseFilter(c);
	const dbFilter = emptyFilter(filter);
	const data = loadDashboard(dbFilter);
	const stats = computeStats(data.errorRates, data.tokens);
	const allKeys = listKeys(500, 0).rows.filter((k) => k.revoked_at === null);
	return c.html(/* @__PURE__ */ jsx(Layout, {
		title: "Usage",
		active: "usage",
		csrfToken: session.csrf_token,
		children: /* @__PURE__ */ jsx(UsagePage, {
			csrfToken: session.csrf_token,
			filter,
			allKeys,
			allModels: data.allModels,
			stats,
			rpm: data.rpm,
			tokens: data.tokens,
			latency: data.latency,
			topKeys: data.topKeys,
			topModels: data.topModels,
			errorRates: data.errorRates,
			exportQuery: toQueryString(filter)
		})
	}));
});
usageApp.get("/export.csv", (c) => {
	const filter = parseFilter(c);
	const dbFilter = emptyFilter(filter);
	const tsTag = (/* @__PURE__ */ new Date()).toISOString().replaceAll(/[:.]/g, "-");
	const headerLine = CSV_HEADERS.join(",");
	const encoder$1 = new TextEncoder();
	const iter = streamEventsForCsv(dbFilter);
	let wroteHeader = false;
	const stream = new ReadableStream({
		pull(controller) {
			try {
				if (!wroteHeader) {
					controller.enqueue(encoder$1.encode(`${headerLine}\n`));
					wroteHeader = true;
					return;
				}
				const result = iter.next();
				if (result.done) {
					controller.close();
					return;
				}
				controller.enqueue(encoder$1.encode(`${eventRowToCsv(result.value)}\n`));
			} catch (err) {
				consola.error(`[admin/usage] CSV export pull failed: ${String(err)}`);
				controller.error(err);
				iter.return?.();
			}
		},
		cancel(reason) {
			consola.debug(`[admin/usage] CSV export cancelled: ${String(reason ?? "client_disconnect")}`);
			iter.return?.();
		}
	});
	return c.body(stream, 200, {
		"Content-Type": "text/csv; charset=utf-8",
		"Content-Disposition": `attachment; filename="usage-${tsTag}.csv"`,
		"Cache-Control": "no-store"
	});
});

//#endregion
//#region src/lib/rate-limit.ts
const keyBuckets = /* @__PURE__ */ new Map();
/**
* Minimum required gap between requests for a given key (in seconds).
* A window of 5s means: one request allowed, then the next is blocked until
* 5s have elapsed. This is a minimum-gap throttle, not a sliding window.
*
* Returns a 429 Response if the key is rate-limited, null otherwise.
* Does NOT mutate global state.lastRequestTimestamp.
*
* Memory: stale buckets (lastTs older than windowMs * 10) are evicted on access
* to prevent unbounded growth from revoked/rotated keys.
*/
function checkKeyRateLimit(keyId, overrideSec) {
	if (overrideSec === null) return;
	const windowMs = overrideSec * 1e3;
	const now = Date.now();
	const bucket = keyBuckets.get(keyId);
	if (bucket && now - bucket.lastTs > windowMs * 10) keyBuckets.delete(keyId);
	const current = keyBuckets.get(keyId);
	if (!current) {
		keyBuckets.set(keyId, { lastTs: now });
		return;
	}
	const elapsed = now - current.lastTs;
	if (elapsed >= windowMs) {
		current.lastTs = now;
		return;
	}
	const waitSec = Math.ceil((windowMs - elapsed) / 1e3);
	consola.warn(`[rate-limit] Key ${keyId} rate limited; wait ${waitSec}s`);
	throw new HTTPError("Rate limit exceeded", Response.json({ error: {
		message: "Rate limit exceeded",
		type: "rate_limit_exceeded",
		code: "rate_limit_exceeded"
	} }, {
		status: 429,
		headers: { "Retry-After": String(waitSec) }
	}));
}
async function checkRateLimit(state$1) {
	if (state$1.rateLimitSeconds === void 0) return;
	const now = Date.now();
	if (!state$1.lastRequestTimestamp) {
		state$1.lastRequestTimestamp = now;
		return;
	}
	const elapsedSeconds = (now - state$1.lastRequestTimestamp) / 1e3;
	if (elapsedSeconds > state$1.rateLimitSeconds) {
		state$1.lastRequestTimestamp = now;
		return;
	}
	const waitTimeSeconds = Math.ceil(state$1.rateLimitSeconds - elapsedSeconds);
	if (!state$1.rateLimitWait) {
		consola.warn(`Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`);
		throw new HTTPError("Rate limit exceeded", Response.json({ message: "Rate limit exceeded" }, { status: 429 }));
	}
	const waitTimeMs = waitTimeSeconds * 1e3;
	consola.warn(`Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`);
	await sleep(waitTimeMs);
	state$1.lastRequestTimestamp = now;
	consola.info("Rate limit wait completed, proceeding with request");
}

//#endregion
//#region src/middleware/auth.ts
const SK_CAP_RE = /^sk-cap-[A-Z2-7]{52}$/;
const NO_AUTH_SENTINEL = {
	id: "__noauth__",
	hash: "",
	tier: "admin",
	label: null,
	allowed_models: "[\"*\"]",
	rate_limit_override: null,
	debug_enabled: 0,
	created_at: 0,
	revoked_at: null
};
function isModelAllowed(allowedModelsJson, model) {
	let models;
	try {
		models = JSON.parse(allowedModelsJson);
	} catch {
		consola.error(`[auth] Failed to parse allowed_models JSON: ${allowedModelsJson}`);
		return false;
	}
	if (!Array.isArray(models)) {
		consola.error(`[auth] allowed_models is not an array: ${JSON.stringify(models)}`);
		return false;
	}
	return models.some((m) => typeof m === "string" && (m === "*" || m === model));
}
const AUTH_401_HEADERS = { "WWW-Authenticate": "Bearer realm=\"copilot-api\"" };
function auditReject(c, hashPrefix) {
	audit({
		actor_key_id: "__noauth__",
		actor_tier: "system",
		action: "auth.reject",
		...hashPrefix !== void 0 && { target: hashPrefix },
		ip: c.req.header("x-forwarded-for"),
		user_agent: c.req.header("user-agent")
	});
}
function rejectJson(c, message) {
	return c.json({ error: {
		message,
		type: "invalid_api_key",
		code: "invalid_api_key"
	} }, 401, AUTH_401_HEADERS);
}
const authMiddleware = async (c, next) => {
	c.req.raw.headers.delete("x-api-key");
	c.req.raw.headers.delete("cookie");
	if (!getConfig().features.auth) {
		c.set("key", NO_AUTH_SENTINEL);
		await next();
		return;
	}
	const authHeader = c.req.header("Authorization");
	if (!authHeader) {
		auditReject(c);
		return rejectJson(c, "Missing Authorization header");
	}
	const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : authHeader;
	c.req.raw.headers.delete("authorization");
	if (!SK_CAP_RE.test(bearer)) {
		const hint = bearer.startsWith("sk-cap-") ? "Malformed sk-cap-* key (expected sk-cap- + 52 uppercase base32 chars)" : "this proxy does not forward your GitHub token; use a sk-cap-* key issued by this server";
		consola.warn("[auth] Rejected request: invalid bearer token format");
		const prefix = crypto$1.createHash("sha256").update(bearer).digest("hex").slice(0, 8);
		auditReject(c, prefix);
		return rejectJson(c, hint);
	}
	const hash = crypto$1.createHash("sha256").update(bearer).digest("hex");
	const keyRecord = findKeyByHash(hash);
	if (!keyRecord || keyRecord.revoked_at !== null) {
		consola.warn("[auth] Rejected request: key not found or revoked");
		auditReject(c, hash.slice(0, 8));
		return rejectJson(c, "Invalid API key");
	}
	const debugHeader = c.req.header("x-capi-debug");
	c.req.raw.headers.delete("x-capi-debug");
	if (debugHeader !== void 0 && keyRecord.tier !== "admin") consola.warn("[auth] Stripped X-Capi-Debug from client-tier request");
	if (debugHeader === "1" && keyRecord.tier === "admin") c.set("debug_via_header", true);
	try {
		checkKeyRateLimit(keyRecord.id, keyRecord.rate_limit_override);
	} catch (err) {
		if (err instanceof HTTPError) return new Response(err.response.body, {
			status: err.response.status,
			headers: err.response.headers
		});
		throw err;
	}
	c.set("key", keyRecord);
	await next();
};

//#endregion
//#region src/services/events.ts
/**
* Insert one event row. Best-effort: any error is logged and swallowed so a
* broken DB write cannot fail the proxied request the middleware just served.
*/
function recordEvent(row) {
	try {
		getDb().run(`INSERT INTO events
         (ts, key_id, model, upstream_model,
          prompt_tokens, completion_tokens,
          status, latency_ms, error, usage_unknown,
          thinking_level, cache_read_tokens, cache_creation_tokens,
          reasoning_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			row.ts,
			row.key_id,
			row.model,
			row.upstream_model,
			row.prompt_tokens,
			row.completion_tokens,
			row.status,
			row.latency_ms,
			row.error,
			row.usage_unknown,
			row.thinking_level,
			row.cache_read_tokens,
			row.cache_creation_tokens,
			row.reasoning_tokens
		]);
	} catch (err) {
		consola.error(`[telemetry] recordEvent failed (continuing): ${String(err)}`);
	}
}
/**
* Delete rows older than `cutoffMs`.  Chunked into batches of 1000 to avoid
* holding the write lock too long; yields to the event loop between batches
* so an unrelated request handler can interleave.
*
* Returns the total number of rows deleted.
*/
async function purgeEventsOlderThan(cutoffMs) {
	const db = getDb();
	let totalDeleted = 0;
	const stmt = db.prepare(`DELETE FROM events
     WHERE id IN (
       SELECT id FROM events WHERE ts < ? ORDER BY ts LIMIT 1000
     )`);
	while (true) {
		const deleted = stmt.run(cutoffMs).changes;
		totalDeleted += deleted;
		if (deleted < 1e3) break;
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
	}
	return totalDeleted;
}

//#endregion
//#region src/middleware/telemetry.ts
/** Cap on how much of the request body we'll buffer to look for "model". */
const MODEL_SNAPSHOT_MAX_BYTES = 16 * 1024;
const MODEL_FIELD_RE = /"model"\s*:\s*"([^"\\]{1,200})"/;
const THINKING_TYPE_RE = /"thinking"\s*:\s*\{[^{}]*?"type"\s*:\s*"([^"]+)"/;
const THINKING_BUDGET_RE = /"thinking"\s*:\s*\{[^{}]*?"budget_tokens"\s*:\s*(\d+)/;
const MAX_THINKING_TOKENS_RE = /"max_thinking_tokens"\s*:\s*(\d+)/;
const REASONING_EFFORT_RE = /"reasoning"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/;
const OUTPUT_CONFIG_EFFORT_RE = /"output_config"\s*:\s*\{[^{}]*?"effort"\s*:\s*"([^"]+)"/;
function captureThinkingRaw(buf) {
	const oc = OUTPUT_CONFIG_EFFORT_RE.exec(buf);
	if (oc && oc[1]) return oc[1];
	const reasoning = REASONING_EFFORT_RE.exec(buf);
	if (reasoning && reasoning[1]) return `effort:${reasoning[1]}`;
	const budget = THINKING_BUDGET_RE.exec(buf) ?? MAX_THINKING_TOKENS_RE.exec(buf);
	if (budget && budget[1]) return budget[1];
	const type = THINKING_TYPE_RE.exec(buf);
	if (type && type[1]) return type[1];
	return null;
}
/**
* Best-effort read of a few client-facing fields (model + thinking) from
* the request body.
*
* Reads at most MODEL_SNAPSHOT_MAX_BYTES from a cloned body and stops as
* soon as both `model` and (when present) `thinking` substrings have been
* located. Never buffers the entire body — large vision / long-context
* payloads must not pin memory just for telemetry. Failures (no body, no
* model field, unreadable) silently fall through to model="n/a".
*
* Returns:
*   - model: client-requested model name, or "n/a" when missing
*   - thinking_level: short level string ("auto" / "think-hard" / etc.),
*     or null when the request didn't include a thinking field
*/
async function snapshotPostMeta(reqClone) {
	const reader = reqClone.body?.getReader();
	if (!reader) return {
		model: "n/a",
		thinking_level: null
	};
	const decoder = new TextDecoder();
	let buf = "";
	let totalBytes = 0;
	let modelMatch;
	try {
		while (totalBytes < MODEL_SNAPSHOT_MAX_BYTES) {
			const result = await reader.read();
			if (result.done) break;
			const value = result.value;
			if (!value) break;
			totalBytes += value.byteLength;
			buf += decoder.decode(value, { stream: true });
			if (!modelMatch) {
				const m = MODEL_FIELD_RE.exec(buf);
				if (m && m[1]) modelMatch = m[1];
			}
		}
		if (totalBytes >= MODEL_SNAPSHOT_MAX_BYTES) {
			while (true) if ((await reader.read()).done) break;
		}
	} catch {}
	if (!modelMatch) {
		const final = MODEL_FIELD_RE.exec(buf);
		if (final && final[1]) modelMatch = final[1];
	}
	return {
		model: modelMatch ?? "n/a",
		thinking_level: captureThinkingRaw(buf)
	};
}
/**
* Map a 4xx/5xx status to a short, low-cardinality tag.  We never store the
* response body — only this fixed-vocabulary string — so dumps of the events
* table don't leak request content.
*/
function statusToErrorTag(status) {
	if (status < 400) return null;
	if (status === 400) return "bad_request";
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 408) return "timeout";
	if (status === 409) return "conflict";
	if (status === 413) return "payload_too_large";
	if (status === 422) return "unprocessable";
	if (status === 429) return "rate_limited";
	if (status >= 500 && status < 600) return "upstream_error";
	if (status >= 400 && status < 500) return "client_error";
	return "error";
}
function safeInsertEvent(c, ctx) {
	try {
		const key = c.get("key");
		const usage = c.get("usage");
		const upstream = c.get("upstream_model") ?? ctx.clientModel;
		const status = ctx.threw ? 500 : c.res.status;
		const errorTag = ctx.aborted && status < 400 ? "client_aborted" : statusToErrorTag(status);
		const promptTokens = usage?.prompt_tokens ?? null;
		const completionTokens = usage?.completion_tokens ?? null;
		const usageUnknown = promptTokens === null && completionTokens === null ? 1 : 0;
		recordEvent({
			ts: ctx.start,
			key_id: key?.id ?? "__noauth__",
			model: ctx.clientModel,
			upstream_model: upstream,
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			status,
			latency_ms: Date.now() - ctx.start,
			error: errorTag,
			usage_unknown: usageUnknown,
			thinking_level: ctx.thinkingLevel,
			cache_read_tokens: usage?.cache_read_tokens ?? null,
			cache_creation_tokens: usage?.cache_creation_tokens ?? null,
			reasoning_tokens: usage?.reasoning_tokens ?? null
		});
	} catch (err) {
		consola.error(`[telemetry] middleware insert failed: ${String(err)}`);
	}
}
const telemetryMiddleware = async (c, next) => {
	const start$1 = Date.now();
	let clientModel = `${c.req.method} ${c.req.path}`;
	let thinkingLevel = null;
	if (c.req.method === "POST") try {
		const meta = await snapshotPostMeta(c.req.raw.clone());
		if (meta.model !== "n/a") clientModel = meta.model;
		thinkingLevel = meta.thinking_level;
	} catch (err) {
		consola.debug(`[telemetry] body meta snapshot failed: ${String(err)}`);
	}
	let threw = false;
	try {
		await next();
	} catch (err) {
		threw = true;
		throw err;
	} finally {
		instrumentResponseOrInsert(c, {
			start: start$1,
			clientModel,
			thinkingLevel,
			threw
		});
	}
};
function instrumentResponseOrInsert(c, ctx) {
	const body = c.res.body;
	const isStreaming = (c.res.headers.get("content-type") ?? "").includes("text/event-stream");
	if (!body || ctx.threw || !isStreaming) {
		safeInsertEvent(c, ctx);
		return;
	}
	let recorded = false;
	const fire = (extra = {}) => {
		if (recorded) return;
		recorded = true;
		safeInsertEvent(c, {
			...ctx,
			...extra
		});
	};
	try {
		const sourceReader = body.getReader();
		const wrapped = new ReadableStream({
			async pull(controller) {
				try {
					const result = await sourceReader.read();
					if (result.done) {
						controller.close();
						fire();
						return;
					}
					if (result.value) controller.enqueue(result.value);
				} catch (err) {
					fire({ aborted: true });
					controller.error(err);
				}
			},
			cancel(reason) {
				consola.debug(`[telemetry] stream cancelled: ${String(reason ?? "client_disconnect")}`);
				fire({ aborted: true });
				sourceReader.cancel(reason).catch(() => {});
			}
		});
		c.res = new Response(wrapped, {
			status: c.res.status,
			headers: c.res.headers
		});
	} catch (err) {
		consola.error(`[telemetry] could not instrument response body: ${String(err)}`);
		fire();
	}
}

//#endregion
//#region src/services/trace-redact.ts
/**
* Trace redaction — pure functions, no IO.
*
* The debug capture feature persists full request/response pairs to disk.
* Anything resembling a secret MUST be replaced before it crosses the
* persistence boundary. We err on the side of over-redaction: false
* positives (a legitimate token-shaped string redacted) are recoverable;
* a single leaked secret is not.
*
* Two-pass defence-in-depth:
*   1. `redactBody()` runs BODY_PATTERNS — the issuer-shaped redactions.
*   2. `assertRedacted()` runs BODY_PATTERNS again AND a stricter
*      generic-shape pass (POST_REDACT_HEURISTICS) over the already-redacted
*      output. The second pass catches:
*        - bugs in the substitution loop (replace-and-leave-something-behind)
*        - secret shapes that exist in real traffic but aren't in
*          BODY_PATTERNS (e.g., a leading `Authorization: Bearer <opaque>`).
*      Per the crew review of #36, the second pass MUST be a separate
*      pattern set so it actually adds defence — running BODY_PATTERNS
*      against its own output only catches substitution bugs.
*
* If `assertRedacted` throws, the writer drops the line entirely.
*/
const REDACTION_PLACEHOLDER = "[REDACTED]";
/**
* Header names whose values are always replaced with REDACTED_PLACEHOLDER.
* Matching is case-insensitive (Headers normalises to lowercase).
*
* Includes everything that can carry credentials in either direction:
* - Client → proxy: authorization, x-api-key, cookie, proxy-authorization
* - Proxy → upstream: authorization (Copilot bearer), x-github-token,
*   x-vscs-token (Copilot Chat extension headers — see api-config.ts)
* - Upstream → proxy: set-cookie
*/
const REDACTED_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"cookie",
	"set-cookie",
	"proxy-authorization",
	"x-github-token",
	"x-vscs-token",
	"x-capi-debug"
]);
/**
* Return a plain-object clone of `headers` with redacted names replaced by
* "[REDACTED]". Lowercases all keys so the output is canonical.
*/
function redactHeaders(headers) {
	const out = {};
	if (headers instanceof Headers) {
		for (const [name, value] of headers.entries()) {
			const lower = name.toLowerCase();
			out[lower] = REDACTED_HEADERS.has(lower) ? REDACTION_PLACEHOLDER : value;
		}
		return out;
	}
	for (const [name, value] of Object.entries(headers)) {
		const lower = name.toLowerCase();
		out[lower] = REDACTED_HEADERS.has(lower) ? REDACTION_PLACEHOLDER : value;
	}
	return out;
}
/**
* Regexes for substrings that must be scrubbed from captured bodies.
*
* - `gh[oprsu]_[A-Za-z0-9]{20,}` — classic + new GitHub PATs:
*     ghp_  personal access token (classic)
*     gho_  OAuth user token
*     ghu_  GitHub user-to-server token
*     ghs_  server-to-server token
*     ghr_  refresh token
* - `github_pat_[A-Za-z0-9_]{20,}` — fine-grained PATs
* - `eyJ...eyJ...` — JWT shape (covers the upstream Copilot bearer)
* - `Iv[0-9]+\.[A-Fa-f0-9]{16,}` — GitHub OAuth client id family. The
*   classic `Iv1.b507a08c87ecfe98` is shipped in src/lib/api-config.ts;
*   newer GitHub Apps use `Iv23.…`. These are public-by-design but we
*   still redact them so captured traces don't bake in the proxy build id.
* - `sk-cap-[A-Z2-7]{52}` — THIS proxy's own admin/client bearer tokens.
*   They're not GitHub tokens, so the other patterns miss them. Without
*   this entry a developer pasting their own key into a chat prompt
*   ("hey, what's wrong with this key?") would leak it to disk verbatim.
*   Cited in the crew review of #36 as R1.
* - `sk-ant-[A-Za-z0-9_-]{40,}` — Anthropic API keys (real users routinely
*   accidentally paste these into prompts).
* - `sk-[A-Za-z0-9_-]{40,}` — OpenAI-style sk- keys (sk-proj-*, sk-*).
*   Order matters: more specific sk-cap and sk-ant patterns run first.
* - `AKIA[A-Z0-9]{16}` — AWS access key id.
* - Basic-auth URL `://user:pass@host` — common credential-in-URL.
*/
const BODY_PATTERNS = [
	/gh[oprsu]_[A-Za-z0-9]{20,}/g,
	/github_pat_\w{20,}/g,
	/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g,
	/Iv\d+\.[A-Fa-f0-9]{16,}/g,
	/sk-cap-[A-Z2-7]{52}/g,
	/sk-ant-[\w-]{40,}/g,
	/sk-[\w-]{40,}/g,
	/\bAKIA[A-Z0-9]{16}\b/g,
	/(?<=:\/\/)[^:/@\s]+:[^@\s]{1,200}(?=@)/g
];
/**
* Redact secret-shaped substrings from a body.
*
* For objects we JSON.stringify first; we never store a parsed object on
* disk, only the redacted JSONL text. We also deliberately do NOT
* pretty-print: pretty-printed JSON spans more bytes per line and the
* writer is line-buffered, so each captured event must stay on a single
* line for the readers (`tail -f`, the SSE replay buffer) to work.
*/
function redactBody(body) {
	if (body === null || body === void 0) return "";
	let redacted = typeof body === "string" ? body : JSON.stringify(body);
	for (const pattern of BODY_PATTERNS) redacted = redacted.replace(new RegExp(pattern.source, pattern.flags), REDACTION_PLACEHOLDER);
	return redacted;
}
const POST_REDACT_HEURISTICS = [
	/\b(?:Authorization|Proxy-Authorization)\s*:\s*Bearer\s+[\w+./~=-]{32,}/gi,
	/\bCookie\s*:\s*[\w+./~=-]{32,}/gi,
	/(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)=[\w+./~=-]{32,}/gi
];
/**
* Throw if `line` still matches a known issuer pattern OR a generic
* "credential adjacent to a marker" heuristic.
*
* The writer calls this AFTER its own redaction pass. A throw indicates
* either a defect in the redactor (substitution bug) OR an unforeseen
* secret shape that slipped past BODY_PATTERNS. The writer drops the
* trace rather than persist it.
*/
function assertRedacted(line) {
	for (const pattern of BODY_PATTERNS) if (new RegExp(pattern.source, pattern.flags).test(line)) throw new Error(`[trace-redact] assertRedacted: output still matches /${pattern.source}/`);
	for (const pattern of POST_REDACT_HEURISTICS) if (new RegExp(pattern.source, pattern.flags).test(line)) throw new Error(`[trace-redact] assertRedacted: line contains an unredacted credential marker (/${pattern.source}/) — refusing to persist`);
}

//#endregion
//#region src/services/trace-writer.ts
/** Returns the trace JSONL file path for a given date string (YYYY-MM-DD). */
function traceFilePath(dateStr) {
	return path.join(tracesDir(), `traces-${dateStr}.jsonl`);
}
/** Returns today's date string in YYYY-MM-DD format (local time). */
function todayDateStr() {
	const d = /* @__PURE__ */ new Date();
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}
function legToJSON(leg) {
	return {
		...leg.method !== void 0 && { method: leg.method },
		...leg.url !== void 0 && { url: leg.url },
		...leg.status !== void 0 && { status: leg.status },
		headers: redactHeaders(leg.headers),
		body: redactBody(leg.body)
	};
}
function eventToJSON(event) {
	return {
		trace_id: event.trace_id,
		ts: event.ts,
		key_id: event.key_id,
		route: event.route,
		req: legToJSON(event.req),
		...event.upstream_req && { upstream_req: legToJSON(event.upstream_req) },
		...event.upstream_res && { upstream_res: legToJSON(event.upstream_res) },
		res: legToJSON(event.res),
		latency_ms: event.latency_ms,
		...event.meta && Object.keys(event.meta).length > 0 ? { meta: event.meta } : {}
	};
}
/**
* Persist (when retention is enabled) and broadcast a single trace event.
*
* Best-effort: a failing disk write must never crash the proxied request.
* A failing assertRedacted aborts BOTH the disk write and the broadcast —
* we'd rather lose visibility than persist a known-bad line.
*/
function writeTrace(event) {
	let line;
	try {
		line = JSON.stringify(eventToJSON(event)) + os.EOL;
	} catch (err) {
		consola.error(`[trace-writer] serialise failed: ${String(err)}`);
		return;
	}
	try {
		assertRedacted(line);
	} catch (err) {
		consola.error(`[trace-writer] redaction sanity check failed, dropping trace: ${String(err)}`);
		return;
	}
	if (getConfig().retention.traces_days > 0) try {
		appendToDisk(line);
	} catch (err) {
		consola.error(`[trace-writer] append failed (continuing): ${String(err)}`);
	}
	try {
		broadcastTrace(line);
	} catch (err) {
		consola.error(`[trace-writer] broadcast failed (continuing): ${String(err)}`);
	}
}
function appendToDisk(line) {
	const dir = tracesDir();
	fs$1.mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	const filePath = traceFilePath(todayDateStr());
	const fd = fs$1.openSync(filePath, fs$1.constants.O_WRONLY | fs$1.constants.O_CREAT | fs$1.constants.O_APPEND, 384);
	try {
		fs$1.writeSync(fd, line);
	} finally {
		fs$1.closeSync(fd);
	}
}

//#endregion
//#region src/middleware/trace.ts
const MAX_BODY_BYTES = 256 * 1024;
function shouldCapture(c) {
	const key = c.get("key");
	if (!key) return false;
	if (getConfig().features.debug) return true;
	if (isDebugActive(key)) return true;
	if (c.get("debug_via_header") === true && key.tier === "admin") return true;
	return false;
}
async function readBodyCapped(body) {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let totalBytes = 0;
	let truncated = false;
	try {
		while (totalBytes < MAX_BODY_BYTES) {
			const result = await reader.read();
			if (result.done) break;
			const value = result.value;
			if (!value) break;
			const remaining = MAX_BODY_BYTES - totalBytes;
			if (value.byteLength > remaining) {
				buf += decoder.decode(value.slice(0, remaining), { stream: true });
				totalBytes = MAX_BODY_BYTES;
				truncated = true;
				break;
			}
			buf += decoder.decode(value, { stream: true });
			totalBytes += value.byteLength;
		}
		if (totalBytes >= MAX_BODY_BYTES) {
			truncated = true;
			while (true) if ((await reader.read()).done) break;
		}
	} catch (err) {
		consola.debug(`[trace] body read failed: ${String(err)}`);
	}
	return truncated ? `${buf}[TRUNCATED]` : buf;
}
function headersToObj(h) {
	const out = {};
	for (const [k, v] of h.entries()) out[k.toLowerCase()] = v;
	return out;
}
async function captureRequest(c) {
	const raw = c.req.raw;
	let body = "";
	if (raw.body && raw.method !== "GET" && raw.method !== "HEAD") try {
		const cloned = raw.clone();
		body = await readBodyCapped(cloned.body);
	} catch (err) {
		consola.debug(`[trace] request clone failed: ${String(err)}`);
	}
	return {
		method: raw.method,
		url: raw.url,
		headers: headersToObj(raw.headers),
		body
	};
}
function appendCapped(state$1, decoder, chunk) {
	if (state$1.totalBytes >= MAX_BODY_BYTES) {
		state$1.truncated = true;
		return;
	}
	const remaining = MAX_BODY_BYTES - state$1.totalBytes;
	if (chunk.byteLength > remaining) {
		state$1.buf += decoder.decode(chunk.slice(0, remaining), { stream: true });
		state$1.totalBytes = MAX_BODY_BYTES;
		state$1.truncated = true;
		return;
	}
	state$1.buf += decoder.decode(chunk, { stream: true });
	state$1.totalBytes += chunk.byteLength;
}
function wrapResponseForCapture(c, onFinish) {
	const body = c.res.body;
	const state$1 = {
		buf: "",
		totalBytes: 0,
		truncated: false
	};
	if (!body) {
		onFinish(state$1);
		return;
	}
	const decoder = new TextDecoder();
	let finished = false;
	const fire = () => {
		if (finished) return;
		finished = true;
		onFinish(state$1);
	};
	try {
		const sourceReader = body.getReader();
		const wrapped = new ReadableStream({
			async pull(controller) {
				try {
					const result = await sourceReader.read();
					if (result.done) {
						controller.close();
						fire();
						return;
					}
					if (result.value) {
						appendCapped(state$1, decoder, result.value);
						controller.enqueue(result.value);
					}
				} catch (err) {
					fire();
					controller.error(err);
				}
			},
			cancel() {
				fire();
				sourceReader.cancel().catch(() => {});
			}
		});
		c.res = new Response(wrapped, {
			status: c.res.status,
			headers: c.res.headers
		});
	} catch (err) {
		consola.debug(`[trace] response wrap failed: ${String(err)}`);
		fire();
	}
}
function bodyOrTruncated(state$1) {
	return state$1.truncated ? `${state$1.buf}[TRUNCATED]` : state$1.buf;
}
const traceMiddleware = async (c, next) => {
	if (!shouldCapture(c)) {
		await next();
		return;
	}
	const start$1 = Date.now();
	const traceId = randomUUID();
	const reqLeg = await captureRequest(c);
	const key = c.get("key");
	let upstreamReq;
	let upstreamRes;
	let upstreamResPending;
	const capture = (cap) => {
		upstreamReq = cap.req;
		if (cap.res) upstreamRes = cap.res;
		if (cap.res_pending) upstreamResPending = cap.res_pending;
	};
	c.set("trace_capture_upstream", capture);
	let threw = false;
	let thrown = null;
	try {
		await next();
	} catch (err) {
		threw = true;
		thrown = err;
	}
	const finishTrace = async (resState) => {
		if (upstreamResPending) {
			let timer;
			try {
				const settled = await Promise.race([upstreamResPending, new Promise((resolve) => {
					timer = setTimeout(() => resolve(void 0), 3e4);
				})]);
				if (settled) upstreamRes = settled;
			} catch {} finally {
				if (timer) clearTimeout(timer);
			}
		}
		try {
			const traceMeta = c.var.trace_meta;
			writeTrace({
				trace_id: traceId,
				ts: start$1,
				key_id: key?.id ?? "__noauth__",
				route: c.req.path,
				req: reqLeg,
				upstream_req: upstreamReq,
				upstream_res: upstreamRes,
				res: {
					status: c.res.status,
					headers: headersToObj(c.res.headers),
					body: bodyOrTruncated(resState)
				},
				latency_ms: Date.now() - start$1,
				meta: traceMeta
			});
		} catch (err) {
			consola.error(`[trace] writeTrace failed (continuing): ${String(err)}`);
		}
	};
	if (threw) {
		finishTrace({
			buf: "",
			totalBytes: 0,
			truncated: false
		});
		throw thrown;
	}
	wrapResponseForCapture(c, (state$1) => {
		finishTrace(state$1);
	});
};

//#endregion
//#region src/lib/alias.ts
/**
* Resolve a client-facing alias to the upstream model name.
* If no alias is configured for `input`, returns `input` unchanged (pass-through).
*
* Pass an explicit `models` snapshot to share one getConfig() call across
* ingress + egress rewrites within the same request (avoids inconsistency
* during hot-reloads and pays the structuredClone cost only once).
*/
function resolveAlias(input, models) {
	const map = models ?? getConfig().models;
	if (!input || !Object.hasOwn(map, input)) return input;
	return map[input].upstream;
}
/**
* Rewrite an upstream model name back to the client-facing alias.
* If no alias maps to `upstream`, returns `upstream` unchanged.
*
* Linear scan — acceptable for small alias counts (< ~100 entries).
* Prefer storing the original client alias from ingress and returning it
* directly on egress to avoid this scan and multi-alias ambiguity.
*/
function resolveUpstream(upstream, models) {
	const map = models ?? getConfig().models;
	for (const [alias, entry] of Object.entries(map)) if (entry.upstream === upstream) return alias;
	return upstream;
}

//#endregion
//#region src/lib/approval.ts
const awaitApproval = async () => {
	if (!await consola.prompt(`Accept incoming request?`, { type: "confirm" })) throw new HTTPError("Request rejected", Response.json({ message: "Request rejected" }, { status: 403 }));
};

//#endregion
//#region src/lib/copilot-usage.ts
/**
* Read normalised token counts from an upstream response object. Returns
* an object where every field is optional; callers should `?? undefined`
* when stashing on `c.var.usage` (telemetry middleware tolerates absent
* fields and records usage_unknown=1 in that case).
*/
function readCopilotUsage(response) {
	if (!response || typeof response !== "object") return {};
	const r = response;
	const out = {};
	const details = r.copilot_usage?.token_details;
	if (Array.isArray(details)) for (const td of details) {
		if (typeof td.token_count !== "number") continue;
		switch (td.token_type) {
			case "input":
				out.prompt_tokens = td.token_count;
				break;
			case "output":
				out.completion_tokens = td.token_count;
				break;
			case "cache_read":
				out.cache_read_tokens = td.token_count;
				break;
			case "cache_write":
				out.cache_creation_tokens = td.token_count;
				break;
		}
	}
	const native = r.usage;
	if (native) {
		out.prompt_tokens = out.prompt_tokens ?? native.input_tokens ?? native.prompt_tokens;
		out.completion_tokens = out.completion_tokens ?? native.output_tokens ?? native.completion_tokens;
		out.total_tokens = out.total_tokens ?? native.total_tokens;
		out.cache_read_tokens = out.cache_read_tokens ?? native.cache_read_input_tokens ?? native.cache_read_tokens;
		out.cache_creation_tokens = out.cache_creation_tokens ?? native.cache_creation_input_tokens ?? native.cache_creation_tokens;
		out.reasoning_tokens = out.reasoning_tokens ?? native.output_tokens_details?.reasoning_tokens;
	}
	if (out.total_tokens === void 0 && out.prompt_tokens !== void 0 && out.completion_tokens !== void 0) out.total_tokens = out.prompt_tokens + out.completion_tokens;
	return out;
}

//#endregion
//#region src/lib/default-model.ts
/**
* Resolve a client-requested model name through the alias map, falling back
* to `default_model_alias` when the request names an unconfigured alias.
*
* @returns ResolvedModel on success, ResolveError on bad input / unset default.
*/
function resolveModelWithDefault(requested, models, defaultAlias) {
	if (!requested) return {
		message: "Request body is missing the `model` field. Set `model` to a configured alias or a known upstream id.",
		code: "empty_model_field"
	};
	if (Object.hasOwn(models, requested)) return {
		requested,
		effective: requested,
		upstream: models[requested].upstream,
		rewritten: false
	};
	if (!defaultAlias) return {
		message: `Model "${requested}" is not configured and no default_model_alias is set. Add an alias in /admin/settings → Models, or set a default model.`,
		code: "unknown_model_no_default"
	};
	if (!Object.hasOwn(models, defaultAlias)) return {
		message: `default_model_alias "${defaultAlias}" is not in models. Fix /admin/settings and retry.`,
		code: "default_model_alias_misconfigured"
	};
	return {
		requested,
		effective: defaultAlias,
		upstream: models[defaultAlias].upstream,
		rewritten: true
	};
}
/** Narrow type-guard for the error branch. */
function isResolveError(r) {
	return Object.hasOwn(r, "code");
}
/**
* Resolve a request body's `model` field against current config and apply
* the side effects every D-013 handler needs:
*
*   - returns a 400 Response when the model is unknown + no default
*   - sets `upstream_model` for telemetry
*   - sets `trace_meta` with the rewrite trail when fallback fired
*   - logs an info line when fallback fired (visible in debug)
*
* Returns either a `Response` (caller should return verbatim) or the
* resolution details to feed into the rest of the handler.
*/
function applyDefaultModelRewrite(c, requestedModel, routeLabel) {
	const { models, default_model_alias } = getConfig();
	const resolved = resolveModelWithDefault(requestedModel, models, default_model_alias);
	if (isResolveError(resolved)) return c.json({ error: {
		message: resolved.message,
		type: "invalid_request_error",
		code: resolved.code
	} }, 400);
	if (resolved.rewritten) consola.info(`[default-model] rewrote "${resolved.requested}" → "${resolved.effective}" (upstream "${resolved.upstream}") on ${routeLabel}`);
	const upstreamModel = resolveAlias(resolved.effective, models);
	c.set("upstream_model", upstreamModel);
	if (resolved.rewritten) c.set("trace_meta", {
		client_requested_model: resolved.requested,
		effective_model: resolved.effective,
		rewritten: true
	});
	return {
		clientRequestedModel: resolved.requested,
		clientAlias: resolved.effective,
		upstreamModel,
		rewritten: resolved.rewritten
	};
}
/** True when the value returned by applyDefaultModelRewrite is a 400. */
function isAppliedError(v) {
	return v instanceof Response;
}

//#endregion
//#region src/lib/model-routing.ts
/**
* Returns the upstream endpoint mode for the given model ID.
* "responses" = must use /responses; "chat" = use /chat/completions (or native Anthropic).
*/
function getModelMode(modelId) {
	if (!modelId) return "chat";
	if (state.models?.data) {
		const entry = state.models.data.find((m) => m.id === modelId);
		const supported = entry?.supported_endpoints;
		if (Array.isArray(supported) && supported.length > 0) {
			const paths = supported.map((s) => s.replace(/^ws:/i, ""));
			const hasResponses = paths.includes("/responses");
			const hasChat = paths.includes("/chat/completions");
			if (hasResponses && !hasChat) return "responses";
			if (hasChat) return "chat";
		}
		if (entry?.capabilities?.type === "responses") return "responses";
	}
	return isResponsesOnlyModel(modelId) ? "responses" : "chat";
}
/**
* Returns true if the model is known to be Responses-only on Copilot upstream
* by name pattern. Used only as a fallback when the live catalog
* (state.models) isn't populated.
*/
function isResponsesOnlyModel(modelId) {
	if (/(?:^|-)codex(?:-|$)/.test(modelId)) return true;
	if (/^o\d+-pro(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) return true;
	return false;
}

//#endregion
//#region src/lib/tokenizer.ts
const ENCODING_MAP = {
	o200k_base: () => import("gpt-tokenizer/encoding/o200k_base"),
	cl100k_base: () => import("gpt-tokenizer/encoding/cl100k_base"),
	p50k_base: () => import("gpt-tokenizer/encoding/p50k_base"),
	p50k_edit: () => import("gpt-tokenizer/encoding/p50k_edit"),
	r50k_base: () => import("gpt-tokenizer/encoding/r50k_base")
};
const encodingCache = /* @__PURE__ */ new Map();
/**
* Calculate tokens for tool calls
*/
const calculateToolCallsTokens = (toolCalls, encoder$1, constants) => {
	let tokens = 0;
	for (const toolCall of toolCalls) {
		tokens += constants.funcInit;
		tokens += encoder$1.encode(JSON.stringify(toolCall)).length;
	}
	tokens += constants.funcEnd;
	return tokens;
};
/**
* Calculate tokens for content parts
*/
const calculateContentPartsTokens = (contentParts, encoder$1) => {
	let tokens = 0;
	for (const part of contentParts) if (part.type === "image_url") tokens += encoder$1.encode(part.image_url.url).length + 85;
	else if (part.text) tokens += encoder$1.encode(part.text).length;
	return tokens;
};
/**
* Calculate tokens for a single message
*/
const calculateMessageTokens = (message, encoder$1, constants) => {
	const tokensPerMessage = 3;
	const tokensPerName = 1;
	let tokens = tokensPerMessage;
	for (const [key, value] of Object.entries(message)) {
		if (typeof value === "string") tokens += encoder$1.encode(value).length;
		if (key === "name") tokens += tokensPerName;
		if (key === "tool_calls") tokens += calculateToolCallsTokens(value, encoder$1, constants);
		if (key === "content" && Array.isArray(value)) tokens += calculateContentPartsTokens(value, encoder$1);
	}
	return tokens;
};
/**
* Calculate tokens using custom algorithm
*/
const calculateTokens = (messages, encoder$1, constants) => {
	if (messages.length === 0) return 0;
	let numTokens = 0;
	for (const message of messages) numTokens += calculateMessageTokens(message, encoder$1, constants);
	numTokens += 3;
	return numTokens;
};
/**
* Get the corresponding encoder module based on encoding type
*/
const getEncodeChatFunction = async (encoding) => {
	if (encodingCache.has(encoding)) {
		const cached$1 = encodingCache.get(encoding);
		if (cached$1) return cached$1;
	}
	const supportedEncoding = encoding;
	if (!(supportedEncoding in ENCODING_MAP)) {
		const fallbackModule = await ENCODING_MAP.o200k_base();
		encodingCache.set(encoding, fallbackModule);
		return fallbackModule;
	}
	const encodingModule = await ENCODING_MAP[supportedEncoding]();
	encodingCache.set(encoding, encodingModule);
	return encodingModule;
};
/**
* Get tokenizer type from model information
*/
const getTokenizerFromModel = (model) => {
	return model.capabilities.tokenizer || "o200k_base";
};
/**
* Get model-specific constants for token calculation
*/
const getModelConstants = (model) => {
	return model.id === "gpt-3.5-turbo" || model.id === "gpt-4" ? {
		funcInit: 10,
		propInit: 3,
		propKey: 3,
		enumInit: -3,
		enumItem: 3,
		funcEnd: 12
	} : {
		funcInit: 7,
		propInit: 3,
		propKey: 3,
		enumInit: -3,
		enumItem: 3,
		funcEnd: 12
	};
};
/**
* Calculate tokens for a single parameter
*/
const calculateParameterTokens = (key, prop, context) => {
	const { encoder: encoder$1, constants } = context;
	let tokens = constants.propKey;
	if (typeof prop !== "object" || prop === null) return tokens;
	const param = prop;
	const paramName = key;
	const paramType = param.type || "string";
	let paramDesc = param.description || "";
	if (param.enum && Array.isArray(param.enum)) {
		tokens += constants.enumInit;
		for (const item of param.enum) {
			tokens += constants.enumItem;
			tokens += encoder$1.encode(String(item)).length;
		}
	}
	if (paramDesc.endsWith(".")) paramDesc = paramDesc.slice(0, -1);
	const line = `${paramName}:${paramType}:${paramDesc}`;
	tokens += encoder$1.encode(line).length;
	const excludedKeys = new Set([
		"type",
		"description",
		"enum"
	]);
	for (const propertyName of Object.keys(param)) if (!excludedKeys.has(propertyName)) {
		const propertyValue = param[propertyName];
		const propertyText = typeof propertyValue === "string" ? propertyValue : JSON.stringify(propertyValue);
		tokens += encoder$1.encode(`${propertyName}:${propertyText}`).length;
	}
	return tokens;
};
/**
* Calculate tokens for function parameters
*/
const calculateParametersTokens = (parameters, encoder$1, constants) => {
	if (!parameters || typeof parameters !== "object") return 0;
	const params = parameters;
	let tokens = 0;
	for (const [key, value] of Object.entries(params)) if (key === "properties") {
		const properties = value;
		if (Object.keys(properties).length > 0) {
			tokens += constants.propInit;
			for (const propKey of Object.keys(properties)) tokens += calculateParameterTokens(propKey, properties[propKey], {
				encoder: encoder$1,
				constants
			});
		}
	} else {
		const paramText = typeof value === "string" ? value : JSON.stringify(value);
		tokens += encoder$1.encode(`${key}:${paramText}`).length;
	}
	return tokens;
};
/**
* Calculate tokens for a single tool
*/
const calculateToolTokens = (tool, encoder$1, constants) => {
	let tokens = constants.funcInit;
	const func = tool.function;
	const fName = func.name;
	let fDesc = func.description || "";
	if (fDesc.endsWith(".")) fDesc = fDesc.slice(0, -1);
	const line = fName + ":" + fDesc;
	tokens += encoder$1.encode(line).length;
	if (typeof func.parameters === "object" && func.parameters !== null) tokens += calculateParametersTokens(func.parameters, encoder$1, constants);
	return tokens;
};
/**
* Calculate token count for tools based on model
*/
const numTokensForTools = (tools, encoder$1, constants) => {
	let funcTokenCount = 0;
	for (const tool of tools) funcTokenCount += calculateToolTokens(tool, encoder$1, constants);
	funcTokenCount += constants.funcEnd;
	return funcTokenCount;
};
/**
* Calculate the token count of messages, supporting multiple GPT encoders
*/
const getTokenCount = async (payload, model) => {
	const tokenizer = getTokenizerFromModel(model);
	const encoder$1 = await getEncodeChatFunction(tokenizer);
	const simplifiedMessages = payload.messages;
	const inputMessages = simplifiedMessages.filter((msg) => msg.role !== "assistant");
	const outputMessages = simplifiedMessages.filter((msg) => msg.role === "assistant");
	const constants = getModelConstants(model);
	let inputTokens = calculateTokens(inputMessages, encoder$1, constants);
	if (payload.tools && payload.tools.length > 0) inputTokens += numTokensForTools(payload.tools, encoder$1, constants);
	const outputTokens = calculateTokens(outputMessages, encoder$1, constants);
	return {
		input: inputTokens,
		output: outputTokens
	};
};

//#endregion
//#region src/services/copilot/create-chat-completions.ts
const createChatCompletions = async (payload, onUpstream) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const enableVision = payload.messages.some((x) => typeof x.content !== "string" && x.content?.some((x$1) => x$1.type === "image_url"));
	const isAgentCall$1 = payload.messages.some((msg) => ["assistant", "tool"].includes(msg.role));
	const headers = {
		...copilotHeaders(state, enableVision),
		"X-Initiator": isAgentCall$1 ? "agent" : "user"
	};
	const upstreamPayload = payload.stream === true && payload.stream_options === void 0 ? {
		...payload,
		stream_options: { include_usage: true }
	} : payload;
	const url = `${copilotBaseUrl(state)}/chat/completions`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(upstreamPayload)
	});
	if (onUpstream) try {
		const responseBody = payload.stream ? void 0 : await response.clone().text();
		onUpstream({
			req: {
				method: "POST",
				url,
				headers,
				body: upstreamPayload
			},
			res: {
				status: response.status,
				headers: response.headers,
				body: responseBody
			}
		});
	} catch (err) {
		consola.warn(`[trace] upstream capture failed: ${String(err)}`);
	}
	if (!response.ok) {
		consola.error("Failed to create chat completions", response);
		throw new HTTPError("Failed to create chat completions", response);
	}
	if (payload.stream) return events(response);
	return await response.json();
};

//#endregion
//#region src/routes/chat-completions/handler.ts
async function handleCompletion$1(c) {
	let payload = await c.req.json();
	consola.debug("Request payload:", JSON.stringify(payload).slice(-400));
	const { models } = getConfig();
	const resolved = applyDefaultModelRewrite(c, payload.model, "/v1/chat/completions");
	if (isAppliedError(resolved)) return resolved;
	const { clientRequestedModel, clientAlias, upstreamModel } = resolved;
	payload = {
		...payload,
		model: upstreamModel
	};
	const key = c.get("key");
	if (!isModelAllowed(key.allowed_models, clientAlias)) return c.json({ error: {
		message: `Model "${clientRequestedModel}" is not in your key's allowed models`,
		type: "permission_denied",
		code: "model_not_allowed"
	} }, 403);
	if (getModelMode(payload.model) === "responses") return c.json({ error: {
		message: `Model "${payload.model}" is only available via the Responses API. Use POST /v1/responses instead.`,
		type: "invalid_request_error",
		code: "responses_only_model"
	} }, 400);
	await checkRateLimit(state);
	const selectedModel = state.models?.data.find((model) => model.id === payload.model);
	try {
		if (selectedModel) {
			const tokenCount = await getTokenCount(payload, selectedModel);
			consola.info("Current token count:", tokenCount);
		} else consola.warn("No model selected, skipping token count calculation");
	} catch (error) {
		consola.warn("Failed to calculate token count:", error);
	}
	if (state.manualApprove) await awaitApproval();
	if (isNullish(payload.max_tokens)) {
		payload = {
			...payload,
			max_tokens: selectedModel?.capabilities.limits.max_output_tokens
		};
		consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens));
	}
	const onUpstream = c.var.trace_capture_upstream;
	const aliasDefault = models[clientAlias]?.default_effort;
	if (!payload.reasoning_effort && aliasDefault && aliasDefault !== "") {
		const e = aliasDefault === "xhigh" ? "high" : aliasDefault;
		consola.debug(`[alias-effort] injecting reasoning_effort=${e} (alias=${clientAlias})`);
		payload = {
			...payload,
			reasoning_effort: e
		};
	}
	const response = await createChatCompletions(payload, onUpstream);
	if (isNonStreaming$1(response)) {
		consola.debug("Non-streaming response:", JSON.stringify(response));
		c.set("usage", readCopilotUsage(response));
		const egressModel = clientAlias !== payload.model ? clientAlias : resolveUpstream(response.model, models);
		return c.json({
			...response,
			model: egressModel
		});
	}
	consola.debug("Streaming response");
	return streamSSE(c, async (stream) => {
		for await (const chunk of response) {
			consola.debug("Streaming chunk:", JSON.stringify(chunk));
			maybeStashUsageFromChunk(c, chunk);
			const rewritten = rewriteChunkModel(chunk, {
				clientAlias,
				upstreamModel: payload.model,
				models
			});
			await stream.writeSSE(rewritten);
		}
	});
}
/**
* Look for a top-level `usage: { prompt_tokens, completion_tokens }` on a
* streamed SSE chunk and stash it on the context for the telemetry
* middleware. Silently ignores chunks that are non-JSON or have no usage.
*/
function maybeStashUsageFromChunk(c, chunk) {
	const data = chunk.data;
	if (!data || data === "[DONE]") return;
	let parsed;
	try {
		parsed = JSON.parse(data);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return;
	const u = readCopilotUsage(parsed);
	if (u.prompt_tokens !== void 0 || u.completion_tokens !== void 0 || u.cache_read_tokens !== void 0 || u.cache_creation_tokens !== void 0) c.set("usage", u);
}
/**
* Rewrite the `model` field in a single SSE chunk's `data` payload.
* Returns the chunk unchanged if `data` is not parseable JSON or has no
* top-level `model` field.  Never touches nested JSON (tool-call arguments).
*/
function rewriteChunkModel(chunk, ctx) {
	const data = chunk.data;
	if (!data || data === "[DONE]") return chunk;
	let parsed;
	try {
		parsed = JSON.parse(data);
	} catch {
		return chunk;
	}
	if (typeof parsed !== "object" || parsed === null || !Object.hasOwn(parsed, "model")) return chunk;
	const { clientAlias, upstreamModel, models } = ctx;
	const egressModel = clientAlias !== upstreamModel ? clientAlias : resolveUpstream(parsed.model, models);
	return {
		...chunk,
		data: JSON.stringify({
			...parsed,
			model: egressModel
		})
	};
}
const isNonStreaming$1 = (response) => Object.hasOwn(response, "choices");

//#endregion
//#region src/routes/chat-completions/route.ts
const completionRoutes = new Hono();
completionRoutes.post("/", async (c) => {
	try {
		return await handleCompletion$1(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/services/copilot/create-embeddings.ts
const createEmbeddings = async (payload) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
		method: "POST",
		headers: copilotHeaders(state),
		body: JSON.stringify(payload)
	});
	if (!response.ok) throw new HTTPError("Failed to create embeddings", response);
	return await response.json();
};

//#endregion
//#region src/routes/embeddings/route.ts
const embeddingRoutes = new Hono();
embeddingRoutes.post("/", async (c) => {
	try {
		const paylod = await c.req.json();
		const response = await createEmbeddings(paylod);
		return c.json(response);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/messages/utils.ts
function mapOpenAIStopReasonToAnthropic(finishReason) {
	if (finishReason === null) return null;
	return {
		stop: "end_turn",
		length: "max_tokens",
		tool_calls: "tool_use",
		content_filter: "end_turn"
	}[finishReason];
}

//#endregion
//#region src/routes/messages/non-stream-translation.ts
const ALLOWED_IMAGE_MEDIA_TYPES$1 = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp"
]);
const DANGEROUS_TOOL_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function translateToOpenAI(payload) {
	return {
		model: translateModelName(payload.model),
		messages: translateAnthropicMessagesToOpenAI(payload.messages, payload.system),
		max_tokens: payload.max_tokens,
		stop: payload.stop_sequences,
		stream: payload.stream,
		temperature: payload.temperature,
		top_p: payload.top_p,
		user: payload.metadata?.user_id,
		tools: translateAnthropicToolsToOpenAI(payload.tools),
		tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice)
	};
}
function translateModelName(model) {
	if (model.startsWith("claude-sonnet-4-")) return model.replace(/^claude-sonnet-4-.*/, "claude-sonnet-4");
	else if (model.startsWith("claude-opus-")) return model.replace(/^claude-opus-4-.*/, "claude-opus-4");
	return model;
}
function translateAnthropicMessagesToOpenAI(anthropicMessages, system) {
	const systemMessages = handleSystemPrompt(system);
	const otherMessages = anthropicMessages.flatMap((message) => message.role === "user" ? handleUserMessage(message) : handleAssistantMessage(message));
	return [...systemMessages, ...otherMessages];
}
function handleSystemPrompt(system) {
	if (!system) return [];
	if (typeof system === "string") return [{
		role: "system",
		content: system
	}];
	else return [{
		role: "system",
		content: system.map((block) => block.text).join("\n\n")
	}];
}
function handleUserMessage(message) {
	const newMessages = [];
	if (Array.isArray(message.content)) {
		const toolResultBlocks = message.content.filter((block) => block.type === "tool_result");
		const otherBlocks = message.content.filter((block) => block.type !== "tool_result");
		for (const block of toolResultBlocks) newMessages.push({
			role: "tool",
			tool_call_id: block.tool_use_id,
			content: mapContent(block.content)
		});
		if (otherBlocks.length > 0) newMessages.push({
			role: "user",
			content: mapContent(otherBlocks)
		});
	} else newMessages.push({
		role: "user",
		content: mapContent(message.content)
	});
	return newMessages;
}
function handleAssistantMessage(message) {
	if (!Array.isArray(message.content)) return [{
		role: "assistant",
		content: mapContent(message.content)
	}];
	const toolUseBlocks = message.content.filter((block) => block.type === "tool_use");
	const textBlocks = message.content.filter((block) => block.type === "text");
	const thinkingBlocks = message.content.filter((block) => block.type === "thinking");
	const allTextContent = [...textBlocks.map((b) => b.text), ...thinkingBlocks.map((b) => b.thinking)].join("\n\n");
	return toolUseBlocks.length > 0 ? [{
		role: "assistant",
		content: allTextContent || null,
		tool_calls: toolUseBlocks.map((toolUse) => ({
			id: toolUse.id,
			type: "function",
			function: {
				name: toolUse.name,
				arguments: JSON.stringify(toolUse.input)
			}
		}))
	}] : [{
		role: "assistant",
		content: mapContent(message.content)
	}];
}
function mapContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	if (!content.some((block) => block.type === "image")) return content.filter((block) => block.type === "text" || block.type === "thinking").map((block) => block.type === "text" ? block.text : block.thinking).join("\n\n");
	const contentParts = [];
	for (const block of content) switch (block.type) {
		case "text":
			contentParts.push({
				type: "text",
				text: block.text
			});
			break;
		case "thinking":
			contentParts.push({
				type: "text",
				text: block.thinking
			});
			break;
		case "image":
			if (block.source.type === "base64") if (ALLOWED_IMAGE_MEDIA_TYPES$1.has(block.source.media_type)) contentParts.push({
				type: "image_url",
				image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
			});
			else consola.warn("Skipping image with unsupported media_type in translation path:", block.source.media_type);
			else consola.warn("URL image source not supported in translation path — skipping");
			break;
	}
	return contentParts;
}
function translateAnthropicToolsToOpenAI(anthropicTools) {
	if (!anthropicTools) return;
	return anthropicTools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema
		}
	}));
}
function translateAnthropicToolChoiceToOpenAI(anthropicToolChoice) {
	if (!anthropicToolChoice) return;
	switch (anthropicToolChoice.type) {
		case "auto": return "auto";
		case "any": return "required";
		case "tool":
			if (anthropicToolChoice.name) return {
				type: "function",
				function: { name: anthropicToolChoice.name }
			};
			return;
		case "none": return "none";
		default: return;
	}
}
function translateToAnthropic(response) {
	const allThinkingBlocks = [];
	const allTextBlocks = [];
	const allToolUseBlocks = [];
	let stopReason = null;
	stopReason = response.choices[0]?.finish_reason ?? stopReason;
	for (const choice of response.choices) {
		allThinkingBlocks.push(...getAnthropicThinkingBlocks(choice.message.reasoning_content));
		allTextBlocks.push(...getAnthropicTextBlocks(choice.message.content));
		allToolUseBlocks.push(...getAnthropicToolUseBlocks(choice.message.tool_calls));
		if (choice.finish_reason === "tool_calls" || stopReason === "stop") stopReason = choice.finish_reason;
	}
	return {
		id: response.id,
		type: "message",
		role: "assistant",
		model: response.model,
		content: [
			...allThinkingBlocks,
			...allTextBlocks,
			...allToolUseBlocks
		],
		stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
		stop_sequence: null,
		usage: {
			input_tokens: (response.usage?.prompt_tokens ?? 0) - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
			output_tokens: response.usage?.completion_tokens ?? 0,
			...response.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: response.usage.prompt_tokens_details.cached_tokens }
		}
	};
}
function getAnthropicThinkingBlocks(reasoningContent) {
	if (!reasoningContent) return [];
	return [{
		type: "thinking",
		thinking: reasoningContent
	}];
}
function getAnthropicTextBlocks(messageContent) {
	if (typeof messageContent === "string") return [{
		type: "text",
		text: messageContent
	}];
	if (Array.isArray(messageContent)) return messageContent.filter((part) => part.type === "text").map((part) => ({
		type: "text",
		text: part.text
	}));
	return [];
}
function getAnthropicToolUseBlocks(toolCalls) {
	if (!toolCalls) return [];
	return toolCalls.map((toolCall) => {
		let parsedInput;
		try {
			const raw = JSON.parse(toolCall.function.arguments);
			parsedInput = typeof raw !== "object" || raw === null || Array.isArray(raw) ? { _raw: toolCall.function.arguments } : Object.fromEntries(Object.entries(raw).filter(([k]) => !DANGEROUS_TOOL_KEYS.has(k)));
		} catch {
			parsedInput = { _raw: toolCall.function.arguments };
		}
		return {
			type: "tool_use",
			id: toolCall.id,
			name: toolCall.function.name,
			input: parsedInput
		};
	});
}

//#endregion
//#region src/routes/messages/count-tokens-handler.ts
/**
* Handles token counting for Anthropic messages.
*
* Claude Code calls this BEFORE every real /v1/messages to estimate the
* prompt cost and trigger its context-management auto-compression when the
* estimate crosses a threshold. The estimate doesn't need to be exact but
* it must be in the right order of magnitude — returning `1` (the legacy
* fallback) makes Claude Code think every prompt is tiny.
*/
async function handleCountTokens(c) {
	try {
		const anthropicBeta = c.req.header("anthropic-beta");
		const anthropicPayload = await c.req.json();
		const openAIPayload = translateToOpenAI(anthropicPayload);
		const { models: modelAliases } = getConfig();
		const upstreamId = resolveAlias(anthropicPayload.model, modelAliases);
		const selectedModel = state.models?.data.find((m) => m.id === upstreamId || m.id === anthropicPayload.model);
		if (!selectedModel) {
			consola.warn(`count_tokens: model not found in upstream catalog (alias=${anthropicPayload.model} upstream=${upstreamId}); falling back to character estimate`);
			return c.json({ input_tokens: estimateTokensFromPayload(anthropicPayload) });
		}
		const tokenCount = await getTokenCount(openAIPayload, selectedModel);
		if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
			let mcpToolExist = false;
			if (anthropicBeta?.startsWith("claude-code")) mcpToolExist = anthropicPayload.tools.some((tool) => tool.name.startsWith("mcp__"));
			if (!mcpToolExist) {
				if (anthropicPayload.model.startsWith("claude")) tokenCount.input = tokenCount.input + 346;
				else if (anthropicPayload.model.startsWith("grok")) tokenCount.input = tokenCount.input + 480;
			}
		}
		let finalTokenCount = tokenCount.input + tokenCount.output;
		if (anthropicPayload.model.startsWith("claude")) finalTokenCount = Math.round(finalTokenCount * 1.15);
		else if (anthropicPayload.model.startsWith("grok")) finalTokenCount = Math.round(finalTokenCount * 1.03);
		consola.info("Token count:", finalTokenCount);
		return c.json({ input_tokens: finalTokenCount });
	} catch (error) {
		consola.error("Error counting tokens:", error);
		try {
			const body = await c.req.json().catch(() => ({ messages: [] }));
			const estimated = estimateTokensFromPayload(body);
			consola.warn(`count_tokens: tokeniser failed, returning char-based estimate=${estimated}`);
			return c.json({ input_tokens: estimated });
		} catch {
			return c.json({ input_tokens: 1e5 });
		}
	}
}
/**
* Character-based token estimate for fallback paths. Counts characters
* across text / tool_use / tool_result blocks and divides by 2 (which
* UNDER-estimates token compression — i.e. yields a high token count) so
* Claude Code errs toward triggering auto-compression rather than
* blasting an oversized prompt at upstream.
*
* Returns at least 1 so callers don't have to guard.
*/
function estimateTokensFromPayload(payload) {
	let chars = 0;
	for (const msg of payload.messages ?? []) {
		if (typeof msg.content === "string") {
			chars += msg.content.length;
			continue;
		}
		if (!Array.isArray(msg.content)) continue;
		for (const block of msg.content) if (block.type === "text") chars += block.text.length;
		else if (block.type === "tool_use") chars += JSON.stringify(block.input ?? {}).length;
		else if (block.type === "tool_result") chars += JSON.stringify(block.content ?? "").length;
	}
	return Math.max(1, Math.ceil(chars / 2));
}

//#endregion
//#region src/routes/responses/translation.ts
/**
* Sanitise a Responses API response object before forwarding to the client.
*
* Guarantees:
*  1. `encrypted_content` on reasoning items is preserved (never stripped).
*  2. `status: null` is removed from all output items.
*  3. All other fields are passed through untouched.
*/
function sanitiseResponsesOutput(response) {
	return {
		...response,
		output: response.output.map((item) => sanitiseOutputItem(item))
	};
}
/**
* Sanitise a single output item from an SSE event or non-streaming response.
* Exported so the streaming path can apply the same logic per-event.
*/
function sanitiseOutputItem(item) {
	const loose = item;
	if (loose.status === null) {
		const { status: _dropped,...rest } = loose;
		return rest;
	}
	return item;
}

//#endregion
//#region src/services/copilot/create-messages-native.ts
/**
* Forward an Anthropic-format request directly to Copilot's native `/v1/messages`
* endpoint, preserving all fields (thinking, signature, top_k, cache_control, …).
*
* Returns:
*  - For non-streaming: the raw Anthropic JSON response object
*  - For streaming: an async iterable of SSE events (fetch-event-stream)
*/
const createMessagesNative = async (payload, onUpstream, clientAnthropicBeta, defaultEffort) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const hasVision = messageHasImages(payload);
	const headers = buildNativeHeaders(hasVision, Boolean(payload.stream), clientAnthropicBeta);
	headers["X-Initiator"] = isAgentMessagesCall(payload) ? "agent" : "user";
	const upstream = `${copilotBaseUrl(state)}/v1/messages`;
	consola.debug("Native Anthropic upstream:", upstream);
	const body = buildUpstreamPayload(payload, defaultEffort);
	let sentHeaders = headers;
	let response = await fetch(upstream, {
		method: "POST",
		headers: sentHeaders,
		body: JSON.stringify(body)
	});
	if (response.status === 400) {
		const errBody = await response.clone().text();
		const newlyUnsupported = parseUnsupportedBetaFromError(errBody);
		if (newlyUnsupported.length > 0) {
			const denyList = ensureLearnedSet();
			const newToProcess = [];
			for (const f of newlyUnsupported) if (!denyList.has(f)) {
				denyList.add(f);
				newToProcess.push(f);
			}
			for (const f of newToProcess) if (!SEEDED_UNSUPPORTED_BETA.includes(f)) {
				persistLearnedBetaFlag(f);
				unseededFlagsFromFile.push(f);
			}
			consola.warn(`[anthropic-beta] upstream rejected ${JSON.stringify(newlyUnsupported)} — added to deny-list${newToProcess.length > 0 ? " (new, persisted)" : ""}, retrying`);
			sentHeaders = { ...headers };
			const rebuiltBeta = mergeAnthropicBeta(clientAnthropicBeta);
			if (rebuiltBeta === "") delete sentHeaders["anthropic-beta"];
			else sentHeaders["anthropic-beta"] = rebuiltBeta;
			response = await fetch(upstream, {
				method: "POST",
				headers: sentHeaders,
				body: JSON.stringify(body)
			});
		}
	}
	if (onUpstream && !payload.stream) try {
		const responseBody = await response.clone().text();
		onUpstream({
			req: {
				method: "POST",
				url: upstream,
				headers: sentHeaders,
				body
			},
			res: {
				status: response.status,
				headers: response.headers,
				body: responseBody
			}
		});
	} catch (err) {
		consola.warn(`[trace] upstream capture failed: ${String(err)}`);
	}
	else if (onUpstream && payload.stream && response.body) try {
		const [forForwarder, forCapture] = response.body.tee();
		const upstreamResHeaders = response.headers;
		const upstreamResStatus = response.status;
		response = new Response(forForwarder, {
			status: upstreamResStatus,
			statusText: response.statusText,
			headers: upstreamResHeaders
		});
		const MAX_CAPTURE = 256 * 1024;
		const resPending = (async () => {
			const reader = forCapture.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let bytes = 0;
			let truncated = false;
			let streamErr;
			try {
				while (true) {
					const r = await reader.read();
					if (r.done) break;
					const v = r.value;
					if (!v) break;
					if (bytes < MAX_CAPTURE) {
						const room = MAX_CAPTURE - bytes;
						if (v.byteLength <= room) {
							buf += decoder.decode(v, { stream: true });
							bytes += v.byteLength;
						} else {
							buf += decoder.decode(v.slice(0, room), { stream: true });
							bytes = MAX_CAPTURE;
							truncated = true;
						}
					}
				}
			} catch (err) {
				streamErr = err;
			}
			let resBody = buf;
			if (truncated) resBody += "[TRUNCATED]";
			if (streamErr !== void 0) {
				const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
				resBody += `[STREAM_ERROR: ${msg}]`;
			}
			return {
				status: upstreamResStatus,
				headers: upstreamResHeaders,
				body: resBody
			};
		})();
		onUpstream({
			req: {
				method: "POST",
				url: upstream,
				headers: sentHeaders,
				body
			},
			res_pending: resPending
		});
	} catch (err) {
		consola.warn(`[trace] upstream tee failed: ${String(err)}`);
	}
	if (!response.ok) {
		consola.error("Native Anthropic upstream error", response.status);
		throw new HTTPError("Native Anthropic upstream error", response);
	}
	if (payload.stream) return events(response);
	return response.json();
};
/**
* Auto-learning deny-list of beta flags upstream rejects.
*
* Layered state:
*   1. **Seed** — hard-coded values committed to the repo. Things we've
*      already observed in production. Avoids the cold-start retry penalty
*      on every brand-new install.
*   2. **File** — `~/.local/share/copilot-api-pro/learned-unsupported-beta.txt`
*      Per-line ASCII flag names. Read once on first use, appended to when a
*      new flag is learned. Persists across restarts. Operators can edit it
*      manually to revert / extend the deny-list.
*   3. **Process** — the live `Set<string>` mutated when auto-learn fires.
*
* When a NEW flag (not in seed + not in file) is learned, we ALSO log a
* loud warning at startup of subsequent processes so operators / devs
* notice and can promote it into the seed via a code commit.
*/
const SEEDED_UNSUPPORTED_BETA = ["context-1m-2025-08-07"];
/** Lazily-initialised on first call. Stays empty until the file is read. */
let learnedUnsupportedBeta;
/** Flags present in the file but NOT in the seed — surface at startup. */
const unseededFlagsFromFile = [];
function ensureLearnedSet() {
	if (learnedUnsupportedBeta) return learnedUnsupportedBeta;
	const s = new Set(SEEDED_UNSUPPORTED_BETA);
	try {
		const raw = fs$1.readFileSync(PATHS.LEARNED_BETA_PATH, "utf8");
		for (const line of raw.split("\n")) {
			const flag = line.trim();
			if (!flag || flag.startsWith("#")) continue;
			if (!/^[\w.-]+$/.test(flag)) continue;
			if (!SEEDED_UNSUPPORTED_BETA.includes(flag)) unseededFlagsFromFile.push(flag);
			s.add(flag);
		}
	} catch {}
	learnedUnsupportedBeta = s;
	return s;
}
/**
* Get the set of flags discovered at runtime that are NOT in the source
* seed. Used by start.ts to surface them in the boot banner so the next
* developer notices and bumps the seed.
*/
function unseededLearnedBetaFlags() {
	ensureLearnedSet();
	return [...unseededFlagsFromFile];
}
/**
* Append a newly-learned flag to the persistent file with a timestamped
* comment line. Best-effort: a write failure logs but doesn't propagate
* (the in-memory Set still works for this process).
*/
function persistLearnedBetaFlag(flag) {
	try {
		const line = `# learned ${(/* @__PURE__ */ new Date()).toISOString()}\n${flag}\n`;
		fs$1.appendFileSync(PATHS.LEARNED_BETA_PATH, line, { mode: 384 });
	} catch (err) {
		consola.warn(`[anthropic-beta] failed to persist learned flag "${flag}": ${String(err)}`);
	}
}
function mergeAnthropicBeta(clientBeta) {
	const ours = ["interleaved-thinking-2025-05-14", "prompt-caching-2024-07-31"];
	const fromClient = (clientBeta ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
	const merged = [...new Set([...fromClient, ...ours])];
	const denyList = ensureLearnedSet();
	return merged.filter((flag) => !denyList.has(flag)).join(",");
}
/**
* Parse upstream 400 body for `unsupported beta header(s): X, Y` and
* return the flag names. Returns empty array when the body isn't a
* recognised "unsupported beta" error.
*/
function parseUnsupportedBetaFromError(body) {
	const m = /unsupported beta header\(s\):\s*([^"\\}]+)/i.exec(body);
	if (!m || !m[1]) return [];
	return m[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0 && /^[\w.-]+$/.test(s));
}
/**
* Build headers for the Anthropic native endpoint.
*
* The upstream requires `anthropic-version` and does NOT want an `openai-intent`
* header.  We reuse `copilotHeaders()` for auth/agent headers and then layer the
* Anthropic-specific ones on top.
*/
function buildNativeHeaders(vision, stream, clientBeta) {
	const { "openai-intent": _dropped,...anthropicBase } = copilotHeaders(state, vision);
	const beta = mergeAnthropicBeta(clientBeta);
	return {
		...anthropicBase,
		"anthropic-version": "2023-06-01",
		...beta === "" ? {} : { "anthropic-beta": beta },
		...stream ? { accept: "text/event-stream" } : {}
	};
}
/**
* Map a legacy Anthropic `budget_tokens` value to a Copilot effort level
* for adaptive thinking. The buckets mirror Claude Code's preset budgets
* so a client that selects "Think hard" upstream lands on Copilot's "high"
* (etc).
*
*   budget ≥ 50K → "xhigh"      (Ultrathink-equivalent)
*   25K–50K      → "high"       (Think harder)
*   5K–25K       → "medium"     (Think hard)
*   < 5K         → "low"        (small explicit budget)
*
* When the caller didn't send a budget at all, default to "medium" — the
* model's adaptive controller will still ramp up if the task warrants it.
*/
function budgetToEffort$1(budget) {
	if (typeof budget !== "number" || budget <= 0) return "medium";
	if (budget >= 5e4) return "xhigh";
	if (budget >= 25e3) return "high";
	if (budget >= 5e3) return "medium";
	return "low";
}
/**
* Some Copilot models restrict `reasoning_effort` to a single value
* (e.g. claude-opus-4.7-high → ["high"], claude-opus-4.7 → ["medium"]).
* Sending a value outside that allow-list 400s upstream.
*
* Strategy when the caller's effort isn't in the supported list: **take
* the highest supported level** (xhigh > high > medium > low). Rationale:
*
*   - Single-value models like `claude-opus-4.7-high` carry their level
*     in the name; the user contract is "this model thinks at that level".
*     Falling back to the only allowed value matches the model's purpose.
*   - When the list has multiple values, picking the highest matches the
*     caller's likely intent ("they asked for thinking — give them more
*     not less"). If they wanted "minimal thinking" they wouldn't have
*     picked the high model variant.
*
* Returns the original effort if it's supported, the highest supported
* level otherwise, or undefined when the model has no reasoning_effort
* declared (effort field will be dropped by caller).
*/
const EFFORT_RANK = {
	low: 1,
	medium: 2,
	high: 3,
	xhigh: 4
};
function clampEffortForModel(effort, modelId) {
	const supported = ((state.models?.data.find((m) => m.id === modelId))?.capabilities?.supports)?.reasoning_effort;
	if (!Array.isArray(supported) || supported.length === 0) return effort;
	if (effort && supported.includes(effort)) return effort;
	const best = supported.filter((s) => s in EFFORT_RANK).sort((a, b) => (EFFORT_RANK[b] ?? 0) - (EFFORT_RANK[a] ?? 0))[0];
	if (best && effort && best !== effort) consola.debug(`[effort-clamp] model ${modelId} supports ${JSON.stringify(supported)}, caller asked for "${effort}" → forwarded as "${best}"`);
	return best;
}
/**
* Produce the payload forwarded to upstream.
*
* We pass through almost everything verbatim.  The only transformation is that
* `claude-opus-4.7+` requires the new adaptive thinking format
* (`thinking: { type: "adaptive" }` + `output_config.effort`) rather than the
* legacy `{ type: "enabled", budget_tokens: N }`.  If the caller already sent
* the correct format we leave it alone; if they sent the old format and the
* model requires adaptive, we upgrade automatically — and we **map the
* budget size to a Copilot effort level** (low/medium/high/xhigh) so the
* caller's intent isn't flattened to "medium" regardless of input.
*
* Additionally: we scrub empty content blocks before forwarding. Copilot
* routes some Anthropic requests through Google Vertex AI (the response
* `request_id` starts with `req_vrtx_`); Vertex enforces a stricter
* "messages: text content blocks must be non-empty" rule that the
* Anthropic-direct backend does not. Claude Code occasionally emits
* `{type:"text", text:""}` blocks (e.g. after a tool_use turn with no
* assistant prose); leaving them in makes upstream 400 unpredictably
* depending on which backend gets the request. See sanitiseMessages.
*/
function buildUpstreamPayload(payload, defaultEffort) {
	const { thinking, output_config, messages,...rest } = payload;
	const sanitisedMessages = sanitiseMessages(messages);
	const adjustedMaxTokens = adjustMaxTokensForBudget(rest.max_tokens, thinking, payload.model);
	const restWithMaxTokens = adjustedMaxTokens !== void 0 && adjustedMaxTokens !== rest.max_tokens ? {
		...rest,
		max_tokens: adjustedMaxTokens
	} : rest;
	if (!thinking && defaultEffort && defaultEffort !== "") {
		const clamped = clampEffortForModel(defaultEffort, payload.model) ?? defaultEffort;
		consola.debug(`[alias-effort] injecting default effort=${defaultEffort} (clamped=${clamped}) for model=${payload.model}`);
		return {
			...restWithMaxTokens,
			messages: sanitisedMessages,
			thinking: { type: "adaptive" },
			output_config: { effort: clamped }
		};
	}
	if (!thinking) return {
		...restWithMaxTokens,
		messages: sanitisedMessages
	};
	if (isAdaptiveThinkingModel(payload.model)) {
		if (thinking.type === "enabled") {
			const rawEffort = output_config?.effort ?? budgetToEffort$1(thinking.budget_tokens);
			const effort = clampEffortForModel(rawEffort, payload.model) ?? rawEffort;
			consola.debug(`Upgrading thinking format to adaptive for model ${payload.model} (budget=${thinking.budget_tokens} → effort=${effort})`);
			return {
				...restWithMaxTokens,
				messages: sanitisedMessages,
				thinking: { type: "adaptive" },
				output_config: { effort }
			};
		}
		const callerEffort = output_config?.effort;
		const clamped = clampEffortForModel(callerEffort, payload.model);
		return {
			...restWithMaxTokens,
			messages: sanitisedMessages,
			thinking,
			output_config: clamped ? { effort: clamped } : output_config
		};
	}
	return {
		...restWithMaxTokens,
		messages: sanitisedMessages,
		thinking
	};
}
/**
* Anthropic's invariant: `max_tokens > thinking.budget_tokens`. When the
* caller violates this (Claude Code occasionally pairs a generous budget
* with the default 4096 max_tokens), we silently grow `max_tokens` to
* `budget + headroom` so the request goes through.
*
* Only applies when:
*   - thinking is the legacy `{type:"enabled", budget_tokens: N}` shape
*     (adaptive thinking has no budget_tokens to clash with)
*   - the model is not in the adaptive-thinking family (those get the
*     thinking field rewritten anyway, no budget_tokens reaches upstream)
*
* Returns `undefined` to mean "no change"; the caller compares and only
* overwrites when this differs from the input.
*
* Headroom of 1024 matches Anthropic's example in the docs error message
* and stays well under any model's max_output_tokens.
*/
function adjustMaxTokensForBudget(maxTokens, thinking, modelId) {
	if (!thinking || thinking.type !== "enabled" || typeof thinking.budget_tokens !== "number") return;
	if (isAdaptiveThinkingModel(modelId)) return void 0;
	if (typeof maxTokens !== "number") return void 0;
	if (maxTokens > thinking.budget_tokens) return void 0;
	const HEADROOM = 1024;
	const bumped = thinking.budget_tokens + HEADROOM;
	consola.warn(`[max-tokens-fix] max_tokens=${maxTokens} <= budget_tokens=${thinking.budget_tokens} for ${modelId}; bumping max_tokens to ${bumped} (budget + ${HEADROOM} headroom)`);
	return bumped;
}
/**
* Strip content blocks that Copilot's Vertex-routed Anthropic backend
* rejects with "messages: text content blocks must be non-empty".
*
* Observed in the wild from Claude Code: after a tool_use turn the
* assistant sometimes emits an empty `{type:"text", text:""}` block; same
* shape from translated requests when a `content` array had whitespace
* stripped to nothing. Anthropic-direct accepts these silently, Vertex
* 400s. Routing decision is made by Copilot per-request and not under our
* control, so we always scrub.
*
* Rules:
*   - text blocks where `text` is empty/whitespace → drop the block
*   - tool_result with `content` array → recurse into nested text blocks
*   - tool_result with empty string content → coerce to a single-space
*     placeholder (tool_result MUST have content per Anthropic spec; we
*     can't just drop the whole block without orphaning the tool_use_id)
*   - if a message's content array becomes entirely empty → coerce to a
*     single-space text block (Anthropic requires non-empty content per
*     message; dropping the whole message would desync tool_use/result
*     pairing)
*   - message.content as a plain string with empty/whitespace value →
*     coerce to a single space too
*
* Pure function; does NOT mutate the input payload.
*/
function sanitiseMessages(messages) {
	const PLACEHOLDER = " ";
	let modified = false;
	const out = messages.map((msg) => {
		if (typeof msg.content === "string") {
			if (msg.content.trim().length === 0) {
				modified = true;
				return {
					...msg,
					content: PLACEHOLDER
				};
			}
			return msg;
		}
		if (!Array.isArray(msg.content)) return msg;
		const cleaned = msg.content.map((block) => {
			if (block.type === "text") {
				if (typeof block.text !== "string" || block.text.length === 0) return null;
				return block;
			}
			if (block.type === "tool_result") {
				if (typeof block.content === "string") {
					if (block.content.length === 0) return {
						...block,
						content: PLACEHOLDER
					};
					return block;
				}
				if (Array.isArray(block.content)) {
					const nestedCleaned = block.content.filter((nested) => {
						if (nested.type === "text") return typeof nested.text === "string" && nested.text.length > 0;
						return true;
					});
					if (nestedCleaned.length === 0) return {
						...block,
						content: PLACEHOLDER
					};
					if (nestedCleaned.length !== block.content.length) return {
						...block,
						content: nestedCleaned
					};
					return block;
				}
				return block;
			}
			return block;
		}).filter((b) => b !== null);
		if (cleaned.length !== msg.content.length) modified = true;
		if (cleaned.length === 0) {
			modified = true;
			return {
				...msg,
				content: [{
					type: "text",
					text: PLACEHOLDER
				}]
			};
		}
		return {
			...msg,
			content: cleaned
		};
	});
	if (modified) consola.debug("[sanitise] scrubbed empty content blocks (Vertex compatibility)");
	return out;
}
/**
* Returns true for models that require the adaptive thinking API
* (`{ type: "adaptive" }` + `output_config.effort`) rather than the
* legacy `{ type: "enabled", budget_tokens: N }`.
* Currently: claude-opus-4.7 and later.
*/
function isAdaptiveThinkingModel(model) {
	const match = model.match(/^claude-opus-4[.-](\d+)/);
	if (match) return Number.parseInt(match[1], 10) >= 7;
	return false;
}
/**
* Check whether the request contains any image blocks (to set vision headers).
*/
function messageHasImages(payload) {
	for (const msg of payload.messages) {
		if (typeof msg.content === "string") continue;
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) if (block.type === "image") return true;
		}
	}
	return false;
}
/**
* Heuristic for X-Initiator: returns true when the message history makes this
* look like an automated agent loop rather than the first turn of a manual
* conversation. Mirrors `isAgentCall` in create-responses.ts and the inline
* detector in create-chat-completions.ts:
*
*  - any prior assistant message → multi-turn → "agent"
*  - any tool_result block in user content → tool-driven → "agent"
*  - any tool_use in assistant content → "agent"
*  - otherwise → "user"
*/
function isAgentMessagesCall(payload) {
	for (const msg of payload.messages) {
		if (msg.role === "assistant") return true;
		if (Array.isArray(msg.content)) {
			for (const block of msg.content) if (block.type === "tool_result" || block.type === "tool_use") return true;
		}
	}
	return false;
}

//#endregion
//#region src/services/copilot/create-responses.ts
/**
* Returns true if any input item contains an `input_image` content part.
* Handles both a top-level string input and an array of input items.
*/
function inputHasImages(payload) {
	if (typeof payload.input === "string") return false;
	return payload.input.some((item) => {
		if (item.type !== "message") return false;
		if (typeof item.content === "string") return false;
		return item.content.some((part) => part.type === "input_image");
	});
}
/**
* Returns true if this looks like an agent/multi-turn call:
* - any input item has role "assistant", OR
* - any item has type "function_call_output", "function_call", or "reasoning"
*   (reasoning items only appear when echoing back prior agentic turn context)
*/
function isAgentCall(payload) {
	if (typeof payload.input === "string") return false;
	return payload.input.some((item) => "role" in item && item.role === "assistant" || item.type === "function_call_output" || item.type === "function_call" || item.type === "reasoning");
}
const createResponses = async (payload, onUpstream) => {
	if (!state.copilotToken) throw new Error("Copilot token not found");
	const enableVision = inputHasImages(payload);
	const initiator = isAgentCall(payload) ? "agent" : "user";
	const headers = {
		...copilotHeaders(state, enableVision),
		"X-Initiator": initiator
	};
	const url = `${copilotBaseUrl(state)}/responses`;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload)
	});
	if (onUpstream) try {
		const responseBody = payload.stream ? void 0 : await response.clone().text();
		onUpstream({
			req: {
				method: "POST",
				url,
				headers,
				body: payload
			},
			res: {
				status: response.status,
				headers: response.headers,
				body: responseBody
			}
		});
	} catch (err) {
		consola.warn(`[trace] upstream capture failed: ${String(err)}`);
	}
	if (!response.ok) {
		consola.error("Failed to create responses", response);
		throw new HTTPError("Failed to create responses", response);
	}
	if (payload.stream) return events(response);
	return await response.json();
};

//#endregion
//#region src/services/copilot/native-models.ts
/**
* Returns true if the given model ID should be routed to the native
* Anthropic pass-through service instead of the OpenAI chat-completions
* translation layer.
*
* Resolution order:
*  1. If `state.models` is populated, check whether the model's vendor is
*     "Anthropic" (live, always up-to-date).
*  2. Fall back to a static prefix list for resilience at startup before
*     the models list is fetched.
*/
function isNativeAnthropicModel(modelId) {
	if (state.models?.data) {
		const entry = state.models.data.find((m) => m.id === modelId);
		if (entry) return entry.vendor === "Anthropic";
	}
	return modelId.startsWith("claude-");
}

//#endregion
//#region src/routes/messages/anthropic-to-responses.ts
const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp"
]);
const VALID_EFFORT_VALUES = new Set([
	"low",
	"medium",
	"high"
]);
/**
* Map an extended-thinking `budget_tokens` value to a Responses API reasoning
* effort string.  Responses API only has "low" | "medium" | "high", so we
* collapse "minimal" into "low".
*/
function budgetToEffort(budgetTokens) {
	if (budgetTokens >= 1e4) return "high";
	if (budgetTokens >= 5e3) return "medium";
	return "low";
}
function buildInstructions(system) {
	if (!system) return void 0;
	if (typeof system === "string") return system;
	return system.map((b) => b.text).join("\n\n");
}
/**
* Convert a base64 Anthropic image block to a Responses API `input_image`
* content part.  Returns `undefined` if the source type is not base64 (URL
* images are not supported on the Copilot upstream) or if the media type is
* not in the allowed set (guard against data-URI injection).
*/
function translateImageBlock(block) {
	if (block.source.type !== "base64") return;
	const { media_type, data } = block.source;
	if (!ALLOWED_IMAGE_MEDIA_TYPES.has(media_type)) {
		consola.warn("Skipping image with unsupported media_type:", media_type);
		return;
	}
	return {
		type: "input_image",
		image_url: `data:${media_type};base64,${data}`
	};
}
function translateUserMessage(message) {
	const items = [];
	if (typeof message.content === "string") {
		items.push({
			type: "message",
			role: "user",
			content: message.content
		});
		return items;
	}
	const toolResultBlocks = message.content.filter((b) => b.type === "tool_result");
	const otherBlocks = message.content.filter((b) => b.type !== "tool_result");
	for (const block of toolResultBlocks) {
		const output = typeof block.content === "string" ? block.content : block.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
		items.push({
			type: "function_call_output",
			call_id: block.tool_use_id,
			output
		});
	}
	if (otherBlocks.length > 0) {
		const contentParts = [];
		for (const block of otherBlocks) if (block.type === "text") contentParts.push({
			type: "input_text",
			text: block.text
		});
		else {
			const imagePart = translateImageBlock(block);
			if (imagePart) contentParts.push(imagePart);
		}
		if (contentParts.length > 0) items.push({
			type: "message",
			role: "user",
			content: contentParts
		});
	}
	return items;
}
function translateAssistantMessage(message) {
	const items = [];
	if (typeof message.content === "string") {
		items.push({
			type: "message",
			role: "assistant",
			content: [{
				type: "output_text",
				text: message.content
			}]
		});
		return items;
	}
	for (const block of message.content) switch (block.type) {
		case "text": {
			const textBlock = block;
			items.push({
				type: "message",
				role: "assistant",
				content: [{
					type: "output_text",
					text: textBlock.text
				}]
			});
			break;
		}
		case "thinking": {
			const thinkingBlock = block;
			const reasoningItem = {
				type: "reasoning",
				id: `reasoning_${crypto.randomUUID()}`,
				summary: [{
					type: "summary_text",
					text: thinkingBlock.thinking
				}],
				...thinkingBlock.signature !== void 0 && { encrypted_content: thinkingBlock.signature }
			};
			items.push(reasoningItem);
			break;
		}
		case "tool_use": {
			const toolUseBlock = block;
			items.push({
				type: "function_call",
				call_id: toolUseBlock.id,
				name: toolUseBlock.name,
				arguments: JSON.stringify(toolUseBlock.input)
			});
			break;
		}
		default: break;
	}
	return items;
}
function translateTools(tools) {
	if (!tools || tools.length === 0) return void 0;
	return tools.map((tool) => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.input_schema
	}));
}
function translateToolChoice(toolChoice) {
	if (!toolChoice) return void 0;
	switch (toolChoice.type) {
		case "auto": return "auto";
		case "any": return "required";
		case "tool":
			if (toolChoice.name) return {
				type: "function",
				name: toolChoice.name
			};
			consola.warn("tool_choice.type is 'tool' but no name was provided — falling back to 'auto'");
			return "auto";
		case "none": return "none";
		default: return;
	}
}
function translateReasoning(thinking, outputConfig, defaultEffort) {
	if (!thinking) {
		if (defaultEffort && defaultEffort !== "") {
			const e = defaultEffort === "xhigh" ? "high" : VALID_EFFORT_VALUES.has(defaultEffort) ? defaultEffort : null;
			if (e) return { effort: e };
		}
		return;
	}
	if (thinking.type === "adaptive") {
		const rawEffort = outputConfig?.effort;
		return { effort: rawEffort !== void 0 && VALID_EFFORT_VALUES.has(rawEffort) ? rawEffort : "medium" };
	}
	if (thinking.budget_tokens !== void 0) return { effort: budgetToEffort(thinking.budget_tokens) };
	return { effort: "medium" };
}
function translateAnthropicToResponses(payload, defaultEffort) {
	const inputItems = [];
	for (const message of payload.messages) if (message.role === "user") inputItems.push(...translateUserMessage(message));
	else inputItems.push(...translateAssistantMessage(message));
	return {
		model: payload.model,
		input: inputItems,
		instructions: buildInstructions(payload.system),
		tools: translateTools(payload.tools),
		tool_choice: translateToolChoice(payload.tool_choice),
		temperature: payload.temperature,
		top_p: payload.top_p,
		max_output_tokens: payload.max_tokens,
		reasoning: translateReasoning(payload.thinking, payload.output_config, defaultEffort),
		stream: payload.stream,
		user: payload.metadata?.user_id
	};
}

//#endregion
//#region src/routes/messages/responses-stream-translation.ts
function makeResponsesStreamState() {
	return {
		messageStartSent: false,
		blockIndex: 0,
		outputIndexToBlockIndex: /* @__PURE__ */ new Map(),
		reasoningOutputIndexes: /* @__PURE__ */ new Set(),
		functionCallOutputIndexes: /* @__PURE__ */ new Set(),
		messageId: "",
		messageModel: "",
		eventCount: 0
	};
}
const PING_INTERVAL = 20;
function mapResponsesStatusToStopReason(status) {
	switch (status) {
		case "completed": return "end_turn";
		case "incomplete": return "max_tokens";
		default: return "end_turn";
	}
}
/**
* Translate one upstream Responses API SSE event into zero or more Anthropic
* SSE events.  Mutates `state` as a side-effect.
*
* Never throws — unknown / unparseable events are silently skipped so we never
* block stream forwarding.
*/
function translateResponsesEventToAnthropic(eventType, data, state$1) {
	const events$1 = [];
	state$1.eventCount++;
	if (state$1.messageStartSent && state$1.eventCount % PING_INTERVAL === 0) events$1.push({ type: "ping" });
	switch (eventType) {
		case "response.created":
		case "response.in_progress": {
			const responseData = data?.response;
			if (!state$1.messageStartSent) {
				state$1.messageId = responseData?.id ?? `msg_fallback_${Date.now()}`;
				state$1.messageModel = responseData?.model ?? "";
				events$1.push({
					type: "message_start",
					message: {
						id: state$1.messageId,
						type: "message",
						role: "assistant",
						content: [],
						model: state$1.messageModel,
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 0,
							output_tokens: 0
						}
					}
				});
				state$1.messageStartSent = true;
			}
			break;
		}
		case "response.output_item.added": {
			const d = data;
			const item = d?.item;
			const outputIndex = d?.output_index;
			if (item === void 0 || outputIndex === void 0) break;
			switch (item.type) {
				case "reasoning": {
					const blockIndex = state$1.blockIndex++;
					state$1.outputIndexToBlockIndex.set(outputIndex, blockIndex);
					state$1.reasoningOutputIndexes.add(outputIndex);
					events$1.push({
						type: "content_block_start",
						index: blockIndex,
						content_block: {
							type: "thinking",
							thinking: ""
						}
					});
					break;
				}
				case "message": {
					const blockIndex = state$1.blockIndex++;
					state$1.outputIndexToBlockIndex.set(outputIndex, blockIndex);
					events$1.push({
						type: "content_block_start",
						index: blockIndex,
						content_block: {
							type: "text",
							text: ""
						}
					});
					break;
				}
				case "function_call": {
					const blockIndex = state$1.blockIndex++;
					state$1.outputIndexToBlockIndex.set(outputIndex, blockIndex);
					state$1.functionCallOutputIndexes.add(outputIndex);
					events$1.push({
						type: "content_block_start",
						index: blockIndex,
						content_block: {
							type: "tool_use",
							id: item.call_id ?? item.id ?? "",
							name: item.name ?? "",
							input: {}
						}
					});
					break;
				}
				default: break;
			}
			break;
		}
		case "response.reasoning_summary_text.delta": {
			const d = data;
			const delta = d?.delta;
			const outputIndex = d?.output_index;
			if (delta === void 0 || outputIndex === void 0) break;
			const blockIndex = state$1.outputIndexToBlockIndex.get(outputIndex);
			if (blockIndex === void 0) break;
			events$1.push({
				type: "content_block_delta",
				index: blockIndex,
				delta: {
					type: "thinking_delta",
					thinking: delta
				}
			});
			break;
		}
		case "response.reasoning_summary_text.done": break;
		case "response.output_item.done": {
			const d = data;
			const item = d?.item;
			const outputIndex = d?.output_index;
			if (item === void 0 || outputIndex === void 0) break;
			const blockIndex = state$1.outputIndexToBlockIndex.get(outputIndex);
			if (blockIndex === void 0) break;
			if (state$1.reasoningOutputIndexes.has(outputIndex)) {
				if (item.encrypted_content) events$1.push({
					type: "content_block_delta",
					index: blockIndex,
					delta: {
						type: "signature_delta",
						signature: item.encrypted_content
					}
				});
				events$1.push({
					type: "content_block_stop",
					index: blockIndex
				});
				state$1.outputIndexToBlockIndex.delete(outputIndex);
				state$1.reasoningOutputIndexes.delete(outputIndex);
			} else if (state$1.functionCallOutputIndexes.has(outputIndex)) {
				events$1.push({
					type: "content_block_stop",
					index: blockIndex
				});
				state$1.outputIndexToBlockIndex.delete(outputIndex);
				state$1.functionCallOutputIndexes.delete(outputIndex);
			}
			break;
		}
		case "response.output_text.delta": {
			const d = data;
			const delta = d?.delta;
			const outputIndex = d?.output_index;
			if (delta === void 0 || outputIndex === void 0) break;
			const blockIndex = state$1.outputIndexToBlockIndex.get(outputIndex);
			if (blockIndex === void 0) break;
			events$1.push({
				type: "content_block_delta",
				index: blockIndex,
				delta: {
					type: "text_delta",
					text: delta
				}
			});
			break;
		}
		case "response.output_text.done": break;
		case "response.content_part.done": {
			const outputIndex = data?.output_index;
			if (outputIndex === void 0) break;
			const blockIndex = state$1.outputIndexToBlockIndex.get(outputIndex);
			if (blockIndex === void 0) break;
			if (!state$1.reasoningOutputIndexes.has(outputIndex) && !state$1.functionCallOutputIndexes.has(outputIndex)) {
				events$1.push({
					type: "content_block_stop",
					index: blockIndex
				});
				state$1.outputIndexToBlockIndex.delete(outputIndex);
			}
			break;
		}
		case "response.content_part.added": break;
		case "response.function_call_arguments.delta": {
			const d = data;
			const delta = d?.delta;
			const outputIndex = d?.output_index;
			if (delta === void 0 || outputIndex === void 0) break;
			const blockIndex = state$1.outputIndexToBlockIndex.get(outputIndex);
			if (blockIndex === void 0) break;
			events$1.push({
				type: "content_block_delta",
				index: blockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: delta
				}
			});
			break;
		}
		case "response.function_call_arguments.done": break;
		case "response.completed": {
			const d = data;
			if (!state$1.messageStartSent) {
				state$1.messageId = d?.response?.id ?? `msg_fallback_${Date.now()}`;
				state$1.messageModel = d?.response?.model ?? "";
				events$1.push({
					type: "message_start",
					message: {
						id: state$1.messageId,
						type: "message",
						role: "assistant",
						content: [],
						model: state$1.messageModel,
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 0,
							output_tokens: 0
						}
					}
				});
				state$1.messageStartSent = true;
			}
			for (const blockIndex of state$1.outputIndexToBlockIndex.values()) events$1.push({
				type: "content_block_stop",
				index: blockIndex
			});
			state$1.outputIndexToBlockIndex.clear();
			state$1.reasoningOutputIndexes.clear();
			state$1.functionCallOutputIndexes.clear();
			events$1.push({
				type: "message_delta",
				delta: {
					stop_reason: mapResponsesStatusToStopReason(d?.response?.status ?? "completed"),
					stop_sequence: null
				},
				usage: {
					input_tokens: d?.response?.usage?.input_tokens ?? 0,
					output_tokens: d?.response?.usage?.output_tokens ?? 0
				}
			}, { type: "message_stop" });
			break;
		}
		case "response.failed": {
			const message = data?.response?.error?.message ?? "Upstream model call failed";
			if (!state$1.messageStartSent) {
				state$1.messageId = `msg_fallback_${Date.now()}`;
				events$1.push({
					type: "message_start",
					message: {
						id: state$1.messageId,
						type: "message",
						role: "assistant",
						content: [],
						model: "",
						stop_reason: null,
						stop_sequence: null,
						usage: {
							input_tokens: 0,
							output_tokens: 0
						}
					}
				});
				state$1.messageStartSent = true;
			}
			for (const blockIndex of state$1.outputIndexToBlockIndex.values()) events$1.push({
				type: "content_block_stop",
				index: blockIndex
			});
			state$1.outputIndexToBlockIndex.clear();
			state$1.reasoningOutputIndexes.clear();
			state$1.functionCallOutputIndexes.clear();
			events$1.push({
				type: "error",
				error: {
					type: "api_error",
					message
				}
			}, {
				type: "message_delta",
				delta: {
					stop_reason: "end_turn",
					stop_sequence: null
				},
				usage: {
					input_tokens: 0,
					output_tokens: 0
				}
			}, { type: "message_stop" });
			break;
		}
		default: break;
	}
	return events$1;
}

//#endregion
//#region src/routes/messages/responses-to-anthropic.ts
/**
* Translates a Responses API `ResponsesResponse` into an Anthropic
* `AnthropicResponse` so the /v1/messages handler can return a format that
* Anthropic clients understand.
*/
const DANGEROUS_KEYS = new Set([
	"__proto__",
	"constructor",
	"prototype"
]);
function mapStatus(status) {
	switch (status) {
		case "completed": return "end_turn";
		case "incomplete": return "max_tokens";
		default: return null;
	}
}
function translateReasoningItem(item) {
	const block = {
		type: "thinking",
		thinking: item.summary?.[0]?.text ?? ""
	};
	if (item.encrypted_content !== void 0) block.signature = item.encrypted_content;
	return block;
}
function translateMessageItem(item) {
	const textParts = item.content.filter((p) => p.type === "output_text");
	const refusalParts = item.content.filter((p) => p.type === "refusal");
	if (textParts.length === 0 && refusalParts.length === 0) return [];
	return [{
		type: "text",
		text: [...textParts.map((p) => p.text), ...refusalParts.map((p) => p.refusal)].join("")
	}];
}
function translateFunctionCallItem(item) {
	let parsedInput;
	try {
		const raw = JSON.parse(item.arguments);
		parsedInput = typeof raw !== "object" || raw === null || Array.isArray(raw) ? { _raw: item.arguments } : Object.fromEntries(Object.entries(raw).filter(([k]) => !DANGEROUS_KEYS.has(k)));
	} catch {
		parsedInput = { _raw: item.arguments };
	}
	return {
		type: "tool_use",
		id: item.call_id,
		name: item.name,
		input: parsedInput
	};
}
function deriveStopReason(response) {
	if (response.output.some((item) => item.type === "function_call")) return "tool_use";
	return mapStatus(response.status);
}
function translateResponsesToAnthropic(response) {
	const contentBlocks = [];
	for (const item of response.output) switch (item.type) {
		case "reasoning":
			contentBlocks.push(translateReasoningItem(item));
			break;
		case "message":
			contentBlocks.push(...translateMessageItem(item));
			break;
		case "function_call":
			contentBlocks.push(translateFunctionCallItem(item));
			break;
		default: break;
	}
	return {
		id: response.id,
		type: "message",
		role: "assistant",
		model: response.model,
		content: contentBlocks,
		stop_reason: deriveStopReason(response),
		stop_sequence: null,
		usage: {
			input_tokens: response.usage?.input_tokens ?? 0,
			output_tokens: response.usage?.output_tokens ?? 0,
			...response.usage?.input_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens }
		}
	};
}

//#endregion
//#region src/routes/messages/stream-translation.ts
/**
* Telemetry helper (issue #34): inspect a parsed Anthropic stream event and
* stash any usage figures it carries on the Hono context for the telemetry
* middleware.
*
* Preference order:
*   1. Copilot's `copilot_usage.token_details` if the event carries it
*      (Copilot embeds this on `message_delta` events alongside the native
*      anthropic `usage` block). This gives us the canonical input /
*      output / cache_read / cache_write counts.
*   2. Native Anthropic `usage.input_tokens` / `usage.output_tokens` as
*      captured by previous versions.
*
* Returns the updated `(input, output)` pair so the caller can keep its
* own running state without re-reading the event.
*/
function stashAnthropicUsage(c, parsed, prev) {
	let [input, output] = prev;
	const fromCopilot = readCopilotUsage(parsed);
	if (fromCopilot.prompt_tokens !== void 0 || fromCopilot.completion_tokens !== void 0 || fromCopilot.cache_read_tokens !== void 0 || fromCopilot.cache_creation_tokens !== void 0) {
		if (fromCopilot.prompt_tokens !== void 0) input = fromCopilot.prompt_tokens;
		if (fromCopilot.completion_tokens !== void 0) output = fromCopilot.completion_tokens;
		c.set("usage", fromCopilot);
		return [input, output];
	}
	if (parsed.type === "message_start") {
		const usage = parsed.message?.usage;
		if (typeof usage?.input_tokens === "number") input = usage.input_tokens;
		if (typeof usage?.output_tokens === "number") output = usage.output_tokens;
	} else if (parsed.type === "message_delta") {
		const u = parsed.usage;
		if (u) {
			if (typeof u.input_tokens === "number") input = u.input_tokens;
			if (typeof u.output_tokens === "number") output = u.output_tokens;
		}
	}
	if (input !== void 0 || output !== void 0) c.set("usage", {
		prompt_tokens: input,
		completion_tokens: output
	});
	return [input, output];
}
function isToolBlockOpen(state$1) {
	if (!state$1.contentBlockOpen) return false;
	return Object.values(state$1.toolCalls).some((tc) => tc.anthropicBlockIndex === state$1.contentBlockIndex);
}
function translateChunkToAnthropicEvents(chunk, state$1) {
	const events$1 = [];
	if (chunk.choices.length === 0) {
		if (state$1.messageStartSent && chunk.usage) events$1.push({
			type: "message_delta",
			delta: {
				stop_reason: null,
				stop_sequence: null
			},
			usage: {
				input_tokens: (chunk.usage.prompt_tokens ?? 0) - (chunk.usage.prompt_tokens_details?.cached_tokens ?? 0),
				output_tokens: chunk.usage.completion_tokens ?? 0,
				...chunk.usage.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
			}
		});
		return events$1;
	}
	const choice = chunk.choices[0];
	const delta = choice.delta ?? {};
	if (!state$1.messageStartSent) {
		events$1.push({
			type: "message_start",
			message: {
				id: chunk.id,
				type: "message",
				role: "assistant",
				content: [],
				model: chunk.model,
				stop_reason: null,
				stop_sequence: null,
				usage: {
					input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
					output_tokens: 0,
					...chunk.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
				}
			}
		});
		state$1.messageStartSent = true;
	}
	if (delta.content) {
		if (isToolBlockOpen(state$1)) {
			events$1.push({
				type: "content_block_stop",
				index: state$1.contentBlockIndex
			});
			state$1.contentBlockIndex++;
			state$1.contentBlockOpen = false;
		}
		if (!state$1.contentBlockOpen) {
			events$1.push({
				type: "content_block_start",
				index: state$1.contentBlockIndex,
				content_block: {
					type: "text",
					text: ""
				}
			});
			state$1.contentBlockOpen = true;
		}
		events$1.push({
			type: "content_block_delta",
			index: state$1.contentBlockIndex,
			delta: {
				type: "text_delta",
				text: delta.content
			}
		});
	}
	if (delta.tool_calls) for (const toolCall of delta.tool_calls) {
		if (toolCall.id && toolCall.function?.name) {
			if (state$1.contentBlockOpen) {
				events$1.push({
					type: "content_block_stop",
					index: state$1.contentBlockIndex
				});
				state$1.contentBlockIndex++;
				state$1.contentBlockOpen = false;
			}
			const anthropicBlockIndex = state$1.contentBlockIndex;
			state$1.toolCalls[toolCall.index] = {
				id: toolCall.id,
				name: toolCall.function.name,
				anthropicBlockIndex
			};
			events$1.push({
				type: "content_block_start",
				index: anthropicBlockIndex,
				content_block: {
					type: "tool_use",
					id: toolCall.id,
					name: toolCall.function.name,
					input: {}
				}
			});
			state$1.contentBlockOpen = true;
		}
		if (toolCall.function?.arguments) {
			const toolCallInfo = state$1.toolCalls[toolCall.index];
			if (toolCallInfo) events$1.push({
				type: "content_block_delta",
				index: toolCallInfo.anthropicBlockIndex,
				delta: {
					type: "input_json_delta",
					partial_json: toolCall.function.arguments
				}
			});
		}
	}
	if (choice.finish_reason) {
		if (state$1.contentBlockOpen) {
			events$1.push({
				type: "content_block_stop",
				index: state$1.contentBlockIndex
			});
			state$1.contentBlockOpen = false;
		}
		events$1.push({
			type: "message_delta",
			delta: {
				stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
				stop_sequence: null
			},
			usage: {
				input_tokens: (chunk.usage?.prompt_tokens ?? 0) - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
				output_tokens: chunk.usage?.completion_tokens ?? 0,
				...chunk.usage?.prompt_tokens_details?.cached_tokens !== void 0 && { cache_read_input_tokens: chunk.usage.prompt_tokens_details.cached_tokens }
			}
		}, { type: "message_stop" });
	}
	return events$1;
}

//#endregion
//#region src/routes/messages/handler.ts
async function handleCompletion(c) {
	await checkRateLimit(state);
	const anthropicPayload = await c.req.json();
	consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload));
	const stripped = anthropicPayload;
	delete stripped.context_management;
	delete stripped.context_mgmt;
	const resolved = applyDefaultModelRewrite(c, anthropicPayload.model, "/v1/messages");
	if (isAppliedError(resolved)) return resolved;
	const { clientRequestedModel, clientAlias, upstreamModel } = resolved;
	const payload = {
		...anthropicPayload,
		model: upstreamModel
	};
	const key = c.get("key");
	if (!isModelAllowed(key.allowed_models, clientAlias)) return c.json({ error: {
		message: `Model "${clientRequestedModel}" is not in your key's allowed models`,
		type: "permission_denied",
		code: "model_not_allowed"
	} }, 403);
	if (state.manualApprove) await awaitApproval();
	if (isNativeAnthropicModel(payload.model)) return handleNative(c, payload, clientAlias);
	if (getModelMode(payload.model) === "responses") return handleAnthropicViaResponses(c, payload, clientAlias);
	return handleTranslated(c, payload, clientAlias);
}
async function handleNative(c, payload, clientAlias) {
	consola.debug("Using native Anthropic pass-through for", payload.model);
	const onUpstream = c.var.trace_capture_upstream;
	const clientBeta = c.req.header("anthropic-beta");
	const defaultEffort = getConfig().models[clientAlias]?.default_effort;
	const response = await createMessagesNative(payload, onUpstream, clientBeta, defaultEffort);
	if (!payload.stream) {
		consola.debug("Native non-streaming response:", JSON.stringify(response).slice(0, 400));
		c.set("usage", readCopilotUsage(response));
		return c.json(response);
	}
	consola.debug("Native streaming response — proxying SSE events");
	return streamSSE(c, async (stream) => {
		let inputTokens;
		let outputTokens;
		try {
			for await (const rawEvent of response) {
				if (!rawEvent.data) continue;
				await stream.writeSSE({
					event: rawEvent.event,
					data: rawEvent.data
				});
				if (rawEvent.data === "[DONE]") continue;
				try {
					const parsed = JSON.parse(rawEvent.data);
					consola.debug("Native SSE event:", parsed.type);
					[inputTokens, outputTokens] = stashAnthropicUsage(c, parsed, [inputTokens, outputTokens]);
				} catch {
					consola.warn("Could not parse native SSE chunk for logging:", rawEvent.data.slice(0, 200));
				}
			}
		} catch (err) {
			consola.error("Native Anthropic SSE iteration failed:", err);
			try {
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						type: "error",
						error: {
							type: "api_error",
							message: "Upstream stream interrupted"
						}
					})
				});
				await stream.writeSSE({
					event: "message_stop",
					data: JSON.stringify({ type: "message_stop" })
				});
			} catch {}
		}
	}, async (err, stream) => {
		consola.error("Native Anthropic SSE outer error:", err);
		try {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						message: "Stream write failed"
					}
				})
			});
		} catch {}
	});
}
async function handleAnthropicViaResponses(c, payload, clientAlias) {
	consola.debug("Routing /v1/messages via Responses API for", payload.model);
	const defaultEffort = getConfig().models[clientAlias]?.default_effort;
	if (payload.stream) return streamResponsesAsAnthropic(c, payload, defaultEffort);
	const responsesPayload = translateAnthropicToResponses(payload, defaultEffort);
	const onUpstreamRes = c.var.trace_capture_upstream;
	const rawResponse = await createResponses({
		...responsesPayload,
		stream: false
	}, onUpstreamRes);
	if (!("output" in rawResponse)) {
		consola.error("Unexpected non-response shape from createResponses:", rawResponse);
		return c.json({ error: {
			message: "Upstream returned unexpected response shape",
			type: "api_error",
			code: "invalid_upstream_response"
		} }, 502);
	}
	const typedResponse = rawResponse;
	if (typedResponse.status !== "completed" && typedResponse.status !== "incomplete") {
		const errMsg = typedResponse.error?.message ?? `Upstream returned status="${typedResponse.status}"`;
		consola.error(`Responses API non-terminal status (status=${typedResponse.status}):`, errMsg);
		const httpStatus = typedResponse.status === "failed" ? 500 : 502;
		return c.json({ error: {
			message: errMsg,
			type: "api_error",
			code: "model_error"
		} }, httpStatus);
	}
	const sanitised = sanitiseResponsesOutput(typedResponse);
	const anthropicResponse = translateResponsesToAnthropic(sanitised);
	c.set("usage", readCopilotUsage(typedResponse));
	consola.debug("Responses→Anthropic translated response:", JSON.stringify(anthropicResponse).slice(0, 400));
	return c.json(anthropicResponse);
}
async function handleTranslated(c, anthropicPayload, clientAlias) {
	const openAIPayload = translateToOpenAI(anthropicPayload);
	consola.debug("Translated OpenAI request payload:", JSON.stringify(openAIPayload));
	const aliasDefault = getConfig().models[clientAlias]?.default_effort;
	let finalPayload = openAIPayload;
	if (!openAIPayload.reasoning_effort && aliasDefault && aliasDefault !== "") {
		const e = aliasDefault === "xhigh" ? "high" : aliasDefault;
		consola.debug(`[alias-effort] injecting reasoning_effort=${e} (alias=${clientAlias}, translated path)`);
		finalPayload = {
			...openAIPayload,
			reasoning_effort: e
		};
	}
	const onUpstream = c.var.trace_capture_upstream;
	const response = await createChatCompletions(finalPayload, onUpstream);
	if (isNonStreaming(response)) {
		consola.debug("Non-streaming response from Copilot:", JSON.stringify(response).slice(-400));
		c.set("usage", readCopilotUsage(response));
		const anthropicResponse = translateToAnthropic(response);
		consola.debug("Translated Anthropic response:", JSON.stringify(anthropicResponse));
		return c.json(anthropicResponse);
	}
	consola.debug("Streaming response from Copilot");
	return streamSSE(c, async (stream) => {
		const streamState = {
			messageStartSent: false,
			contentBlockIndex: 0,
			contentBlockOpen: false,
			toolCalls: {}
		};
		try {
			for await (const rawEvent of response) {
				consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent));
				if (rawEvent.data === "[DONE]") break;
				if (!rawEvent.data) continue;
				let chunk;
				try {
					chunk = JSON.parse(rawEvent.data);
				} catch (parseErr) {
					consola.warn(`[/v1/messages stream] dropped unparseable chunk (${String(parseErr)}):`, rawEvent.data.slice(0, 200));
					continue;
				}
				const u = readCopilotUsage(chunk);
				if (u.prompt_tokens !== void 0 || u.completion_tokens !== void 0) c.set("usage", u);
				const events$1 = translateChunkToAnthropicEvents(chunk, streamState);
				for (const event of events$1) {
					consola.debug("Translated Anthropic event:", JSON.stringify(event));
					await stream.writeSSE({
						event: event.type,
						data: JSON.stringify(event)
					});
				}
			}
		} catch (err) {
			consola.error("Translated /v1/messages SSE iteration failed:", err);
			try {
				if (streamState.contentBlockOpen) await stream.writeSSE({
					event: "content_block_stop",
					data: JSON.stringify({
						type: "content_block_stop",
						index: streamState.contentBlockIndex
					})
				});
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						type: "error",
						error: {
							type: "api_error",
							message: "Upstream stream interrupted"
						}
					})
				});
				await stream.writeSSE({
					event: "message_stop",
					data: JSON.stringify({ type: "message_stop" })
				});
			} catch {}
		}
	}, async (err, stream) => {
		consola.error("Translated /v1/messages SSE outer error:", err);
		try {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					type: "error",
					error: {
						type: "api_error",
						message: "Stream write failed"
					}
				})
			});
		} catch {}
	});
}
const isNonStreaming = (response) => Object.hasOwn(response, "choices");
function streamResponsesAsAnthropic(c, payload, defaultEffort) {
	const responsesPayload = translateAnthropicToResponses(payload, defaultEffort);
	const onUpstreamStream = c.var.trace_capture_upstream;
	const upstreamPromise = createResponses({
		...responsesPayload,
		stream: true
	}, onUpstreamStream).catch((err) => err);
	return (async () => {
		const settled = await upstreamPromise;
		if (settled instanceof Error) {
			consola.error("Responses upstream call failed pre-stream:", settled);
			return forwardError(c, settled);
		}
		const rawResponse = settled;
		return streamSSE(c, async (stream) => {
			const streamState = makeResponsesStreamState();
			let inputTokens;
			let outputTokens;
			try {
				for await (const rawEvent of rawResponse) {
					const eventType = rawEvent.event ?? "";
					let parsedData = void 0;
					if (rawEvent.data) try {
						parsedData = JSON.parse(rawEvent.data);
					} catch {
						consola.warn("Could not parse Responses SSE chunk:", rawEvent.data.slice(0, 200));
					}
					consola.debug("Responses SSE event:", eventType);
					const anthropicEvents = translateResponsesEventToAnthropic(eventType, parsedData, streamState);
					for (const event of anthropicEvents) {
						consola.debug("Translated Responses→Anthropic event:", event.type);
						[inputTokens, outputTokens] = stashAnthropicUsage(c, event, [inputTokens, outputTokens]);
						await stream.writeSSE({
							event: event.type,
							data: JSON.stringify(event)
						});
					}
				}
			} catch (err) {
				consola.error("Error during Responses API streaming:", err);
				try {
					for (const blockIndex of streamState.outputIndexToBlockIndex.values()) await stream.writeSSE({
						event: "content_block_stop",
						data: JSON.stringify({
							type: "content_block_stop",
							index: blockIndex
						})
					});
					await stream.writeSSE({
						event: "error",
						data: JSON.stringify({
							type: "error",
							error: {
								type: "api_error",
								message: "Upstream stream interrupted"
							}
						})
					});
					await stream.writeSSE({
						event: "message_stop",
						data: JSON.stringify({ type: "message_stop" })
					});
				} catch {}
			}
		}, async (err, stream) => {
			consola.error("Responses→Anthropic SSE outer error:", err);
			try {
				await stream.writeSSE({
					event: "error",
					data: JSON.stringify({
						type: "error",
						error: {
							type: "api_error",
							message: "Stream write failed"
						}
					})
				});
			} catch {}
		});
	})();
}

//#endregion
//#region src/routes/messages/route.ts
const messageRoutes = new Hono();
messageRoutes.post("/", async (c) => {
	try {
		return await handleCompletion(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});
messageRoutes.post("/count_tokens", async (c) => {
	try {
		return await handleCountTokens(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/models/route.ts
const modelRoutes = new Hono();
modelRoutes.get("/", async (c) => {
	try {
		if (!state.models) await cacheModels();
		const { models: configModels } = getConfig();
		if (Object.keys(configModels).length > 0) {
			const data = Object.entries(configModels).filter(([, entry]) => entry.enabled).map(([alias, entry]) => ({
				id: alias,
				object: "model",
				type: "model",
				created: 0,
				created_at: (/* @__PURE__ */ new Date(0)).toISOString(),
				owned_by: entry.upstream,
				display_name: alias,
				mode: getModelMode(entry.upstream)
			}));
			return c.json({
				object: "list",
				data,
				has_more: false
			});
		}
		const upstreamModels = state.models?.data.map((model) => ({
			id: model.id,
			object: "model",
			type: "model",
			created: 0,
			created_at: (/* @__PURE__ */ new Date(0)).toISOString(),
			owned_by: model.vendor,
			display_name: model.name,
			mode: getModelMode(model.id)
		}));
		return c.json({
			object: "list",
			data: upstreamModels,
			has_more: false
		});
	} catch (error) {
		return await forwardError(c, error);
	}
});

//#endregion
//#region src/routes/responses/handler.ts
async function handleResponses(c) {
	let payload;
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: {
			message: "Invalid JSON body",
			type: "invalid_request_error",
			code: "invalid_json"
		} }, 400);
	}
	consola.debug("Responses API request payload:", JSON.stringify(payload));
	const resolved = applyDefaultModelRewrite(c, payload.model, "/v1/responses");
	if (isAppliedError(resolved)) return resolved;
	const { clientRequestedModel, clientAlias, upstreamModel } = resolved;
	payload = {
		...payload,
		model: upstreamModel
	};
	const key = c.get("key");
	if (!isModelAllowed(key.allowed_models, clientAlias)) return c.json({ error: {
		message: `Model "${clientRequestedModel}" is not in your key's allowed models`,
		type: "permission_denied",
		code: "model_not_allowed"
	} }, 403);
	if (state.manualApprove) await awaitApproval();
	await checkRateLimit(state);
	const aliasDefault = getConfig().models[clientAlias]?.default_effort;
	if (!payload.reasoning?.effort && aliasDefault && aliasDefault !== "") {
		const e = aliasDefault === "xhigh" ? "high" : aliasDefault;
		consola.debug(`[alias-effort] injecting reasoning.effort=${e} (alias=${clientAlias})`);
		payload = {
			...payload,
			reasoning: {
				...payload.reasoning,
				effort: e
			}
		};
	}
	const onUpstream = c.var.trace_capture_upstream;
	const response = await createResponses(payload, onUpstream);
	if (!payload.stream) {
		const sanitised = sanitiseResponsesOutput(response);
		consola.debug("Responses non-streaming response:", JSON.stringify(sanitised).slice(0, 400));
		c.set("usage", readCopilotUsage(sanitised));
		return c.json(sanitised);
	}
	return streamResponsesEvents(c, response);
}
function streamResponsesEvents(c, response) {
	consola.debug("Responses streaming response — proxying SSE events");
	return streamSSE(c, async (stream) => {
		try {
			for await (const rawEvent of response) {
				if (!rawEvent.data) continue;
				const forwardData = sanitiseSseDataIfPossible(rawEvent.data);
				await stream.writeSSE({
					event: rawEvent.event,
					data: forwardData
				});
			}
		} catch (err) {
			consola.error("Responses SSE iteration failed:", err);
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					type: "api_error",
					message: "Upstream stream interrupted"
				})
			});
		}
	}, async (err, stream) => {
		consola.error("Responses SSE outer error:", err);
		try {
			await stream.writeSSE({
				event: "error",
				data: JSON.stringify({
					type: "api_error",
					message: "Stream write failed"
				})
			});
		} catch {}
	});
}
/**
* SSE events like `response.output_item.done` carry full item snapshots which
* can contain `status: null` that upstream rejects on re-submission.  We
* parse, sanitise the embedded item/output, and re-serialise.  Failures fall
* through to the original verbatim string so a malformed chunk doesn't break
* the stream.
*/
function sanitiseSseDataIfPossible(data) {
	if (data === "[DONE]") return data;
	try {
		const parsed = JSON.parse(data);
		consola.debug("Responses SSE event:", parsed.type);
		if (parsed["item"]) parsed["item"] = sanitiseOutputItem(parsed["item"]);
		if (Array.isArray(parsed["output"])) parsed["output"] = parsed["output"].map((i) => sanitiseOutputItem(i));
		return JSON.stringify(parsed);
	} catch {
		consola.warn("Could not parse Responses SSE chunk for logging:", data.slice(0, 200));
		return data;
	}
}

//#endregion
//#region src/routes/responses/route.ts
const responses = new Hono();
responses.post("/", async (c) => {
	try {
		return await handleResponses(c);
	} catch (error) {
		return await forwardError(c, error);
	}
});
var route_default = responses;

//#endregion
//#region src/routes/token/route.ts
const tokenRoute = new Hono();
tokenRoute.get("/", (c) => {
	try {
		return c.json({ token: state.copilotToken });
	} catch (error) {
		console.error("Error fetching token:", error);
		return c.json({
			error: "Failed to fetch token",
			token: null
		}, 500);
	}
});

//#endregion
//#region src/routes/usage/route.ts
const usageRoute = new Hono();
usageRoute.get("/", async (c) => {
	try {
		const usage = await getCopilotUsage();
		return c.json(usage);
	} catch (error) {
		console.error("Error fetching Copilot usage:", error);
		return c.json({ error: "Failed to fetch Copilot usage" }, 500);
	}
});

//#endregion
//#region src/server.ts
const server = new Hono();
server.use(logger());
server.use(cors());
server.get("/", (c) => c.text("Server running"));
server.get("/healthz", (c) => c.json({ status: "ok" }));
server.get("/readyz", (c) => {
	try {
		getDb().query("SELECT 1").get();
	} catch {
		return c.json({
			status: "error",
			reason: "db_unavailable"
		}, 503);
	}
	if (!state.copilotToken) return c.json({
		status: "error",
		reason: "copilot_token_missing"
	}, 503);
	return c.json({ status: "ok" });
});
const SPA_DIR = (() => {
	const here = import.meta.dirname;
	for (const candidate of [path.resolve(here, "../dist/ui"), path.resolve(here, "ui")]) if (fs$1.existsSync(path.join(candidate, "index.html"))) return candidate;
	return path.resolve(here, "../dist/ui");
})();
const SPA_INDEX = path.join(SPA_DIR, "index.html");
const MIME = {
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8"
};
function mimeFor(p) {
	const ext = path.extname(p).toLowerCase();
	return MIME[ext] ?? "application/octet-stream";
}
server.get("/admin/_app/*", (c) => {
	const reqPath = c.req.path.replace(/^\/admin\/_app\//, "");
	const filePath = path.resolve(SPA_DIR, reqPath);
	if (!filePath.startsWith(SPA_DIR + path.sep)) return c.text("Not Found", 404);
	try {
		const body = fs$1.readFileSync(filePath);
		return c.body(body, 200, {
			"Content-Type": mimeFor(filePath),
			"Cache-Control": "public, max-age=31536000, immutable"
		});
	} catch {
		return c.text("Not Found", 404);
	}
});
server.get("/admin/assets/*", (c) => {
	const assetsDir = path.join(import.meta.dirname, "admin/assets") + path.sep;
	const reqPath = c.req.path.replace("/admin/assets/", "");
	const filePath = path.join(assetsDir, reqPath);
	if (!filePath.startsWith(assetsDir)) return c.text("Not Found", 404);
	let content;
	let contentType;
	try {
		content = fs$1.readFileSync(filePath, "utf8");
	} catch {
		return c.text("Not Found", 404);
	}
	if (filePath.endsWith(".css")) contentType = "text/css; charset=utf-8";
	else if (filePath.endsWith(".js")) contentType = "application/javascript; charset=utf-8";
	else contentType = "text/plain; charset=utf-8";
	return c.text(content, 200, { "Content-Type": contentType });
});
server.route("/admin/login", loginApp);
server.use("*", (c, next) => {
	const path$1 = c.req.path;
	if (path$1 === "/admin" || path$1.startsWith("/admin/")) return next();
	return authMiddleware(c, next);
});
server.use("*", (c, next) => {
	const path$1 = c.req.path;
	if (path$1 === "/" || path$1 === "/healthz" || path$1 === "/readyz" || path$1 === "/admin" || path$1.startsWith("/admin/")) return next();
	return telemetryMiddleware(c, next);
});
server.use("*", (c, next) => {
	const path$1 = c.req.path;
	if (path$1 === "/" || path$1 === "/healthz" || path$1 === "/readyz" || path$1 === "/admin" || path$1.startsWith("/admin/")) return next();
	return traceMiddleware(c, next);
});
const sessionProtected = new Hono();
sessionProtected.use("*", sessionMiddleware);
sessionProtected.use("*", requireAdminSession);
sessionProtected.route("/session", sessionApp);
sessionProtected.route("/api", apiApp);
const legacyApp = new Hono();
legacyApp.route("/keys", keysApp);
legacyApp.route("/usage", usageApp);
legacyApp.route("/audit", auditAdminRoute);
legacyApp.route("/traces", tracesApp);
legacyApp.route("/settings", settingsApp);
legacyApp.route("/", indexApp);
sessionProtected.route("/legacy", legacyApp);
sessionProtected.get("/legacy/", (c) => c.redirect("/admin/legacy", 302));
sessionProtected.route("/traces", tracesApp);
sessionProtected.get("*", (c) => {
	try {
		const html = fs$1.readFileSync(SPA_INDEX, "utf8");
		return c.html(html);
	} catch {
		return c.text("Admin UI not built — run `bun --cwd ui run build` first.", 503);
	}
});
server.route("/admin", sessionProtected);
server.route("/chat/completions", completionRoutes);
server.route("/models", modelRoutes);
server.route("/embeddings", embeddingRoutes);
server.route("/usage", usageRoute);
server.route("/token", tokenRoute);
server.route("/v1/chat/completions", completionRoutes);
server.route("/v1/models", modelRoutes);
server.route("/v1/embeddings", embeddingRoutes);
server.route("/v1/messages", messageRoutes);
server.route("/responses", route_default);
server.route("/v1/responses", route_default);

//#endregion
//#region src/services/debug-ttl-sweeper.ts
/** Sweep and disable expired debug keys. Returns the count of keys disabled. */
function sweepExpiredDebugKeys() {
	const db = getDb();
	const now = Date.now();
	const expiredKeys = db.query(`SELECT id FROM keys
       WHERE debug_enabled = 1
         AND debug_expires_at IS NOT NULL
         AND debug_expires_at <= ?`).all(now);
	if (expiredKeys.length === 0) return 0;
	db.run(`UPDATE keys
     SET debug_enabled = 0, debug_expires_at = NULL
     WHERE debug_enabled = 1
       AND debug_expires_at IS NOT NULL
       AND debug_expires_at <= ?`, [now]);
	for (const { id } of expiredKeys) {
		audit({
			actor_key_id: "__system__",
			actor_tier: "system",
			action: "key.debug_expired",
			target: id
		});
		consola.info(`[debug-sweeper] Auto-disabled debug mode for key ${id}`);
	}
	return expiredKeys.length;
}

//#endregion
//#region src/services/retention.ts
const ONE_HOUR_MS$1 = 3600 * 1e3;
const SUSPEND_DETECTION_FACTOR = 2;
/** Compute ms from `now` until the next wall-clock hour boundary. */
function msUntilNextHour(now = Date.now()) {
	return Math.ceil((now + 1) / ONE_HOUR_MS$1) * ONE_HOUR_MS$1 - now;
}
/**
* Single sweep iteration: reads retention from the config (live, so the value
* can hot-reload without restarting the sweeper) and asks the data layer to
* purge anything older than the cutoff.
*
* `events_days = 0` is the documented "keep forever" sentinel — skipped.
*/
async function sweepEventsOnce() {
	const retentionDays = getConfig().retention.events_days;
	if (retentionDays === 0) return 0;
	const cutoff = Date.now() - retentionDays * 24 * ONE_HOUR_MS$1;
	try {
		const n = await purgeEventsOlderThan(cutoff);
		if (n > 0) consola.info(`[events-retention] purged ${n} row(s) older than cutoff`);
		return n;
	} catch (err) {
		consola.error(`[events-retention] sweep failed: ${String(err)}`);
		return 0;
	}
}
/**
* Start the hourly retention sweeper.  Returns a cancel function the caller
* (typically test setup, or a shutdown handler) can use to stop the timer.
*
* Behaviour:
* - The first tick fires at the next wall-clock hour boundary, then hourly
*   thereafter.
* - Each tick records `lastTickAt`; if the next tick fires more than
*   `SUSPEND_DETECTION_FACTOR × ONE_HOUR_MS` after the previous one, we treat
*   it as a likely suspend-resume and run a catch-up sweep immediately.
* - `setImmediate`-yields inside `purgeEventsOlderThan` keep the event loop
*   responsive while the DELETE runs.
*/
function startEventRetention() {
	let lastTickAt = Date.now();
	let intervalHandle = null;
	let firstTimeoutHandle = null;
	let stopped = false;
	const tick = () => {
		if (stopped) return;
		const now = Date.now();
		const delta = now - lastTickAt;
		lastTickAt = now;
		if (delta > SUSPEND_DETECTION_FACTOR * ONE_HOUR_MS$1) consola.warn(`[events-retention] tick delta ${delta}ms exceeds 2× expected — system likely resumed from suspend; running immediate sweep`);
		sweepEventsOnce();
	};
	const firstDelay = msUntilNextHour();
	firstTimeoutHandle = setTimeout(() => {
		firstTimeoutHandle = null;
		tick();
		if (!stopped) intervalHandle = setInterval(tick, ONE_HOUR_MS$1);
	}, firstDelay);
	return () => {
		stopped = true;
		if (firstTimeoutHandle) {
			clearTimeout(firstTimeoutHandle);
			firstTimeoutHandle = null;
		}
		if (intervalHandle) {
			clearInterval(intervalHandle);
			intervalHandle = null;
		}
	};
}

//#endregion
//#region src/services/trace-retention.ts
const ONE_HOUR_MS = 3600 * 1e3;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const TRACE_FILE_RE = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/;
function listTraceFiles() {
	const dir = tracesDir();
	let entries;
	try {
		entries = fs$1.readdirSync(dir);
	} catch {
		return [];
	}
	const out = [];
	for (const entry of entries) {
		const match = TRACE_FILE_RE.exec(entry);
		if (!match) continue;
		const fullPath = path.join(dir, entry);
		let size;
		try {
			size = fs$1.statSync(fullPath).size;
		} catch {
			continue;
		}
		const dateMs = (/* @__PURE__ */ new Date(`${match[1]}T00:00:00`)).getTime();
		if (!Number.isFinite(dateMs)) continue;
		out.push({
			name: entry,
			fullPath,
			dateMs,
			size
		});
	}
	return out;
}
/** Delete trace files older than `retention.traces_days` days. */
function purgeOldTraces() {
	const days = getConfig().retention.traces_days;
	if (days <= 0) return 0;
	const cutoffMs = Date.now() - days * ONE_DAY_MS;
	let purged = 0;
	for (const file of listTraceFiles()) if (file.dateMs < cutoffMs) try {
		fs$1.unlinkSync(file.fullPath);
		purged++;
	} catch {}
	if (purged > 0) consola.info(`[trace-retention] purged ${purged} file(s) past traces_days`);
	return purged;
}
/**
* Enforce the byte cap by deleting the oldest day(s) until under
* `retention.traces_max_bytes`. Logs a warn-level alarm if the evicted
* file is still inside the retention window — that's the "we're losing
* data faster than retention says we should" signal.
*/
function enforceSizeCap() {
	const cfg = getConfig();
	const cap = cfg.retention.traces_max_bytes;
	if (cap <= 0) return 0;
	const days = cfg.retention.traces_days;
	const retentionCutoffMs = days > 0 ? Date.now() - days * ONE_DAY_MS : Number.NEGATIVE_INFINITY;
	const files = listTraceFiles();
	files.sort((a, b) => a.dateMs - b.dateMs);
	let total = files.reduce((acc, f) => acc + f.size, 0);
	let evicted = 0;
	while (total > cap && files.length > 0) {
		const oldest = files.shift();
		if (!oldest) break;
		try {
			fs$1.unlinkSync(oldest.fullPath);
		} catch {
			continue;
		}
		total -= oldest.size;
		evicted++;
		if (oldest.dateMs >= retentionCutoffMs) consola.warn(`[trace-retention] size-cap evicted ${oldest.name} (${oldest.size}B) within retention window — increase traces_max_bytes or decrease traces_days`);
		else consola.info(`[trace-retention] size-cap evicted ${oldest.name}`);
	}
	return evicted;
}
function sweepTracesOnce() {
	try {
		const purged = purgeOldTraces();
		const evicted = enforceSizeCap();
		return {
			purged,
			evicted
		};
	} catch (err) {
		consola.error(`[trace-retention] sweep failed: ${String(err)}`);
		return {
			purged: 0,
			evicted: 0
		};
	}
}
/**
* Run a sweep immediately, then every hour. Returns a cancel function so
* the SIGINT shutdown hook can stop the timer (same pattern as
* startEventRetention).
*/
function startTraceRetention() {
	sweepTracesOnce();
	const handle = setInterval(() => {
		sweepTracesOnce();
	}, ONE_HOUR_MS);
	return () => {
		clearInterval(handle);
	};
}

//#endregion
//#region src/start.ts
/** Apply CLI options to mutable state and kick off version fetches. */
async function applyOptions(options) {
	if (options.proxyEnv) initProxyFromEnv();
	if (options.verbose) {
		consola.level = 5;
		consola.info("Verbose logging enabled");
	}
	state.accountType = options.accountType;
	if (options.accountType !== "individual") consola.info(`Using ${options.accountType} plan GitHub account`);
	state.manualApprove = options.manual;
	state.rateLimitSeconds = options.rateLimit;
	state.rateLimitWait = options.rateLimitWait;
	state.showToken = options.showToken;
	await ensurePaths();
	[state.vsCodeVersion, state.copilotChatVersion] = await Promise.all([getVSCodeVersion(), getCopilotChatVersion()]);
	consola.info(`VS Code: ${state.vsCodeVersion}  Copilot Chat: ${state.copilotChatVersion}`);
	if (options.githubToken) {
		state.githubToken = options.githubToken;
		consola.info("Using provided GitHub token");
	} else await setupGitHubToken();
	await setupCopilotToken();
	await cacheModels();
}
/** Start the session + debug-TTL background sweepers. */
function startPeriodicSweepers() {
	purgeExpiredSessions();
	setInterval(() => {
		purgeExpiredSessions();
	}, 3600 * 1e3);
	sweepExpiredDebugKeys();
	setInterval(() => {
		sweepExpiredDebugKeys();
	}, 60 * 1e3);
}
/** Install SIGINT/SIGTERM handlers that flush the DB before exit. */
function installShutdownHandlers(stopFns = []) {
	const shutdown = (code) => {
		for (const stop of stopFns) try {
			stop?.();
		} catch {}
		try {
			closeDb(getDb());
		} catch {}
		process.exit(code);
	};
	process.on("SIGINT", () => {
		shutdown(0);
	});
	process.on("SIGTERM", () => {
		shutdown(0);
	});
}
async function runServer(options) {
	await ensurePaths();
	const stopConfigWatcher = await initConfig((next) => {
		consola.info(`config.json reloaded (models=${Object.keys(next.models).length}, telemetry=${String(next.features.telemetry)}, debug=${String(next.features.debug)}, traces_days=${String(next.retention.traces_days)})`);
	});
	const authMode = resolveAuthMode({
		noAuth: options.noAuth,
		acceptRisk: options.acceptRisk,
		host: options.host,
		port: options.port,
		configAuth: getConfig().features.auth
	});
	if (options.noAuth) setRuntimeAuthOverride(false);
	state.authModeLabel = authMode.label;
	state.bindAddress = authMode.bindAddress;
	if (process.env.ADMIN_INSECURE_HTTP === "true") consola.warn("ADMIN_INSECURE_HTTP=true — admin WebUI HTTPS check disabled. Session cookies are sent in the clear. LAN-only use ONLY; never expose this port to the open internet.");
	await applyOptions(options);
	initDb();
	initAudit();
	const stopEventRetention = startEventRetention();
	const stopTraceRetention = startTraceRetention();
	installShutdownHandlers([
		stopEventRetention,
		stopTraceRetention,
		stopConfigWatcher,
		stopCopilotTokenRefresh
	]);
	logAuthModeBanner(authMode);
	runBootstrap();
	startPeriodicSweepers();
	if (!getConfig().features.auth) audit({
		actor_key_id: "__system__",
		actor_tier: "system",
		action: "server.start_no_auth",
		after: {
			bind_address: authMode.bindAddress,
			auth_mode: authMode.label
		}
	});
	consola.info(`Available models: \n${state.models?.data.map((model) => `- ${model.id}`).join("\n")}`);
	const serverUrl = `http://localhost:${options.port}`;
	if (options.claudeCode) {
		invariant(state.models, "Models should be loaded by now");
		const selectedModel = await consola.prompt("Select a model to use with Claude Code", {
			type: "select",
			options: state.models.data.map((model) => model.id)
		});
		const selectedSmallModel = await consola.prompt("Select a small model to use with Claude Code", {
			type: "select",
			options: state.models.data.map((model) => model.id)
		});
		const command = generateEnvScript({
			ANTHROPIC_BASE_URL: serverUrl,
			ANTHROPIC_AUTH_TOKEN: "dummy",
			ANTHROPIC_MODEL: selectedModel,
			ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
			ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
			DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
		}, "claude");
		try {
			clipboard.writeSync(command);
			consola.success("Copied Claude Code command to clipboard!");
		} catch {
			consola.warn("Failed to copy to clipboard. Here is the Claude Code command:");
			consola.log(command);
		}
	}
	consola.box(`🖥  Admin Web UI: ${serverUrl}/admin/`);
	const unseeded = unseededLearnedBetaFlags();
	if (unseeded.length > 0) consola.warn(`[anthropic-beta] auto-learned ${unseeded.length} unsupported beta flag(s)\n  not yet in source seed: ${unseeded.join(", ")}\n  → see ${PATHS.LEARNED_BETA_PATH}\n  → add to SEEDED_UNSUPPORTED_BETA in src/services/copilot/create-messages-native.ts`);
	serve({
		fetch: server.fetch,
		port: options.port,
		hostname: options.host,
		bun: { idleTimeout: 255 }
	});
}
const start = defineCommand({
	meta: {
		name: "start",
		description: "Start the Copilot API server"
	},
	args: {
		port: {
			alias: "p",
			type: "string",
			default: "4141",
			description: "Port to listen on"
		},
		host: {
			type: "string",
			default: "127.0.0.1",
			description: "Bind hostname. Default 127.0.0.1 (loopback only). Use 0.0.0.0 or :: to expose to LAN — requires auth or --i-accept-account-suspension-risk."
		},
		auth: {
			type: "boolean",
			default: true,
			description: "Authentication. Pass --no-auth to DISABLE. Refused on non-loopback bind unless --i-accept-account-suspension-risk is also set."
		},
		"i-accept-account-suspension-risk": {
			type: "boolean",
			default: false,
			description: "Acknowledge that running --no-auth on a non-loopback bind can burn Copilot quota and trigger GitHub abuse detection."
		},
		verbose: {
			alias: "v",
			type: "boolean",
			default: false,
			description: "Enable verbose logging"
		},
		"account-type": {
			alias: "a",
			type: "string",
			default: "individual",
			description: "Account type to use (individual, business, enterprise)"
		},
		manual: {
			type: "boolean",
			default: false,
			description: "Enable manual request approval"
		},
		"rate-limit": {
			alias: "r",
			type: "string",
			description: "Rate limit in seconds between requests"
		},
		wait: {
			alias: "w",
			type: "boolean",
			default: false,
			description: "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set"
		},
		"github-token": {
			alias: "g",
			type: "string",
			description: "Provide GitHub token directly (must be generated using the `auth` subcommand)"
		},
		"claude-code": {
			alias: "c",
			type: "boolean",
			default: false,
			description: "Generate a command to launch Claude Code with Copilot API config"
		},
		"show-token": {
			type: "boolean",
			default: false,
			description: "Show GitHub and Copilot tokens on fetch and refresh"
		},
		"proxy-env": {
			type: "boolean",
			default: false,
			description: "Initialize proxy from environment variables"
		}
	},
	run({ args }) {
		const rateLimitRaw = args["rate-limit"];
		const rateLimit = rateLimitRaw === void 0 ? void 0 : Number.parseInt(rateLimitRaw, 10);
		return runServer({
			port: Number.parseInt(args.port, 10),
			host: args.host,
			verbose: args.verbose,
			accountType: args["account-type"],
			manual: args.manual,
			rateLimit,
			rateLimitWait: args.wait,
			githubToken: args["github-token"],
			claudeCode: args["claude-code"],
			showToken: args["show-token"],
			proxyEnv: args["proxy-env"],
			noAuth: !args.auth,
			acceptRisk: args["i-accept-account-suspension-risk"]
		}).catch((err) => {
			consola.error(`\x1B[31m${String(err)}\x1B[0m`);
			process.exit(2);
		});
	}
});

//#endregion
//#region src/main.ts
const admin = defineCommand({
	meta: {
		name: "admin",
		description: "Admin management commands"
	},
	subCommands: { recover: adminRecover }
});
const main = defineCommand({
	meta: {
		name: "copilot-api-pro",
		description: "GitHub Copilot proxy with an admin WebUI, per-key debug capture, telemetry, and audit logging. Fork of ericc-ch/copilot-api."
	},
	subCommands: {
		auth,
		start,
		"check-usage": checkUsage,
		debug,
		admin
	}
});
await runMain(main);

//#endregion
export {  };