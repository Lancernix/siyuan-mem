/**
 * 面板前端：原生 ESM，没有构建步骤。
 *
 * 数据入口只有三个——/api/state（服务与统计）、/api/topics（目录）、
 * /api/entries（某个话题下的条目），搜索时走 /api/search。
 * 写操作（归档、重跑）等接口做好再往这里接。
 */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const TYPE_LABEL = { decision: "决策", fact: "事实", preference: "偏好", reference: "参考" };
const STATUS_LABEL = { current: "在用", superseded: "过时", archived: "归档" };
const STATUS_CLASS = { current: "ok", superseded: "warn", archived: "mute" };
const BRANDS = ["copper", "vermilion", "blue", "moss"];
const DENSITIES = ["compact", "cozy", "spacious"];

const S = {
  topics: [],
  topicsTotal: 0,
  topic: "",
  entries: [],
  selectedId: "",
  q: "",
  state: null,
  loading: false,
  /** 左栏目录在换页：用居中的 spinner，不用骨架——那一栏只有名字和数字，骨架反而看不出在干嘛 */
  leftLoading: false,
  /** 话题 → 条目。点回看过的话题先出旧数据再刷新，省掉一秒白屏。 */
  cache: new Map(),
  drawer: { open: false, tab: "queue" },
  settings: { open: false, tab: "model", data: null },
  notice: "",
  /** 当前浏览维度：话题 / 会话（时间线还没做） */
  mode: "topics",
  /** 目录排序：按条目数 / 按最近时间 */
  sort: "count",
  sessions: [],
  session: "",
};

/* ---------- 外观：色 / 明暗 / 密度 ---------- */
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function applyLook({ brand, theme, density }) {
  const root = document.documentElement;
  root.dataset.brand = brand;
  root.dataset.theme = theme;
  root.dataset.density = density;
  for (const b of document.querySelectorAll(".sw")) {
    b.setAttribute("aria-pressed", String(b.dataset.brand === brand));
  }
  for (const b of document.querySelectorAll("#density button")) {
    b.setAttribute("aria-pressed", String(b.dataset.density === density));
  }
  store("mem.brand", brand);
  store("mem.theme", theme);
  store("mem.density", density);
}

function bootLook() {
  let brand = "copper";
  let theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  let density = "cozy";
  try {
    brand = localStorage.getItem("mem.brand") || brand;
    theme = localStorage.getItem("mem.theme") || theme;
    density = localStorage.getItem("mem.density") || density;
  } catch {}
  // ?brand=blue&theme=light&density=compact：截图和排查时不用先点三下。
  const q = new URLSearchParams(location.search);
  if (BRANDS.includes(q.get("brand"))) brand = q.get("brand");
  if (["light", "dark"].includes(q.get("theme"))) theme = q.get("theme");
  if (DENSITIES.includes(q.get("density"))) density = q.get("density");
  applyLook({ brand, theme, density });
}

const look = () => ({
  brand: document.documentElement.dataset.brand,
  theme: document.documentElement.dataset.theme,
  density: document.documentElement.dataset.density,
});

/* ---------- 栏宽 ---------- */
const LIMITS = { left: [180, 380], right: [260, 560] };

function applyWidth(edge, px) {
  const [min, max] = LIMITS[edge];
  const w = Math.max(min, Math.min(max, Math.round(px)));
  document.documentElement.style.setProperty(edge === "left" ? "--col-left" : "--col-right", `${w}px`);
  store(`mem.col.${edge}`, String(w));
}

function widthOf(edge) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(edge === "left" ? "--col-left" : "--col-right");
  return Number(String(v).replace("px", "")) || (edge === "left" ? 232 : 322);
}

function bootWidth() {
  for (const edge of ["left", "right"]) {
    const v = Number(localStorage.getItem(`mem.col.${edge}`) || 0);
    if (v) applyWidth(edge, v);
  }
}

