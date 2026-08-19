/**
 * dsh-title-evolve — 会话标题全流程更新器（Host 端）。
 *
 * 问题：DSH WebUI 的会话标题默认只由第一条用户消息（fallback）或官方
 * first-prompt provider 生成，之后永不更新，无法反映完整工作流。
 *
 * 本插件**完全接管**标题生成（挂载时官方机制停摆，卸载后自动恢复）：
 *   1. 监听 `session/event`（user/message）——与官方 session-title 服务
 *      相同的事件源，root 宿主级监听；
 *   2. 首条消息时同步写入占位标题「标题生成中…」，抑制官方 fallback
 *      （ensureFallback 在会话已有标题时跳过写入）；
 *   3. 通过 `llm/stream` 瀑布拦截官方 first-prompt provider 的模型调用
 *      （purpose=session-title 且 source.plugin=dsh-session-title-llm），
 *      使其生成失败、永不写入标题；
 *   4. 抽样完整用户请求（前 2 条 + 后 2 条必发、中间等距，不截断单条），
 *      复用当前会话模型路由生成 ≤12 字标题，覆盖占位标题。
 *
 * 卸载/停止后：所有监听随插件作用域自动清理，官方机制恢复工作。
 * 行为约定：尊重用户手动改名（source=user 不覆盖）；任何失败仅记日志。
 */

/** Cordis 插件名。 */
export const name = "title-evolve";

/**
 * 硬依赖声明：patch 层插件的 apply 在 host 服务注册完成前就会执行（cordis
 * 并发加载）。必须声明 inject，cordis 会等服务就绪后再调 apply；否则
 * apply 内 ctx.get('llm') 拿到 undefined，插件静默失效（vision-bridge
 * 事故 #3 同款坑：inject:[] + 同步 ctx.get → 服务全部落空）。
 */
export const inject = ["llm", "sessionTitle", "timer"];

