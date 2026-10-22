const USER = "repsales@faktu.example";
const state = {
  history: [],
  busy: false,
};

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const formEl = $("#composer");

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtAmount(n) {
  return (
    new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(n) + " €"
  );
}

function addMsg(role, html) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const avatar = role === "agent" ? "F" : "👤";
  div.innerHTML = `<div class="avatar">${avatar}</div><div class="bubble">${html}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function toolLine(t) {
  const args = t.args ? JSON.stringify(t.args) : "";
  const result = t.result !== undefined ? JSON.stringify(t.result) : "";
  const cls = t.kind === "error" ? "tool error" : "tool";
  return (
    `<div class="${cls}">` +
    `<div class="tool-head">${esc(t.name || "")} ${esc(args || "")}</div>` +
    `<div class="tool-res">${esc(result || "")}</div>` +
    `</div>`
  );
}

function renderAgent(html, trace) {
  let actions = "";
  const tools = (trace || []).filter((t) => t.kind === "tool" || t.kind === "error");
  if (tools.length) {
    actions =
      `<details class="actions"><summary>${tools.length} action(s) exécutée(s)</summary>` +
      tools.map(toolLine).join("") +
      `</details>`;
  }
  addMsg("agent", actions + `<div class="text">${esc(html)}</div>`);
}

async function send(message) {
  if (state.busy || !message.trim()) return;
  state.busy = true;
  addMsg("user", esc(message));
  state.history.push({ role: "user", content: message });

  const pending = addMsg("agent", `<span class="typing">…</span>`);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: USER,
        message,
        history: state.history.slice(0, -1),
      }),
    });
    const data = await res.json();
    pending.remove();
    renderAgent(data.reply || "", data.trace || []);
    state.history.push({ role: "assistant", content: data.reply || "" });
    refreshSidebar();
  } catch (e) {
    pending.remove();
    addMsg("agent", `<span class="err">Erreur : ${esc(e.message)}</span>`);
  } finally {
    state.busy = false;
    inputEl.focus();
  }
}

async function refreshSidebar() {
  try {
    const [deals, contacts] = await Promise.all([
      fetch("/api/deals").then((r) => r.json()),
      fetch("/api/contacts").then((r) => r.json()),
    ]);
    const open = deals.filter((d) => !["gagne", "perdu"].includes(d.stage));
    const openTotal = open.reduce((s, d) => s + d.value_eur, 0);
    const total = deals.reduce((s, d) => s + d.value_eur, 0);
    $("#pipeline").innerHTML =
      `<div class="pip-row"><span>Deals ouverts</span><strong>${open.length}</strong></div>` +
      `<div class="pip-row"><span>Montant ouvert</span><strong>${fmtAmount(openTotal)}</strong></div>` +
      `<div class="pip-row"><span>Pipeline total</span><strong>${fmtAmount(total)}</strong></div>`;
    $("#contact-count").textContent = `${contacts.length} contacts dans le CRM`;
  } catch {
    /* ignore */
  }
}

async function init() {
  try {
    const h = await fetch("/api/health").then((r) => r.json());
    $("#model-badge").textContent =
      h.model === "mock" ? "mock (déterministe)" : `LLM · ${h.model}`;
  } catch {
    $("#model-badge").textContent = "hors ligne";
  }
  refreshSidebar();
}

formEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const msg = inputEl.value;
  inputEl.value = "";
  inputEl.style.height = "auto";
  send(msg);
});

inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    formEl.requestSubmit();
  }
});

document.querySelectorAll("#suggestions button").forEach((b) => {
  b.addEventListener("click", () => send(b.dataset.msg));
});

init();