function wireHandles() {
  for (const h of document.querySelectorAll(".handle")) {
    h.addEventListener("pointerdown", (e) => {
      const edge = h.dataset.edge;
      const pane = edge === "left" ? h.previousElementSibling : h.nextElementSibling;
      if (!pane) return;
      const startX = e.clientX;
      const startW = pane.getBoundingClientRect().width;
      h.setPointerCapture(e.pointerId);
      h.classList.add("dragging");
      document.body.classList.add("resizing");

      const move = (ev) => {
        const dx = ev.clientX - startX;
        applyWidth(edge, edge === "left" ? startW + dx : startW - dx);
      };
      const up = (ev) => {
        h.classList.remove("dragging");
        document.body.classList.remove("resizing");
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
        try {
          h.releasePointerCapture(ev.pointerId);
        } catch {}
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });

    // 分栏器是控件，键盘也该能调，不然只有鼠标能用。
    h.addEventListener("keydown", (e) => {
      const edge = h.dataset.edge;
      const step = e.shiftKey ? 32 : 8;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const cur = widthOf(edge);
      const dir = e.key === "ArrowRight" ? 1 : -1;
      // 左栏向右变宽，右栏向右变窄——跟拖拽方向一致。
      applyWidth(edge, cur + dir * step * (edge === "left" ? 1 : -1));
    });
  }
}

/* ---------- 渲染 ---------- */
function sorted(rows) {
  const cp = [...(rows ?? [])];
  if (S.sort === "last") {
    return cp.sort((a, b) => String(b.last ?? "").localeCompare(String(a.last ?? "")) || (b.count ?? 0) - (a.count ?? 0));
  }
  return cp.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || String(b.last ?? "").localeCompare(String(a.last ?? "")));
}

function renderTopics() {
  const el = $("topics");
  if (S.leftLoading) {
    // 整栏居中：用 grid 撑满 pane，而不是往 li 里塞一个 spinner——
    // .list li 自带固定行高，spinner 会被顶到左上角。
    el.classList.add("is-loading");
    el.innerHTML = `<span class="spinner" role="status" aria-label="读取中"></span>`;
    return;
  }
  el.classList.remove("is-loading");
  if (S.mode === "sessions") {
    $("topic-count").textContent = S.sessions.length ? `${S.sessions.length} 场会话` : "—";
    if (!S.sessions.length) {
      el.innerHTML = `<li class="empty">还没有带条目的会话</li>`;
      return;
    }
    el.innerHTML = sorted(S.sessions)
      .map(
        (t) => `<li data-session="${esc(t.id)}" ${t.id === S.session ? 'aria-current="true"' : ""}>
          <span class="name" title="${esc(t.id)}">${esc(String(t.id).slice(0, 12))}${t.project ? ` · ${esc(t.project)}` : ""}</span>
          <span class="n num">${t.count ?? 0}</span>
          <span class="date num">${esc((t.last ?? "").slice(5))}</span>
        </li>`
      )
      .join("");
    return;
  }

  $("topic-count").textContent = S.topicsTotal ? `${S.topicsTotal} 个话题` : "—";
  if (!S.topics.length) {
    el.innerHTML = `<li class="empty">${S.q ? "没有匹配的话题" : "还没有条目"}</li>`;
    return;
  }
  el.innerHTML = sorted(S.topics)
    .map(
      (t) => `<li data-topic="${esc(t.name)}" ${t.name === S.topic ? 'aria-current="true"' : ""}>
        <span class="name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="n num">${t.count ?? 0}</span>
        <span class="date num">${esc((t.last ?? "").slice(5))}</span>
      </li>`
    )
    .join("");
}