export function apply(ctx) {
	// ── 配置常量（无设置界面，改这里即可）──
	const BUDGET_BYTES = 1536; // 抽样输入预算：512 汉字 × 3 字节（用户要求 512 字上限）
	const MAX_TITLE_BYTES = 36; // 标题上限：12 汉字（模型生成 ≤12 字，截断仅作兜底）
	const MAX_OUTPUT_TOKENS = 64;
	const TIMEOUT_MS = 30000;
	const PROVIDER_ID = "title-evolve";
	const PLACEHOLDER = "标题生成中…"; // 首轮占位标题（同步写入，抑制官方 fallback）

	// ── 工具函数 ──
	const encoder = new TextEncoder();
	const utf8Bytes = (s) => encoder.encode(s).length;

	// 清洗标题/消息文本（等效官方 normalizeSessionTitle 的 cleanTitleText）
	const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
	const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
	const ESC_SEQUENCE = /\u001B[@-_]/gu;
	const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
	const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

	function cleanTitleText(input) {
		return input
			.replace(OSC_SEQUENCE, "")
			.replace(CSI_SEQUENCE, "")
			.replace(ESC_SEQUENCE, "")
			.replace(CONTROL_CHARACTER, "")
			.replace(DIRECTIONAL_CONTROL, "")
			.replace(/\s+/gu, " ")
			.trim();
	}

	// UTF-8 字节预算内截断，不拆 Unicode 码点（仅兜底路径使用）
	function truncateUtf8(input, maxBytes) {
		if (utf8Bytes(input) <= maxBytes) return input;
		let used = 0;
		let out = "";
		for (const ch of input) {
			const b = utf8Bytes(ch);
			if (used + b > maxBytes) break;
			out += ch;
			used += b;
		}
		return out;
	}

	// 收集人类用户消息（等效官方 collectSessionTitleMessages）
	function collectMessages(session) {
		const out = [];
		for (const event of session.events) {
			if (event.type !== "user/message") continue;
			if (!event.data || !event.data.source || event.data.source.kind !== "user") continue;
			const text = (event.data.content || [])
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("\n");
			if (cleanTitleText(text).length === 0) continue;
			out.push({ seq: event.seq, text });
		}
		return out;
	}

	// 预算内按序尽量完整放下；放不下则截断该条到剩余空间（罕见兜底）
	function fitBudget(items, budget) {
		const out = [];
		let rem = budget;
		for (const m of items) {
			if (rem <= 0) break;
			const b = utf8Bytes(m.text);
			if (b <= rem) {
				out.push(m);
				rem -= b;
			} else {
				out.push({ seq: m.seq, text: truncateUtf8(m.text, rem) });
				rem = 0;
			}
		}
		return out;
	}

	// 均匀抽样：不截断单条消息，保持请求完整性。
	// 前 2 条与后 2 条必发（对话起点 + 最新进展），中间按等距挑选完整条目。
	function sampleMessages(messages) {
		const totalBytes = messages.reduce((acc, m) => acc + utf8Bytes(m.text), 0);
		if (totalBytes <= BUDGET_BYTES) return messages;
		const n = messages.length;
		const head = messages.slice(0, 2);
		const tail = n > 4 ? messages.slice(n - 2) : [];
		const middle = n > 4 ? messages.slice(2, n - 2) : [];
		const base = head.concat(tail);
		let used = base.reduce((acc, m) => acc + utf8Bytes(m.text), 0);
		if (used >= BUDGET_BYTES) return fitBudget(base, BUDGET_BYTES); // 罕见：必发集合超预算
		const picked = [];
		if (middle.length) {
			const midBytes = Math.max(1, totalBytes - used);
			const avgBytes = Math.max(1, Math.ceil(midBytes / middle.length));
			let m = Math.max(1, Math.min(middle.length, Math.floor((BUDGET_BYTES - used) / avgBytes)));
			for (let i = 0; i < m; i++) {
				const idx = Math.round((i * (middle.length - 1)) / Math.max(1, m - 1));
				const item = middle[idx];
				if (picked.length && picked[picked.length - 1].seq === item.seq) continue;
				const b = utf8Bytes(item.text);
				if (used + b > BUDGET_BYTES) continue; // 放不下则跳过
				picked.push(item);
				used += b;
			}
		}
		return head.concat(picked, tail).sort((a, b) => a.seq - b.seq);
	}

	// ── 可选依赖 ──
	const llm = ctx.get("llm");
	const timer = ctx.get("timer");
	const sessionTitle = ctx.get("sessionTitle");

	// 会话状态（WeakMap：会话销毁自动回收）
	const states = new WeakMap(); // { lastSeq, inFlight, pending }

	// ── 1. 覆盖官方 first-prompt provider：拦截其模型调用（宿主级瀑布）──
	ctx.on(
		"llm/stream",
		(options, next) => {
			if (options && options.purpose === "session-title") {
				const src = options.messages && options.messages[0] && options.messages[0].source;
				if (src && src.kind === "plugin" && src.plugin === "dsh-session-title-llm") {
					return (async function* () {
						yield {
							type: "finish",
							reason: {
								kind: "error",
								failure: { message: "title generation disabled by title-evolve", code: "TITLE_EVOLVE_OVERRIDE" }
							}
						};
					})();
				}
			}
			return next();
		},
		{ global: true, prepend: true }
	);

	// ── 2. 主事件：新用户消息到达（与官方 session-title 服务相同的事件源）──
	ctx.on("session/event", (session, event) => {
		if (!event || event.type !== "user/message") return;
		if (!event.data || !event.data.source || event.data.source.kind !== "user") return;
		if (session.header && session.header.parentSession !== undefined) return; // 跳过子会话
		handleNewMessage(session);
	});

	function handleNewMessage(session) {
		// 尊重用户手动改名（source.kind === 'user' 不覆盖）
		if (sessionTitle) {
			const cur = sessionTitle.get(session);
			if (cur && cur.source && cur.source.kind === "user") return;
		}
		const messages = collectMessages(session);
		const last = messages[messages.length - 1];
		if (!last) return;
		let state = states.get(session);
		if (!state) {
			state = { lastSeq: -1, inFlight: false, pending: false };
			states.set(session, state);
		}
		if (state.inFlight) {
			state.pending = true;
			return;
		}
		if (state.lastSeq === last.seq) return; // 同一条消息不重复生成
		// 占位标题：会话尚无标题（或仍为官方 fallback）时同步写入，抑制官方 fallback
		if (sessionTitle) {
			const cur = sessionTitle.get(session);
			if (cur === undefined || (cur.source && cur.source.kind === "fallback")) {
				try {
					session.append("session/title", {
						title: PLACEHOLDER,
						messageSeqs: [last.seq],
						source: { kind: "provider", provider: PROVIDER_ID }
					});
				} catch (err) {
					console.error("[title-evolve] placeholder append failed: " + String((err && err.message) || err));
				}
			}
		}
		state.inFlight = true;
		runGeneration(session, messages, last.seq)
			.catch((err) => console.error("[title-evolve] generation failed: " + String((err && err.message) || err)))
			.finally(() => {
				state.inFlight = false;
				state.lastSeq = last.seq;
				if (state.pending) {
					state.pending = false;
					const msgs = collectMessages(session);
					const l = msgs[msgs.length - 1];
					if (l && l.seq !== last.seq) handleNewMessage(session);
				}
			});
	}

	async function runGeneration(session, messages, baseSeq) {
		if (!llm) {
			console.error("[title-evolve] llm service unavailable; skip");
			return;
		}
		const header = session.requestHeader && session.requestHeader();
		if (!header || !header.config || !header.config.provider || !header.config.model) {
			console.error("[title-evolve] no request route; skip");
			return;
		}
		const route = { provider: header.config.provider, model: header.config.model };
		const selected = sampleMessages(messages);
		if (!selected.length) return;

		const framed = JSON.stringify(selected.map((m) => ({ seq: m.seq, text: m.text })));
		const system = [
			"为一次 AI 对话生成一个简短的会话标题。",
			"只输出标题本身，一行，不加引号、前缀、解释或 Markdown。",
			"使用对话使用的主要语言。",
			"不超过 12 个汉字（CJK）或 8 个英文单词，简洁自然、像人话，优先不用标点。",
			"标题要概括整个对话的主题与最终成果，而不仅是第一条消息。"
		].join("\n");
		const userText =
			"这是从完整对话（共 " +
			messages.length +
			" 条用户消息）中抽出的 " +
			selected.length +
			" 条消息（前 2 条与后 2 条为对话起点和最新进展，中间为等距挑选，均为完整原文，JSON 数组）：\n" +
			framed;

		let stale = false;
		let disposeTimer = null;
		if (timer) {
			disposeTimer = timer.timeout(() => { stale = true; }, TIMEOUT_MS);
		}
		try {
			let text = "";
			let finish = null;
			for await (const chunk of llm.stream({
				provider: route.provider,
				model: route.model,
				messages: [
					{
						role: "user",
						id: "title-evolve-" + String(session.id) + "-" + baseSeq,
						content: [{ type: "text", text: userText }],
						source: { kind: "plugin", plugin: "title-evolve" }
					}
				],
				system,
				maxTokens: MAX_OUTPUT_TOKENS,
				sessionId: session.id,
				purpose: "session-title"
			})) {
				if (stale) return;
				if (chunk.type === "text-delta") text += chunk.text;
				else if (chunk.type === "finish") finish = chunk.reason;
			}
			if (stale) return;
			if (finish && finish.kind !== "stop") {
				console.error("[title-evolve] stream finish: " + finish.kind);
				return;
			}
			const title = truncateUtf8(cleanTitleText(text), MAX_TITLE_BYTES);
			if (!title.length) {
				console.error("[title-evolve] empty title after normalize");
				return;
			}
			// 写入前复查：期间是否已有新用户消息
			const current = collectMessages(session);
			const currentLast = current[current.length - 1];
			if (!currentLast || currentLast.seq !== baseSeq) return;
			// 写入前再尊重一次手动改名
			if (sessionTitle) {
				const cur = sessionTitle.get(session);
				if (cur && cur.source && cur.source.kind === "user") return;
			}
			session.append("session/title", {
				title,
				messageSeqs: selected.map((m) => m.seq),
				source: { kind: "provider", provider: PROVIDER_ID, model: route }
			});
			console.log("[title-evolve] session " + session.id + " titled: " + title);
		} catch (err) {
			console.error("[title-evolve] error: " + String((err && err.message) || err));
		} finally {
			if (disposeTimer) disposeTimer();
		}
	}
}
