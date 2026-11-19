/**
 * 面板前端：原生 ESM，没有构建步骤。
 *
 * 数据只有三个入口——/api/state（服务与统计）、/api/topics（目录）、
 * /api/entries（某个话题下的条目），搜索时走 /api/search。写操作现在没有，
 * 归档和重跑等接口做好再往这里接。
 */

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const TYPE_LABEL = { decision: "决策", fact: "事实", preference: "偏好", reference: "参考" };
const STATUS_LABEL = { current: "在用", superseded: "过时", archived: "归档" };
const STATUS_CLASS = { current: "ok", superseded: "warn", archived: "mute" };

const S = {
  topics: [],
  topicsTotal: 0,
  topic: "",
  entries: [],
  selectedId: "",
  q: "",
  state: null,
  hint: "",
};

/* ---------- 主题 ---------- */
function applyLook(brand, theme) {
  const root = document.documentElement;
  root.dataset.brand = brand;
  root.dataset.theme = theme;
  for (const b of document.querySelectorAll(".sw")) {
    b.setAttribute("aria-pressed", String(b.dataset.brand === brand));
  }
  try {
    localStorage.setItem("mem.brand", brand);
    localStorage.setItem("mem.theme", theme);
  } catch {}
}

const BRANDS = ["copper", "vermilion", "blue", "moss"];

function bootLook() {
  let brand = "copper";
  let theme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  try {
    brand = localStorage.getItem("mem.brand") || brand;
    theme = localStorage.getItem("mem.theme") || theme;
  } catch {}
  // 链接里带 ?brand=blue&theme=light 时以链接为准：分享截图、排查某个主题时，
  // 不用先点两下再截。
  const q = new URLSearchParams(location.search);
  if (BRANDS.includes(q.get("brand"))) brand = q.get("brand");
  if (["light", "dark"].includes(q.get("theme"))) theme = q.get("theme");
  applyLook(brand, theme);
}

/* ---------- 渲染 ---------- */
function renderTopics() {
  const el = $("topics");
  $("topic-count").textContent = S.topicsTotal ? `${S.topicsTotal} 个话题` : "—";
  if (!S.topics.length) {
    el.innerHTML = `<li class="empty">${S.q ? "没有匹配的话题" : "还没有条目"}</li>`;
    return;
  }
  el.innerHTML = S.topics
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
  $("flow-title").textContent = S.q ? `搜索「${S.q}」` : S.topic || "全部条目";
  const n = S.entries.length;
  $("flow-sub").textContent = n ? `${n} 条` : "";
  if (!n) {
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
  const stats = st.stats ?? {};
  $("counts").innerHTML = `<b class="num">${stats.current ?? 0}</b> 在用 · <b class="num">${stats.superseded ?? 0}</b> 过时 · <b class="num">${stats.archived ?? 0}</b> 归档`;

  const busy = Boolean(st.busy);
  $("status").innerHTML = `<i class="dot ${busy ? "busy" : "idle"}"></i><span>${busy ? "正在跑一轮" : "空闲"}</span>`;
  $("w-dot").className = `dot ${busy ? "busy" : "idle"}`;
  $("w-state").textContent = busy ? "正在抽取" : "等待下一轮";
  $("w-queue").textContent = String((st.queue ?? []).length);
  const use = st.usage ?? {};
  $("w-usage").textContent = String(use.calls ?? 0);
  $("w-failed").textContent = String(use.failed ?? 0);
  $("w-model").textContent = st.model?.configured
    ? `${st.model.provider} · ${st.model.model}`
    : "没配模型";
  const svc = st.service;
  $("w-last").textContent = svc?.heartbeat
    ? `上次心跳 ${new Date(svc.heartbeat).toLocaleTimeString("zh-CN", { hour12: false })}`
    : st.siyuan?.version
      ? `思源 ${st.siyuan.version}`
      : "—";
}

/* ---------- 取数 ---------- */
async function getJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function loadTopics() {
  const d = await getJSON(`api/topics?limit=200${S.q ? `&q=${encodeURIComponent(S.q)}` : ""}`);
  S.topics = d.topics ?? [];
  S.topicsTotal = d.total ?? S.topics.length;
  renderTopics();
}

async function loadEntries(topic) {
  if (!topic) {
    S.entries = [];
    S.selectedId = "";
    renderFlow();
    renderDetail();
    return;
  }
  const d = await getJSON(`api/entries?limit=100&topic=${encodeURIComponent(topic)}`);
  S.entries = d.hits ?? [];
  S.selectedId = S.entries[0]?.id ?? "";
  S.hint = d.hint ?? "";
  renderFlow();
  renderDetail();
}

async function search(q) {
  const d = await getJSON(`api/search?q=${encodeURIComponent(q)}`);
  S.entries = d.hits ?? [];
  S.selectedId = S.entries[0]?.id ?? "";
  renderFlow();
  renderDetail();
}

async function loadState() {
  try {
    S.state = await getJSON("api/state");
    renderState();
  } catch (e) {
    $("status").innerHTML = `<i class="dot busy"></i><span>状态读取失败</span>`;
  }
}

/* ---------- 事件 ---------- */
let qTimer = 0;
function wire() {
  $("topics").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-topic]");
    if (!li) return;
    S.topic = li.dataset.topic;
    S.q = "";
    $("q").value = "";
    renderTopics();
    loadEntries(S.topic).catch(showError);
  });

  $("flow").addEventListener("click", (e) => {
    const raw = e.target.closest("a[data-raw]");
    if (raw) {
      e.preventDefault();
      e.stopPropagation();
    }
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    S.selectedId = li.dataset.id;
    renderFlow();
    renderDetail();
  });

  $("detail").addEventListener("click", (e) => {
    if (e.target.closest("a[data-raw]")) e.preventDefault();
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
    applyLook(
      document.documentElement.dataset.brand,
      document.documentElement.dataset.theme === "dark" ? "light" : "dark"
    );
  });

  document.querySelector(".swatches").addEventListener("click", (e) => {
    const b = e.target.closest(".sw");
    if (!b) return;
    applyLook(b.dataset.brand, document.documentElement.dataset.theme);
  });

  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("q").focus();
    }
  });
}

function showError(e) {
  $("flow").innerHTML = `<li class="empty">读不出来：${esc(e.message)}</li>`;
}

/* ---------- 启动 ---------- */
bootLook();
wire();
loadState();
loadTopics()
  .then(() => {
    const first = S.topics[0]?.name ?? "";
    if (first) {
      S.topic = first;
      renderTopics();
      return loadEntries(first);
    }
  })
  .catch(showError);

// 服务和统计每 10 秒刷一次，话题目录不跟着刷——它变得很慢，刷了反而跳。
setInterval(loadState, 10000);