function renderFlow() {
  const el = $("flow");
  $("flow-title").textContent = S.q
    ? `搜索「${S.q}」`
    : S.mode === "sessions"
      ? String(S.session || "").slice(0, 16)
      : S.topic || "全部条目";
  $("flow-sub").textContent = S.loading ? "" : S.entries.length ? `${S.entries.length} 条` : "";

  $("flow-loading").hidden = !S.loading;
  el.hidden = S.loading;
  if (S.loading) {
    // 骨架铺满可视高度：只给两三条的话，下面一大片空白反而像"卡住了"。
    // 多给几行：少一行就会在底下露出一块空白，看着像卡住了；溢出的部分
    // 由滚动容器裁掉，加载一结束整块就换掉，用户不会看到滚动条。
    const n = 16;
    $("skeleton").innerHTML = Array.from(
      { length: n },
      () => `<li class="entry sk-row"><span class="sk sk-title"></span><span class="sk sk-body"></span><span class="sk sk-meta"></span></li>`
    ).join("");
    return;
  }

  if (!S.entries.length) {
    el.innerHTML = `<li class="empty">${S.q ? "没有命中。换个词，或清空搜索回到话题。" : "这个话题下没有条目。"}</li>`;
    return;
  }
  el.innerHTML = S.entries
    .map((h) => {
      const status = h.status || "current";
      const type = TYPE_LABEL[h.type] || h.type || "";
      const bits = [
        `<span class="num">${esc(h.date || "")}</span>`,
        type ? `<span class="sep">·</span><span>${esc(type)}</span>` : "",
        h.project ? `<span class="sep">·</span><span>${esc(h.project)}</span>` : "",
        h.source ? `<span class="sep">·</span><span>${esc(h.source)}</span>` : "",
        h.raw ? `<a class="raw" href="#" data-raw="${esc(h.raw)}" title="${esc(h.raw)}">原文</a>` : "",
      ].filter(Boolean);
      // 只有「不是在用」的条目才挂状态：全绿一片等于没有信息。
      const statusTag =
        status === "current"
          ? ""
          : `<span class="badge ${STATUS_CLASS[status] || "mute"}">${esc(STATUS_LABEL[status] || status)}</span>`;
      return `<li class="entry" data-id="${esc(h.id)}" ${h.id === S.selectedId ? 'aria-current="true"' : ""}>
        <div class="l1">
          <span class="brief">${esc(h.brief || firstLine(h.text))}</span>
          ${statusTag}
        </div>
        <div class="body">${esc(h.text || "")}</div>
        <div class="meta">${bits.join("")}</div>
      </li>`;
    })
    .join("");
}

function firstLine(t) {
  return String(t ?? "").split("\n")[0].slice(0, 60);
}

function renderDetail() {
  const el = $("detail");
  const h = S.entries.find((x) => x.id === S.selectedId);
  if (!h) {
    el.innerHTML = `<p class="empty">选一条看详情</p>`;
    return;
  }
  const status = h.status || "current";
  el.innerHTML = `
    <h3>${esc(h.brief || firstLine(h.text))}</h3>
    <p class="full">${esc(h.text || "")}</p>
    <div class="actions">
      <a class="btn primary" href="siyuan://blocks/${esc(h.id)}">在思源打开</a>
      ${h.raw ? `<a class="btn" href="#" data-raw="${esc(h.raw)}">看原文</a>` : ""}
      <button class="btn" id="btn-archive" data-id="${esc(h.id)}">归档这条</button>
    </div>
    <dl class="field">
      <dt>话题</dt><dd>${esc(h.entity || "未归类")}</dd>
      ${h.project ? `<dt>项目</dt><dd>${esc(h.project)}</dd>` : ""}
      <dt>日期</dt><dd class="num">${esc(h.date || "")}</dd>
      <dt>类型</dt><dd>${esc(TYPE_LABEL[h.type] || h.type || "—")}</dd>
      <dt>状态</dt><dd>${esc(STATUS_LABEL[status] || status)}</dd>
      ${h.source ? `<dt>来源</dt><dd>${esc(h.source)}</dd>` : ""}
      ${h.session ? `<dt>会话</dt><dd title="${esc(h.session)}">${esc(String(h.session).slice(0, 18))}…</dd>` : ""}
      ${h.raw ? `<dt>原文</dt><dd title="${esc(h.raw)}">${esc(h.raw)}</dd>` : ""}
    </dl>`;
}

function renderState() {
  const st = S.state;
  if (!st) return;
  renderDrawer();
  const stats = st.stats ?? {};
  $("counts").innerHTML = `<b class="num">${stats.current ?? 0}</b> 在用 · <b class="num">${stats.superseded ?? 0}</b> 过时 · <b class="num">${stats.archived ?? 0}</b> 归档`;

  const busy = Boolean(st.busy?.running);
  const secs = st.busy?.seconds;
  $("status-dot").className = `dot ${busy ? "busy" : "idle"}`;
  $("status-text").textContent = busy ? "正在抽取" : "空闲";
  $("status-sub").textContent = busy
    ? secs != null
      ? `已 ${secs} 秒`
      : ""
    : (st.queue ?? []).length
      ? `队列 ${st.queue.length}`
      : "等下一轮";

  $("w-dot").className = `dot ${busy ? "busy" : "idle"}`;
  $("w-state").textContent = busy ? "正在抽取" : "等待下一轮";
  $("w-queue").textContent = String((st.queue ?? []).length);
  const use = st.usage ?? {};
  $("w-usage").textContent = String(use.calls ?? 0);
  $("w-failed").textContent = String(use.failed ?? 0);
  $("w-model").textContent = st.model?.configured ? `${st.model.provider} · ${st.model.model}` : "没配模型";
  $("w-last").textContent = st.siyuan?.version ? `思源 ${st.siyuan.version}` : "—";
}

/* ---------- worker 抽屉 ---------- */
const TABS = ["queue", "dead", "log", "model"];

function openDrawer(open) {
  S.drawer.open = open;
  $("drawer").hidden = !open;
  $("scrim").hidden = !open;
  $("drawer-label").textContent = open ? "收起" : "展开";
  if (open) renderDrawer();
}

function drawerHead(pairs) {
  return `<tr>${pairs.map(([k, label, cls]) => `<th${cls ? ` class="${cls}"` : ""}>${label}</th>`).join("")}</tr>`;
}

function renderDrawer() {
  if (!S.drawer.open) return;
  const st = S.state ?? {};
  const queue = st.queue ?? [];
  const dead = st.dead ?? { items: [], total: 0 };
  $("tab-queue").textContent = String(queue.length);
  $("tab-dead").textContent = String(dead.total ?? 0);

  for (const b of document.querySelectorAll("#drawer-tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === S.drawer.tab));
  }

  const notice = S.notice ? `<p class="empty">${esc(S.notice)}</p>` : "";
  let body = "";

  if (S.drawer.tab === "queue") {
    body = queue.length
      ? `<table><thead>${drawerHead([["f", "包"], ["h", "来源"], ["t", "轮次", "num"]])}</thead><tbody>
          ${queue
            .map(
              (q) => `<tr><td class="why">${esc(q.file)}</td><td>${esc(q.harness || "—")}</td><td class="num">${q.turns ?? 0}</td></tr>`
            )
            .join("")}
        </tbody></table>`
      : `<p class="empty">队列是空的。下一轮 ${queue.length ? "" : "serve 扫描后会把新会话放进来"}。</p>`;
  } else if (S.drawer.tab === "dead") {
    body = dead.items?.length
      ? `<table><thead>${drawerHead([["f", "包"], ["h", "来源"], ["t", "轮次", "num"], ["w", "为什么"]])}</thead><tbody>
          ${dead.items
            .map(
              (d) => `<tr><td class="why">${esc(d.file)}</td><td>${esc(d.harness || "—")}</td><td class="num">${d.turns ?? 0}</td><td class="why">${esc((d.why || "").slice(0, 80))}</td></tr>`
            )
            .join("")}
        </tbody></table>
        ${dead.total > dead.items.length ? `<p class="empty">…还有 ${dead.total - dead.items.length} 个</p>` : ""}`
      : `<p class="empty">死信是空的。</p>`;
  } else if (S.drawer.tab === "log") {
    const lines = st.log ?? [];
    body = lines.length ? `<pre class="log">${esc(lines.join("\n"))}</pre>` : `<p class="empty">今天还没有日志。</p>`;
  } else {
    const m = st.model ?? {};
    const use = st.usage ?? {};
    body = `<dl class="model-grid">
      <dt>提供方</dt><dd>${esc(m.provider || "—")}</dd>
      <dt>模型</dt><dd>${esc(m.model || "—")}</dd>
      <dt>协议</dt><dd>${esc(m.wire || "—")}</dd>
      <dt>可用</dt><dd>${m.configured ? "已配置" : "没配 key"}</dd>
      <dt>今日调用</dt><dd class="num">${use.calls ?? 0} 次，失败 ${use.failed ?? 0}</dd>
      <dt>token</dt><dd class="num">入 ${use.prompt ?? 0} / 出 ${use.completion ?? 0}${use.cached ? ` / 缓存 ${use.cached}` : ""}</dd>
    </dl>`;
  }

  $("drawer-body").innerHTML = notice + body;
}

let toastTimer = 0;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

async function postAction(url, label) {
  try {
    const r = await fetch(url, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    S.notice = d.moved != null ? `${label}：${d.moved} 个包已挪回队列` : `${label}：${d.wrote ?? d.n ?? "已提交"}`;
  } catch (e) {
    S.notice = `${label}失败：${e.message}`;
  }
  await loadState();
  renderDrawer();
}


/* ---------- 设置面板 ---------- */
function openSettings(open) {
  S.settings.open = open;
  $("settings").hidden = !open;
  $("settings-scrim").hidden = !open;
  if (open) loadSettings();
}

async function loadSettings() {
  try {
    S.settings.data = await getJSON("api/settings");
    renderSettings();
  } catch (e) {
    $("settings-body").innerHTML = `<p class="empty">读不出来：${esc(e.message)}</p>`;
  }
}

const opts = (rows, cur, key, label) =>
  rows.map((r) => `<option value="${esc(r[key])}" ${r[key] === cur ? "selected" : ""}>${esc(r[label] ?? r[key])}</option>`).join("");

function renderSettings() {
  if (!S.settings.open || !S.settings.data) return;
  const d = S.settings.data;
  for (const b of document.querySelectorAll("#settings-tabs button")) {
    b.setAttribute("aria-selected", String(b.dataset.tab === S.settings.tab));
  }
  const el = $("settings-body");

  if (S.settings.tab === "model") {
    const m = d.model;
    el.innerHTML = `
      <h3>模型</h3>
      <p class="note">key 只显示尾部，接口不会把它读出来。留空表示沿用原来的 key；换厂商时留空会清空旧 key，避免把旧凭据发到新端点。</p>
      <div class="kv">当前：<b>${esc(m.provider)} / ${esc(m.model)}</b> · ${esc(m.wire)} · key ${esc(m.key)} · ${m.configured ? "可用" : "未配置"}</div>
      <div class="kv">备用链：${m.chain.length > 1 ? esc(m.chain.slice(1).map((x) => `${x.provider}/${x.model}`).join(" → ")) : "没有配置备用"}</div>
      <label>提供方
        <select id="m-provider">${opts(d.providers, m.provider, "id", "id")}</select>
      </label>
      <label>模型名 <input id="m-name" value="${esc(m.model)}" placeholder="留空用预设模型"></label>
      <div class="row">
        <label>协议
          <select id="m-wire">${["openai", "anthropic", "gemini"].map((x) => `<option ${x === m.wire ? "selected" : ""}>${x}</option>`).join("")}</select>
        </label>
        <label>接口地址 <input id="m-base" value="${esc(m.baseUrl)}" placeholder="自定义端点才填"></label>
      </div>
      <label>API key <input id="m-key" type="password" placeholder="留空则不改"></label>
      <div class="actions">
        <button class="btn primary" data-act="model-save">保存</button>
        <button class="btn" data-act="model-test">探活（真发一次请求）</button>
      </div>`;
    return;
  }

  if (S.settings.tab === "prompt") {
    const p = d.prompt;
    el.innerHTML = `
      <h3>抽取提示词</h3>
      <p class="note">当前 ${esc(p.version)} · ${p.source === "user" ? "用户覆盖版" : "内置版"}。保存会先备份旧版，可回滚。</p>
      ${(p.warnings ?? []).map((w) => `<p class="warn">⚠ ${esc(w)}</p>`).join("")}
      <textarea id="p-text" spellcheck="false">${esc(p.text)}</textarea>
      <div class="actions"><button class="btn primary" data-act="prompt-save">保存并备份旧版</button></div>
      <h3 style="margin-top:var(--sp-6)">历史版本</h3>
      <ul class="hist">${(d.promptHistory ?? [])
        .map((h) => `<li><button data-act="prompt-restore" data-name="${esc(h.name ?? h)}">${esc(h.name ?? h)}</button></li>`)
        .join("") || "<li class=\"empty\">还没有备份</li>"}</ul>`;
    return;
  }

  const e = d.params.extract ?? {};
  const j = d.params.jobs ?? {};
  const num = (id, label, v) => `<label>${label}<input id="${id}" type="number" min="0" value="${esc(v ?? "")}"></label>`;
  el.innerHTML = `
    <h3>抽取参数</h3>
    <p class="note">改完保存，下一轮生效。这里只写数值开关；token 和 ingest 凭据不从面板暴露。</p>
    <div class="row">${num("e-min", "最短发言字数", e.minTurnChars)}${num("e-chars", "单次调用字符上限", e.maxCharsPerCall)}</div>
    <div class="row">${num("e-entries", "每批最多条目", e.maxEntriesPerBatch)}${num("e-entities", "带入实体数", e.entityShotList)}</div>
    <h3 style="margin-top:var(--sp-6)">调度参数</h3>
    <div class="row">${num("j-sessions", "每轮最多会话", j.maxSessionsPerRound)}${num("j-round", "每轮分钟上限", j.maxMinutesPerRound)}</div>
    <div class="row">${num("j-session", "单场分钟上限", j.maxMinutesPerSession)}${num("j-fail", "连续失败熔断数", j.maxConsecutiveFailures)}</div>
    ${num("j-attempt", "进死信前的失败次数", j.maxAttemptsPerSession)}
    <label style="display:flex;align-items:center;gap:var(--sp-2);margin-top:var(--sp-4)">
      <input id="r-enabled" type="checkbox" style="width:auto" ${d.params.raw?.enabled ? "checked" : ""}> 归档原文到 assets
    </label>
    <p class="note">原文目录：${esc(d.params.raw?.dir ?? "mem-raw")}</p>
    <div class="actions"><button class="btn primary" data-act="params-save">保存参数</button></div>`;
}

async function settingsPost(url, body, label) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    toast(`${label}成功`);
    await loadSettings();
    await loadState();
  } catch (e) {
    toast(`${label}失败：${e.message}`);
  }
}

/* ---------- 取数 ---------- */
async function getJSON(url) {
  // ?slow=1500：人为拖慢每次请求，用来看/调加载态。正常访问不会带这个参数。
  const slow = Number(new URLSearchParams(location.search).get("slow")) || 0;
  if (slow > 0) await new Promise((r) => setTimeout(r, slow));
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function loadTopics() {
  S.leftLoading = true;
  renderTopics();
  const d = await getJSON(`api/topics?limit=200${S.q ? `&q=${encodeURIComponent(S.q)}` : ""}`);
  S.topics = d.topics ?? [];
  S.topicsTotal = d.total ?? S.topics.length;
  S.leftLoading = false;
  renderTopics();
}

async function loadSessions() {
  S.leftLoading = true;
  renderTopics();
  const d = await getJSON("api/sessions?limit=100");
  S.sessions = d.sessions ?? [];
  S.leftLoading = false;
  renderTopics();
}

async function loadSessionEntries(sid) {
  if (!sid) {
    S.entries = [];
    S.selectedId = "";
    renderFlow();
    renderDetail();
    return;
  }
  S.loading = true;
  renderFlow();
  const d = await getJSON(`api/session?id=${encodeURIComponent(sid)}`);
  // 请求回来时可能已经切走了，丢掉过期结果。
  if (S.mode !== "sessions" || S.session !== sid) return;
  S.entries = d.hits ?? [];
  S.selectedId = S.entries[0]?.id ?? "";
  S.loading = false;
  renderFlow();
  renderDetail();
}

async function loadEntries(topic) {
  if (!topic) {
    S.entries = [];
    S.selectedId = "";
    renderFlow();
    renderDetail();
    return;
  }
  // 看过的话题先出旧数据（瞬间），再刷新——回看时不用再等一秒。
  const cached = S.cache.get(topic);
  if (cached) {
    S.entries = cached;
    S.selectedId = cached[0]?.id ?? "";
    S.loading = false;
    renderFlow();
    renderDetail();
  } else {
    S.loading = true;
    renderFlow();
  }

  const d = await getJSON(`api/entries?limit=100&topic=${encodeURIComponent(topic)}`);
  // 请求回来时用户可能已经点到别的话题了，丢掉过期的结果。
  if (S.topic !== topic) return;
  const hits = d.hits ?? [];
  S.cache.set(topic, hits);
  S.entries = hits;
  S.loading = false;
  if (!S.entries.some((x) => x.id === S.selectedId)) S.selectedId = S.entries[0]?.id ?? "";
  renderFlow();
  renderDetail();
}

async function search(q) {
  S.loading = true;
  renderFlow();
  const d = await getJSON(`api/search?q=${encodeURIComponent(q)}`);
  S.entries = d.hits ?? [];
  S.selectedId = S.entries[0]?.id ?? "";
  S.loading = false;
  renderFlow();
  renderDetail();
}

async function loadState() {
  try {
    S.state = await getJSON("api/state");
    renderState();
  } catch {
    $("status-text").textContent = "状态读取失败";
    $("status-dot").className = "dot idle";
  }
}

/* ---------- 事件 ---------- */
let qTimer = 0;
function wire() {
  $("topics").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-topic], li[data-session]");
    if (!li) return;
    S.q = "";
    $("q").value = "";
    if (li.dataset.topic) {
      S.topic = li.dataset.topic;
      renderTopics();
      loadEntries(S.topic).catch(showError);
    } else {
      S.session = li.dataset.session;
      renderTopics();
      loadSessionEntries(S.session).catch(showError);
    }
  });

  document.querySelectorAll(".nav-tabs button[data-view]").forEach((tab) => {
    tab.addEventListener("click", async () => {
      const mode = tab.dataset.view;
      if (!mode || mode === "timeline" || mode === S.mode) return;
      S.mode = mode;
      S.q = "";
      $("q").value = "";
      for (const b of document.querySelectorAll(".nav-tabs button")) {
        b.setAttribute("aria-selected", String(b === tab));
      }
      try {
        if (mode === "topics") {
          await loadTopics();
          S.topic = S.topics[0]?.name ?? "";
          renderTopics();
          await loadEntries(S.topic);
        } else {
          await loadSessions();
          S.session = S.sessions[0]?.id ?? "";
          renderTopics();
          await loadSessionEntries(S.session);
        }
      } catch (e) {
        showError(e);
      }
    });
  });

  $("detail").addEventListener("click", async (e) => {
    if (e.target.closest("a[data-raw]")) e.preventDefault();
    const b = e.target.closest("#btn-archive");
    if (!b) return;
    const id = b.dataset.id;
    b.disabled = true;
    try {
      const r = await fetch(`api/archive?ids=${encodeURIComponent(id)}&reason=${encodeURIComponent("面板归档")}`, {
        method: "POST",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      S.entries = S.entries.filter((x) => x.id !== id);
      for (const [k, v] of S.cache) S.cache.set(k, v.filter((x) => x.id !== id));
      S.selectedId = S.entries[0]?.id ?? "";
      renderFlow();
      renderDetail();
      toast(`已归档 ${id.slice(-7)}，块和原文都没删，可用 mem forget --undo 恢复`);
      await loadState();
    } catch (err) {
      toast(`归档失败：${err.message}`);
      b.disabled = false;
    }
  });

  $("flow").addEventListener("click", (e) => {
    if (e.target.closest("a[data-raw]")) {
      e.preventDefault();
      return;
    }
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    S.selectedId = li.dataset.id;
    renderFlow();
    renderDetail();
  });

  $("q").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      S.q = v;
      if (!v) {
        loadTopics().catch(showError);
        loadEntries(S.topic).catch(showError);
        return;
      }
      loadTopics().catch(() => {});
      search(v).catch(showError);
    }, 220);
  });

  $("theme").addEventListener("click", () => {
    applyLook({ ...look(), theme: look().theme === "dark" ? "light" : "dark" });
  });

  document.querySelector(".swatches").addEventListener("click", (e) => {
    const b = e.target.closest(".sw");
    if (!b) return;
    applyLook({ ...look(), brand: b.dataset.brand });
  });

  $("btn-settings").addEventListener("click", () => openSettings(!S.settings.open));
  $("settings-close").addEventListener("click", () => openSettings(false));
  $("settings-scrim").addEventListener("click", () => openSettings(false));
  $("settings-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    S.settings.tab = b.dataset.tab;
    renderSettings();
  });
  $("settings-body").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const val = (id) => $(id)?.value ?? "";
    if (b.dataset.act === "model-save") {
      settingsPost(
        "api/settings/model",
        {
          provider: val("m-provider"),
          name: val("m-name"),
          wire: val("m-wire"),
          base: val("m-base"),
          apiKey: val("m-key"),
        },
        "模型保存"
      );
    } else if (b.dataset.act === "model-test") {
      settingsPost("api/settings/model/test", {}, "探活");
    } else if (b.dataset.act === "prompt-save") {
      settingsPost("api/settings/prompt", { text: val("p-text") }, "提示词保存");
    } else if (b.dataset.act === "prompt-restore") {
      settingsPost("api/settings/prompt/restore", { name: b.dataset.name }, "回滚");
    } else if (b.dataset.act === "params-save") {
      settingsPost(
        "api/settings/params",
        {
          extract: {
            minTurnChars: val("e-min"),
            maxCharsPerCall: val("e-chars"),
            maxEntriesPerBatch: val("e-entries"),
            entityShotList: val("e-entities"),
          },
          jobs: {
            maxSessionsPerRound: val("j-sessions"),
            maxMinutesPerRound: val("j-round"),
            maxMinutesPerSession: val("j-session"),
            maxConsecutiveFailures: val("j-fail"),
            maxAttemptsPerSession: val("j-attempt"),
          },
          raw: { enabled: $("r-enabled")?.checked !== false },
        },
        "参数保存"
      );
    }
  });

  $("sort").addEventListener("change", (e) => {
    S.sort = e.target.value === "last" ? "last" : "count";
    renderTopics();
  });

  $("density").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-density]");
    if (!b) return;
    applyLook({ ...look(), density: b.dataset.density });
  // 骨架屏的条数按密度重算，不然切换后下面会留一截空白。
  if (S.loading) renderFlow();
  });

  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("q").focus();
    }
  });

  $("btn-drawer").addEventListener("click", () => openDrawer(!S.drawer.open));
  $("drawer-close").addEventListener("click", () => openDrawer(false));
  $("scrim").addEventListener("click", () => openDrawer(false));
  $("drawer-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    S.drawer.tab = b.dataset.tab;
    S.notice = "";
    renderDrawer();
  });
  $("btn-run").addEventListener("click", () => postAction("api/run", "跑一轮"));
  $("btn-retry").addEventListener("click", () => postAction("api/retry?all=1", "重跑死信"));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (S.settings.open) openSettings(false);
      else if (S.drawer.open) openDrawer(false);
    }
  });

  wireHandles();
}

function showError(e) {
  S.loading = false;
  $("flow-loading").hidden = true;
  $("flow").hidden = false;
  $("flow").innerHTML = `<li class="empty">读不出来：${esc(e.message)}</li>`;
}

/* ---------- 启动 ---------- */
bootLook();
S.leftLoading = true;
S.loading = true;
renderTopics();
renderFlow();
// ?drawer=queue|dead|log|model：直接打开抽屉的那一页，截图和贴链接时用。
{
  const q = new URLSearchParams(location.search);
  // ?topic=xxx / ?session=xxx：直接选中某个话题或会话。
  if (q.get("topic")) S.topic = q.get("topic");
  if (q.get("session")) S.session = q.get("session");
  if (q.get("view") === "sessions") {
    S.mode = "sessions";
    for (const b of document.querySelectorAll(".nav-tabs button")) {
      b.setAttribute("aria-selected", String(b.dataset.view === "sessions"));
    }
  }
  if (["model", "prompt", "params"].includes(q.get("settings"))) {
    S.settings.open = true;
    S.settings.tab = q.get("settings");
  }
  if (TABS.includes(q.get("drawer"))) {
    S.drawer.open = true;
    S.drawer.tab = q.get("drawer");
  }
}
bootWidth();
wire();
openDrawer(S.drawer.open);
openSettings(S.settings.open);
loadState();
loadTopics()
  .then(async () => {
    if (S.mode === "sessions") {
      await loadSessions();
      if (!S.session) S.session = S.sessions[0]?.id ?? "";
      renderTopics();
      return loadSessionEntries(S.session);
    }
    if (!S.topic) S.topic = S.topics[0]?.name ?? "";
    if (S.topic) {
      renderTopics();
      return loadEntries(S.topic);
    }
    S.loading = false;
    renderFlow();
  })
  .catch(showError);

// 服务和统计每 10 秒刷一次；话题目录不跟着刷——它变得很慢，刷了反而跳。
setInterval(loadState, 10000);
