import { localFetch as fetch } from './bridge.js';

"use strict";
const TOKEN = "__TOKEN__";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const PRESETS = {
  gentle: { down: 80, l0: 0.0006, name: "轻柔", hint: "去噪最轻，留住最多细节和淡阴影。" },
  recommended: { down: 60, l0: 0.001, name: "推荐", hint: "去噪和细节平衡，适合大多数二次元图。" },
  strong: { down: 45, l0: 0.0018, name: "强力", hint: "纹理去得最干净，淡渐变和细节也损失最多。" },
};
const store = (k, v) => { try { localStorage.setItem("ad." + k, JSON.stringify(v)); } catch {} };
const recall = (k, d) => { try { const v = JSON.parse(localStorage.getItem("ad." + k)); return v ?? d; } catch { return d; } };
const fmtL0 = v => (+v).toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
const same = (a, b) => a && b && a.down === b.down && Math.abs(a.l0 - b.l0) < 1e-9;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// brush settings start from these on every launch (user choice); changes last for the session
const BRUSH_DEFAULTS = { brush: 14, mix: 90, feather: 10 };
const S = {
  items: [], cur: null, queue: [], running: null, info: {},
  view: "cmp", base: "orig", split: 0.5, vp: null, lastFit: null,
  brushMode: false, tool: "brush", eyeMode: recall("eyeMode", "auto"), flash: false, painting: false, overlayWhich: "all", overlayFor: null,
  peekOrig: false, peekMask: false, flashAll: false, space: false, spaceMode: "", sizeAt: null,
  brush: BRUSH_DEFAULTS.brush, params: recall("params", { down: 60, l0: 0.001 }),
  mix: BRUSH_DEFAULTS.mix, feather: BRUSH_DEFAULTS.feather, toldBrush: recall("toldBrush", false),
  // which layer the eraser works on: "mask" after the protect brush / lasso, "paint" after the colour brush (like PS)
  layer: "mask", pickHeld: false,
  P: { color: recall("pColor", "#2a2a2e"), size: 6, hard: 80, opac: 100, pixel: false },  // the colour brush
};
let nextId = 1;
const stage = $("#stage"), imgB = $("#imgB"), cvA = $("#cvA"), cvM = $("#cvM"), cvP = $("#cvP");
const mk = () => document.createElement("canvas");
const featherC = mk(), tmpC = mk(), dilC = mk(), greyC = mk();
const strokeC = mk(), strokeFeatherC = mk();  // the stroke being painted now, for its own tint
const g2 = (c, read) => c.getContext("2d", read ? { willReadFrequently: true } : undefined);
function fit2(c, w, h) { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { "X-Token": TOKEN, ...(opts.headers || {}) } });
  if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error || m; } catch {} throw new Error(m); }
  return r;
}
const shortDev = d => (d || "").replace(/^NVIDIA\s+/, "").replace(/^GeForce\s+/, "");
fetch("/api/info").then(r => r.json()).then(j => {
  S.info = j;
  $("#devName").textContent = "本机处理 · " + (j.device === "CPU" ? "CPU" : shortDev(j.device));
  $("#devChip").hidden = false;
  if (j.gpu_note) {  // a GPU is there but this torch build can't run on it: say so instead of a raw CUDA error
    $("#devChip").title = j.gpu_note;
    toast(j.gpu_note, "err", 12000);
  }
  syncPanel();
}).catch(() => {});

/* ---------------- toasts & dialogs ---------------- */
function toast(msg, kind = "", ms = 4200) {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = "<span></span><button aria-label='关闭'>×</button>";
  t.firstChild.textContent = msg;
  t.lastChild.onclick = () => t.remove();
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), ms);
}
$("#helpBtn").onclick = () => $("#helpDlg").showModal();
$("#helpClose").onclick = () => $("#helpDlg").close();
$("#quitBtn").onclick = () => $("#quitDlg").showModal();
$("#quitNo").onclick = () => $("#quitDlg").close();
$("#quitYes").onclick = async () => {
  $("#quitDlg").close();
  try { await api("/api/quit", { method: "POST" }); } catch {}
  const d = document.createElement("div"); d.className = "ended"; d.textContent = "去噪工具已结束，可以关闭这个页面了。"; document.body.appendChild(d);
};
for (const d of $$("dialog")) d.addEventListener("click", e => { if (e.target === d) d.close(); });

/* ---------------- theme ---------------- */
const THEMES = [["system", "跟随系统", "#i-auto"], ["light", "浅色", "#i-sun"], ["dark", "深色", "#i-moon"]];
let theme = recall("theme", "system");
function applyTheme() {
  const t = THEMES.find(x => x[0] === theme) || THEMES[0];
  if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  $("#themeLabel").textContent = t[1];
  $("#themeIcon").setAttribute("href", t[2]);
  if (S.cur) drawOverlay(S.cur);
}
$("#themeBtn").onclick = () => { theme = THEMES[(THEMES.findIndex(x => x[0] === theme) + 1) % 3][0]; store("theme", theme); applyTheme(); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => S.cur && drawOverlay(S.cur));
applyTheme();

/* ---------------- adding images ---------------- */
const pick = () => $("#fileInput").click();
$("#fileInput").onchange = e => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ""; };
$("#emptyPick").onclick = $("#stripAdd").onclick = pick;
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropOverlay").hidden = false; });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true; if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (files.length) { e.preventDefault(); addFiles(files, true); }
});

function loadImg(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("读不出这张图")); im.src = url; });
}
function makeThumb(img) {
  const c = mk(), k = 128 / Math.max(img.naturalWidth, img.naturalHeight);
  c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
// a pasted image has no name of its own; the paste time keeps a later session's auto-save from overwriting this one
function pasteStamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
async function addFiles(list, pasted) {
  const files = [...list].filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|jfif|webp|bmp|gif|tiff?|avif|tga)$/i.test(f.name));
  if (!files.length) return toast("没有可用的图片（PNG / JPEG / WebP / BMP / GIF / TIFF / AVIF）", "err");
  const stamp = pasteStamp();
  let first = null;
  for (const f of files) {
    // the server decodes every format (EXIF rotation, 16-bit, CMYK, TIFF...) and returns a PNG:
    // the page shows, blends and sends exactly these pixels, so the "original" always matches what was processed
    let blob, url, img, hasAlpha = false;
    try {
      const r = await api("/api/convert", { method: "POST", body: f });
      blob = await r.blob(); hasAlpha = r.headers.get("X-Alpha") === "1";
      url = URL.createObjectURL(blob); img = await loadImg(url);
    } catch (e) { if (url) URL.revokeObjectURL(url); toast(`${f.name || "图片"}：${e.message}`, "err", 6000); continue; }
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w*h > 1e7) toast(`${f.name}：约 ${Math.round(w*h/1e4)} 万像素，大图处理较慢，建议使用原始尺寸图片`, "", 8000);
    const id = nextId++;
    const name = pasted || !f.name || f.name === "image.png" ? `粘贴的图片-${stamp}-${id}.png` : f.name;
    const mask = mk(); mask.width = w; mask.height = h;
    { const mc = mask.getContext("2d", { willReadFrequently: true }); mc.fillStyle = "#000"; mc.fillRect(0, 0, w, h); }
    const it = { id, file: blob, hasAlpha, name, stem: name.replace(/\.[^.]+$/, ""), w, h, srcURL: url, srcImg: img, thumb: makeThumb(img),
      params: { ...S.params }, feather: S.feather, result: null, status: "queued", err: "",
      mask, hasMask: false, undo: [], redo: [], saved: "", saveTimer: 0 };
    S.items.push(it);
    first = first || it;
    enqueue(it);
  }
  renderStrip();
  if (first) select(first);
}
function removeItem(it) {
  if (S.running === it) { it.again = false; it.removed = true; cancelRun(it); }
  S.queue = S.queue.filter(x => x !== it);
  const i = S.items.indexOf(it);
  S.items.splice(i, 1);
  URL.revokeObjectURL(it.srcURL);
  if (it.result) URL.revokeObjectURL(it.result.url);
  if (S.cur === it) { const n = S.items[Math.min(i, S.items.length - 1)]; n ? select(n) : clearSelection(); }
  renderStrip();
}
function clearSelection() { S.cur = null; S.vp = null; setBrushMode(false); syncPanel(); render(); }

/* ---------------- queue & denoise ---------------- */
function enqueue(it, force) {
  if (S.running === it) {
    // the running job was started with other parameters: stop it now and start over with the new ones
    if (force || !same(it.params, it.runParams)) { it.again = true; cancelRun(it); }
    return;
  }
  if (!force && it.result && same(it.params, it.result.params)) return;
  if (!S.queue.includes(it)) S.queue.push(it);
  it.status = it.result ? it.status : "queued";
  renderStrip(); syncPanel(); pump();
}
function cancelRun(it) {
  if (!it.ctrl) return;
  it.ctrl.abort();
  api(`/api/cancel?job=${it.job}`, { method: "POST" }).catch(() => {});
}
async function pump() {
  if (S.running || S.segmentBusy) return;
  const it = S.queue.shift();
  if (!it) return;
  S.running = it;
  await runItem(it);
  S.running = null; syncPanel();
  if (it.again && !it.removed) { it.again = false; S.queue.unshift(it); it.status = it.result ? it.status : "queued"; }
  pump();
}
let progTimer = 0;
function startProgress(it, t0) {
  clearInterval(progTimer);
  progTimer = setInterval(async () => {
    const s = (performance.now() - t0) / 1000;
    it.elapsedLive = s;
    if (S.cur === it) {
      $("#prog").hidden = s < 0.3;
      $("#progTime").textContent = s.toFixed(1) + " 秒";
      if (s > 0.3) { try { const p = await (await fetch("/api/progress")).json(); if (p.stage) $("#progText").textContent = p.stage; } catch {} }
      syncStatus();
    } else $("#prog").hidden = true;
  }, 150);
}
function stopProgress() { clearInterval(progTimer); $("#prog").hidden = true; $("#progText").textContent = "去噪中"; }
async function runItem(it) {
  const p = { ...it.params };
  it.runParams = p;
  it.job = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random())).replace(/-/g, "");
  it.ctrl = new AbortController();
  it.status = "running"; it.err = "";
  renderStrip(); syncPanel(); render();
  const t0 = performance.now();
  startProgress(it, t0);
  try {
    const r = await api(`/api/denoise?down=${p.down / 100}&l0=${p.l0}&job=${it.job}`, { method: "POST", body: it.file, signal: it.ctrl.signal });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const img = await loadImg(url);
    if (it.removed) { URL.revokeObjectURL(url); return; }
    if (it.result) URL.revokeObjectURL(it.result.url);
    it.result = { img, url, blob, params: p, timings: JSON.parse(r.headers.get('X-Timings') || '{}'), elapsed: +r.headers.get("X-Elapsed"), cached: r.headers.get("X-SR-Cached") === "1", device: r.headers.get("X-Device") };
    it.hasAlpha = r.headers.get("X-Alpha") === "1";
    it.status = "done";
    if (S.cur === it) composite();
    scheduleSave(it, 0);
    if (!S.toldBrush) { S.toldBrush = true; store("toldBrush", true); toast("去噪完成。若有细节被抹掉，可以用「保护笔刷」把它涂回来。", "", 6500); }
  } catch (e) {
    if (e.name === "AbortError" || it.ctrl.signal.aborted) {
      it.status = it.result ? "done" : "queued";  // stopped on purpose: no error, the re-run follows
    } else {
      it.status = it.result ? "done" : "error"; it.err = e.message;
      toast(`${it.name}：${e.message}`, "err", 7000);
    }
  } finally {
    it.ctrl = null; it.runParams = null;
    stopProgress();
    renderStrip(); syncPanel(); render();
  }
}

/* ---------------- compositing ---------------- */
function maskRGB() { return getComputedStyle(document.documentElement).getPropertyValue("--mask").trim() || "185, 71, 47"; }
function featherOf(src, w, h, f, out) {
  // src is opaque grey: brightness = restore strength (black = untouched); out gets alpha = feathered weight
  fit2(out, w, h); fit2(greyC, w, h);
  const gc = g2(greyC);
  gc.globalCompositeOperation = "source-over"; gc.fillStyle = "#000"; gc.fillRect(0, 0, w, h);
  if (f > 0) {
    // grow each stroke by r = f/2 keeping the brighter value where copies overlap (a grey "dilate"), then blur by r/2:
    // weight stays ~98% of the stroke's strength at its edge for any width and fades to 0 about f px outside
    const r = f / 2;
    fit2(dilC, w, h);
    const dc = g2(dilC);
    dc.globalCompositeOperation = "source-over"; dc.drawImage(src, 0, 0);
    dc.globalCompositeOperation = "lighten";
    for (const [k, n] of [[1 / 3, 8], [2 / 3, 12], [1, 16]])
      for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n + k; dc.drawImage(src, Math.cos(a) * r * k, Math.sin(a) * r * k); }
    dc.globalCompositeOperation = "source-over";
    gc.filter = `blur(${r / 2}px)`; gc.drawImage(dilC, 0, 0); gc.filter = "none";
    gc.globalCompositeOperation = "lighten";
  }
  gc.drawImage(src, 0, 0);  // painted pixels: exactly their own strength
  gc.globalCompositeOperation = "source-over";
  const oc = g2(out);
  oc.clearRect(0, 0, w, h);
  oc.filter = "url(#g2a)"; oc.drawImage(greyC, 0, 0); oc.filter = "none";  // alpha = weight
}
function buildFeather(it) { featherOf(it.mask, it.w, it.h, it.feather, featherC); }
// final pixels = denoised * (1 - m) + original * m, m = feathered mask weight (each stroke carries its own strength)
function blendInto(it, out) {
  fit2(out, it.w, it.h);
  const oc = g2(out, it.hasAlpha);
  oc.clearRect(0, 0, it.w, it.h);
  if (!it.result) { oc.drawImage(it.srcImg, 0, 0); return; }
  const k = it.hasMask ? 1 : 0;
  if (k > 0 && it.hasAlpha) {  // exact per-pixel blend so semi-transparent pixels keep the original alpha
    fit2(tmpC, it.w, it.h);
    const tc = g2(tmpC, true);
    tc.clearRect(0, 0, it.w, it.h); tc.drawImage(it.srcImg, 0, 0);
    const so = tc.getImageData(0, 0, it.w, it.h).data;
    tc.clearRect(0, 0, it.w, it.h); tc.drawImage(it.result.img, 0, 0);
    const od = tc.getImageData(0, 0, it.w, it.h);
    const d = od.data, m = g2(featherC, true).getImageData(0, 0, it.w, it.h).data;
    for (let i = 0; i < d.length; i += 4) {
      const a = m[i + 3] / 255 * k;
      if (a) { d[i] += (so[i] - d[i]) * a; d[i + 1] += (so[i + 1] - d[i + 1]) * a; d[i + 2] += (so[i + 2] - d[i + 2]) * a; }
      d[i + 3] = so[i + 3];
    }
    oc.putImageData(od, 0, 0);
    return;
  }
  oc.drawImage(it.result.img, 0, 0);
  if (k > 0) {
    fit2(tmpC, it.w, it.h);
    const tc = g2(tmpC);
    tc.globalCompositeOperation = "source-over"; tc.clearRect(0, 0, it.w, it.h);
    tc.drawImage(it.srcImg, 0, 0);
    tc.globalCompositeOperation = "destination-in"; tc.drawImage(featherC, 0, 0);
    tc.globalCompositeOperation = "source-over";
    oc.globalAlpha = k; oc.drawImage(tmpC, 0, 0); oc.globalAlpha = 1;
  }
}
// overlay = the feathered weight as a soft tint (no outline): its depth shows each stroke's strength
function drawOverlay(it, which = S.overlayWhich || "all") {
  fit2(cvM, it.w, it.h);
  const mc = g2(cvM);
  mc.globalCompositeOperation = "source-over"; mc.clearRect(0, 0, it.w, it.h);
  S.overlayWhich = which; S.overlayFor = it;
  let src = featherC;
  if (which === "stroke") {
    if (strokeC.width !== it.w || strokeC.height !== it.h) return;
    featherOf(strokeC, it.w, it.h, it.feather, strokeFeatherC);
    src = strokeFeatherC;
  } else if (!it.hasMask) return;
  mc.filter = "url(#sqrtA)"; mc.drawImage(src, 0, 0); mc.filter = "none";  // display only: sqrt keeps weak strokes readable
  mc.globalCompositeOperation = "source-in";
  mc.fillStyle = `rgba(${maskRGB()}, 0.6)`; mc.fillRect(0, 0, it.w, it.h);  // deeper tint = stronger restore
  mc.globalCompositeOperation = "source-over";
}
function composite() {
  const it = S.cur;
  if (!it) return;
  buildFeather(it);
  blendInto(it, cvA);
  // keep whatever the tint layer is showing (e.g. the last stroke while it fades out); only render() switches it,
  // otherwise a re-composite (auto-save, slider) would swap in the whole mask mid-fade and flash it
  drawOverlay(it, S.overlayFor === it ? S.overlayWhich : "all");
  render();
}
let rafPending = false;
function scheduleComposite() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; composite(); }); } }

/* ---------------- saving & downloading ---------------- */
function outName(it) {
  const p = it.result.params;
  let tag = same(p, PRESETS.recommended) ? "" : `_s${p.down}_l0-${fmtL0(p.l0)}`;
  if (it.hasMask) tag += "_protected";
  if (it.hasPaint) tag += "_touchup";
  return `${it.stem}_denoise${tag}.png`;
}
function finalBlob(it) {
  if (!it.hasMask && !it.hasPaint) return Promise.resolve(it.result.blob);
  let c;
  if (it !== S.cur) { buildFeather(it); c = mk(); blendInto(it, c); if (S.cur) buildFeather(S.cur); }
  else { composite(); c = mk(); fit2(c, it.w, it.h); g2(c).drawImage(cvA, 0, 0); }
  if (it.hasPaint) g2(c).drawImage(it.paint, 0, 0);  // the colour layer sits on top of everything
  return new Promise(res => c.toBlob(res, "image/png"));
}
function scheduleSave(it, delay = 700) { return;
  if (!it.result) return;
  clearTimeout(it.saveTimer);
  if (it === S.cur) $("#bSaved").textContent = "保存中…";
  it.saveTimer = setTimeout(() => saveItem(it), delay);
}
async function saveItem(it) {
  if (!it.result) return;
  try {
    const name = outName(it);
    const blob = await finalBlob(it);
    const j = await (await api(`/api/save?name=${encodeURIComponent(name)}`, { method: "POST", body: blob })).json();
    it.saved = j.file;
  } catch (e) { it.saved = ""; toast("自动保存失败：" + e.message, "err"); }
  if (it === S.cur) { $("#bSaved").textContent = it.saved ? "已保存" : ""; syncPanel(); }
}
async function download() {
  const it = S.cur;
  if (!it || !it.result) return;
  const blob = await finalBlob(it);
  const a = document.createElement("a"), u = URL.createObjectURL(blob);
  a.href = u; a.download = outName(it); a.click();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}
$("#dlBtn").onclick = download;
const reveal = name => api("/api/reveal" + (name ? `?name=${encodeURIComponent(name)}` : ""), { method: "POST" }).catch(e => toast(e.message, "err"));
$("#openOut").onclick = () => reveal("");
$("#revealBtn").onclick = () => reveal(S.cur?.saved || "");

/* ---------------- panel ---------------- */
function presetOf(p) { return Object.keys(PRESETS).find(k => same(PRESETS[k], p)); }
function paintRange(el) { el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min) * 100) + "%"); }
function syncParams() {
  const p = S.cur ? S.cur.params : S.params, key = presetOf(p);
  for (const b of $$("[data-preset]")) b.setAttribute("aria-checked", b.dataset.preset === key);
  $("#paramPill").textContent = "自定义";
  $("#paramPill").className = "pill accent";
  $("#paramPill").hidden = !!key;
  $("#presetHint").textContent = key ? PRESETS[key].hint : "自定义参数：用下面的滑条微调，松手就重新去噪。";
  $("#down").value = p.down; $("#l0").value = p.l0;
  $("#downOut").textContent = p.down + "%"; $("#l0Out").textContent = fmtL0(p.l0);
  paintRange($("#down")); paintRange($("#l0"));
}
function setParams(p, run = true) {
  p = { down: p.down, l0: +(+p.l0).toFixed(4) };
  S.params = p; store("params", p);
  if (S.cur) { S.cur.params = { ...p }; if (run) enqueue(S.cur); }
  syncParams();
}
$$("[data-preset]").forEach(b => b.onclick = () => setParams(PRESETS[b.dataset.preset]));
for (const id of ["down", "l0"]) {
  $("#" + id).addEventListener("input", e => {
    const v = +e.target.value;
    if (id === "down") $("#downOut").textContent = v + "%"; else $("#l0Out").textContent = fmtL0(v);
    paintRange(e.target);
  });
  $("#" + id).addEventListener("change", () => setParams({ down: +$("#down").value, l0: +$("#l0").value }));
}
$("#resetParams").onclick = () => setParams(PRESETS.recommended);

function syncStatus() {
  const it = S.cur, el = $("#fStatus");
  if (!it) { el.hidden = true; return; }
  el.hidden = false;
  let cls = "", txt = "";
  if (it.status === "running") { cls = "run"; txt = `去噪中 · ${(it.elapsedLive || 0).toFixed(1)} 秒`; }
  else if (it.status === "queued") { txt = `排队中（前面还有 ${Math.max(0, S.queue.indexOf(it)) + (S.running ? 1 : 0)} 张）`; }
  else if (it.status === "error") { cls = "err"; txt = "出错：" + it.err; }
  else if (it.result) {
    cls = "ok";
    const r = it.result;
    txt = `已完成 · ${r.elapsed.toFixed(1)} 秒${r.cached ? " · 复用超分结果" : ""}`; if (r.timings?.l0 != null) txt += ` · 超分 ${r.timings.sr.toFixed(1)}s / 平滑 ${r.timings.l0.toFixed(1)}s`;
    if (!same(it.params, r.params)) { cls = "run"; txt = "参数已改，等待重新去噪…"; }
  }
  el.className = "status " + cls;
  $("#fStatusText").textContent = txt;
}
function syncPanel() {
  const it = S.cur;
  $("#fThumb").hidden = !it; $("#fThumbBlank").hidden = !!it;
  if (it) { $("#fThumb").src = it.thumb; $("#fName").textContent = it.name; $("#fName").title = it.name; }
  else { $("#fName").textContent = "还没有图片"; }
  $("#fDims").textContent = it ? `${it.w} × ${it.h}${it.hasAlpha ? " · 透明背景" : ""}` : "拖进窗口，或按 Ctrl+O 选择";
  syncStatus();
  syncParams();
  const ready = !!(it && it.result);
  $("#dlBtn").disabled = !ready;
  $("#revealBtn").disabled = !(it && it.saved);
  $("#brushBtn").disabled = !it;
  // three separate tools in the side panel: only the one in use lights up
  const inLasso = S.brushMode && S.tool === "lasso", inPaint = S.brushMode && S.layer === "paint";
  const inBrush = S.brushMode && !inLasso && !inPaint;
  $("#paintBtn").disabled = !it;
  $("#paintBtn").classList.toggle("on", inPaint);
  $("#paintBtnText").textContent = inPaint ? "完成上色" : "上色笔";
  const painted = !!(it && it.hasPaint);
  $("#paintPill").textContent = painted ? "使用中" : "未使用";
  $("#paintPill").className = "pill" + (painted ? " accent" : "");
  $("#paintSum").hidden = !painted;
  $("#brushBtn").classList.toggle("on", inBrush);
  $("#brushBtnText").textContent = inBrush ? "完成涂抹" : "保护笔刷";
  $("#brushKbd").textContent = "B";
  const masked = !!(it && it.hasMask);
  $("#protectPill").textContent = masked ? "使用中" : "未使用";
  $("#protectPill").className = "pill" + (masked ? " accent" : "");
  $("#protectSum").hidden = !masked;
  if (masked) $("#protectSumText").textContent = `已涂保护区 · 新笔画 ${S.mix}% · 柔边 ${it.feather} px`;
  const fn = $("#footNote");
  fn.textContent = "";
  if (it && it.saved) {
    fn.append("已自动保存：");
    const b = document.createElement("span"); b.className = "flink"; b.tabIndex = 0; b.setAttribute("role", "button");
    b.textContent = it.saved; b.title = "在文件夹中显示"; b.onclick = () => reveal(it.saved);
    b.onkeydown = e => { if (e.key === "Enter") reveal(it.saved); };
    fn.append(b);
  } else fn.textContent = "结果仅在当前页面，请下载保存";
  $("#bUndo").disabled = !(it && it.undo.length);
  $("#bRedo").disabled = !(it && it.redo.length);
  $("#bClear").disabled = S.layer === "paint" ? !painted : !masked;
  $("#lassoBtn").disabled = !it;
  $("#lassoBtn").classList.toggle("on", inLasso);
  $("#lassoBtnText").textContent = inLasso ? "完成套索" : "磁性套索";
  $("#invertBtn").disabled = $("#bInvert").disabled = !masked;
  $("#autoSelBtn").disabled = $("#bAuto").disabled = !$("#enableSeg").checked || !it || S.segmentBusy || !!S.running;
  $("#autoSelText").textContent = it?.segBusy ? "正在识别人物…" : "自动选中人物";
  $("#bSaved").textContent = it && it.saved && S.brushMode ? "已保存" : $("#bSaved").textContent;
}

/* ---------------- strip ---------------- */
function renderStrip() {
  const box = $("#stripItems");
  box.textContent = "";
  for (const it of S.items) {
    const d = document.createElement("div");
    d.className = "sitem" + (it === S.cur ? " cur" : "");
    d.title = it.name;
    const img = document.createElement("img"); img.src = it.thumb; img.alt = it.name; d.appendChild(img);
    const b = document.createElement("span"); b.className = "sbadge";
    if (it.status === "running") { b.classList.add("run"); b.innerHTML = '<span class="spin"></span>'; }
    else if (it.status === "queued") { b.classList.add("wait"); b.textContent = S.queue.indexOf(it) + 1; b.title = "排队中"; }
    else if (it.status === "error") { b.classList.add("err"); b.textContent = "!"; b.title = it.err; }
    else if (it.result) { b.classList.add("ok"); b.textContent = "✓"; }
    if (b.className !== "sbadge") d.appendChild(b);
    if (it.hasMask) { const m = document.createElement("span"); m.className = "sbadge mask"; m.title = "已涂保护区"; m.innerHTML = '<svg class="i" style="width:11px;height:11px"><use href="#i-shield"/></svg>'; d.appendChild(m); }
    const x = document.createElement("button"); x.className = "sdel"; x.textContent = "×"; x.title = "移除";
    x.onclick = e => { e.stopPropagation(); removeItem(it); };
    d.appendChild(x);
    d.onclick = () => select(it);
    box.appendChild(d);
  }
  const done = S.items.filter(i => i.result).length;
  $("#stripNote").textContent = S.items.length > 1 ? `${done} / ${S.items.length} 张完成` : "";
}
function select(it) {
  if (S.cur === it) return;
  if (S.brushMode && S.cur) { endStroke(); endPaint(); }
  lassoFinish();  // keep an open outline on the image being left, like a brush stroke
  S.cur = it;
  imgB.src = it.srcURL;
  for (const c of [cvA, cvM, cvP]) fit2(c, it.w, it.h);
  syncBrushUI();
  composite();
  drawPaint();
  fit();
  syncPanel(); renderStrip();
}
function step(d) {
  if (!S.cur || S.items.length < 2) return;
  const i = (S.items.indexOf(S.cur) + d + S.items.length) % S.items.length;
  select(S.items[i]);
}

/* ---------------- view ---------------- */
function fit() {
  const it = S.cur;
  if (!it) return render();
  const W = stage.clientWidth, H = stage.clientHeight, pad = 28;
  const s = Math.min((W - pad * 2) / it.w, (H - pad * 2) / it.h);
  S.vp = { s, x: (W - it.w * s) / 2, y: (H - it.h * s) / 2 };
  S.lastFit = { ...S.vp };
  render();
}
function zoomAt(f, cx, cy, abs) {
  if (!S.vp) return;
  cx ??= stage.clientWidth / 2; cy ??= stage.clientHeight / 2;
  const s = Math.min(16, Math.max(0.05, abs ? f : S.vp.s * f));
  S.vp.x = cx - (cx - S.vp.x) * s / S.vp.s; S.vp.y = cy - (cy - S.vp.y) * s / S.vp.s; S.vp.s = s;
  render(); updateCursor();
}
function render() {
  const it = S.cur, has = !!(it && S.vp);
  stage.classList.toggle("has", has);
  stage.classList.toggle("paint", has && S.brushMode && !S.space && S.tool !== "lasso" && !picking());
  stage.classList.toggle("picking", has && !S.space && picking());
  stage.classList.toggle("lasso", has && S.brushMode && !S.space && S.tool === "lasso");
  // Space held: hand to pan; once the wheel is used it becomes "resize" and only the brush circle shows
  stage.classList.toggle("space", has && S.space && S.spaceMode !== "size");
  stage.classList.toggle("sizing", has && S.spaceMode === "size");
  stage.classList.toggle("brushing", has && S.brushMode);
  $("#empty").hidden = !!it;
  for (const id of ["#frame", "#tagL", "#tagR", "#div"]) $(id).hidden = !has;
  for (const id of ["#Lb", "#La", "#Lm"]) $(id).style.display = has ? "" : "none";
  $("#zPct").textContent = has ? Math.round(S.vp.s * 100) + "%" : "—";
  const hasOut = !!(it && it.result);
  for (const b of $$("#viewSeg button")) { b.classList.toggle("on", b.dataset.v === S.view); b.disabled = !hasOut && b.dataset.v !== "before"; }
  if (!has) { $("#baseSeg").hidden = true; $("#viewHint").textContent = ""; lassoDraw(); return; }
  const { s, x, y } = S.vp, W = stage.clientWidth;
  const tf = `translate(${x}px, ${y}px) scale(${s})`;
  for (const el of [imgB, cvA, cvP, cvM]) { el.style.width = it.w + "px"; el.style.height = it.h + "px"; el.style.transform = tf; el.classList.toggle("px", s >= 2); }
  Object.assign($("#frame").style, { left: x + "px", top: y + "px", width: it.w * s + "px", height: it.h * s + "px" });
  const m = S.peekOrig ? "before" : (hasOut ? S.view : "before");
  const leftDen = m === "cmp" && S.base === "den" && it.hasMask;
  const want = leftDen ? it.result.url : it.srcURL;
  if (imgB.getAttribute("src") !== want) imgB.src = want;
  $("#Lb").style.display = m === "after" ? "none" : "";
  $("#La").style.display = m === "before" ? "none" : "";
  $("#La").style.clipPath = m === "cmp" ? `inset(0 0 0 ${S.split * W}px)` : "none";
  $("#div").hidden = m !== "cmp";
  $("#div").style.left = S.split * 100 + "%";
  $("#knob").setAttribute("aria-valuenow", Math.round(S.split * 100));
  $("#tagL").hidden = m === "after"; $("#tagR").hidden = m === "before";
  const waiting = it.status === "running" ? " · 去噪中" : it.status === "queued" ? " · 排队中" : "";
  const flipHint = hasOut && m !== "cmp" && !S.peekOrig ? " · X 切换" : "";
  $("#tagL").textContent = leftDen ? "未保护结果" : "原图" + (hasOut ? flipHint : waiting);
  $("#tagR").textContent = (it.hasMask ? "结果 · 含保护" : "结果") + flipHint;
  const showAll = S.peekMask || S.flashAll || (S.brushMode && S.eyeMode === "always") || (S.painting && strokeTool === "erase");
  const showStroke = !showAll && (S.painting || S.flash) && strokeTool === "brush";
  const tintWant = showAll ? "all" : showStroke ? "stroke" : null;
  if (tintWant && (S.overlayWhich !== tintWant || S.overlayFor !== it)) drawOverlay(it, tintWant);
  const showMask = !S.peekOrig && ((showAll && it.hasMask) || showStroke);
  $("#Lm").classList.toggle("show", showMask);
  $("#baseSeg").hidden = !(hasOut && it.hasMask && m === "cmp");
  for (const b of $$("#baseSeg button")) b.classList.toggle("on", b.dataset.b === S.base);
  $("#viewHint").textContent = !hasOut ? "还没去噪完，先显示原图" : m === "cmp" ? `左：${leftDen ? "未保护结果" : "原图"}　右：${it.hasMask ? "结果（含保护）" : "结果"}` : m === "before" ? "原图" : "结果 · 就是下载的那张";
  lassoDraw();
}
$$("#viewSeg button").forEach(b => b.onclick = () => { S.view = b.dataset.v; render(); });
$$("#baseSeg button").forEach(b => b.onclick = () => { S.base = b.dataset.b; render(); });
$("#zFit").onclick = fit; $("#z11").onclick = () => zoomAt(1, null, null, true);
$("#zIn").onclick = () => zoomAt(1.25); $("#zOut").onclick = () => zoomAt(0.8);
let sizeTipTimer = 0;
const curSize = () => S.layer === "paint" ? S.P.size : S.brush;  // each brush keeps its own size, like PS
function setBrushSize(v, showTip) {
  if (S.layer === "paint") S.P.size = Math.round(Math.min(200, Math.max(1, v)));
  else S.brush = Math.round(Math.min(300, Math.max(2, v)));
  syncBrushUI(); updateCursor();
  showTipAt(`${curSize()} px`, showTip);
}
function showTipAt(text, show) {
  const at = S.spaceMode === "size" ? S.sizeAt : cursorPt;
  if (show && at && S.vp) {
    const tip = $("#sizeTip");
    tip.textContent = text;
    tip.style.left = at[0] + "px"; tip.style.top = (at[1] - Math.max(10, curSize() * S.vp.s / 2) - 10) + "px";
    tip.hidden = false;
    clearTimeout(sizeTipTimer);
    if (S.spaceMode !== "size") sizeTipTimer = setTimeout(() => { tip.hidden = true; }, 700);  // [ ] keys
  }
}
stage.addEventListener("wheel", e => {
  if (onUI(e)) return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  if (S.space && S.brushMode) {  // hold Space + wheel: fine brush size control (~6% per notch, at least 1 px)
    const up = e.deltaY < 0, d = Math.max(1, Math.round(curSize() * 0.06));
    if (S.spaceMode !== "size") { S.spaceMode = "size"; S.sizeAt = cursorPt || [r.width / 2, r.height / 2]; render(); }
    setBrushSize(curSize() + (up ? d : -d), true);
    return;
  }
  zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
stage.addEventListener("dblclick", e => {
  if (onUI(e)) return;
  if (L.on) lassoClose(e.altKey);
  else if (!S.brushMode) fit();
});
new ResizeObserver(() => {
  if (!S.vp) return render();
  const f = S.lastFit, v = S.vp;
  f && Math.abs(v.s - f.s) < 1e-9 && Math.abs(v.x - f.x) < .5 && Math.abs(v.y - f.y) < .5 ? fit() : render();
}).observe(stage);
$("#knob").addEventListener("keydown", e => {
  const d = { ArrowLeft: -0.02, ArrowRight: 0.02, Home: -1, End: 1 }[e.key];
  if (d === undefined) return;
  e.preventDefault(); e.stopPropagation();
  S.split = Math.min(1, Math.max(0, Math.abs(d) === 1 ? (d < 0 ? 0 : 1) : S.split + d)); render();
});

/* ---------------- brush ---------------- */
function syncBrushUI() {
  const it = S.cur;
  $("#bSize").value = S.brush; $("#bSizeOut").textContent = S.brush;
  $("#bMix").value = S.mix; $("#bMixOut").textContent = S.mix + "%";
  $("#bFeather").value = it ? it.feather : S.feather; $("#bFeatherOut").textContent = (it ? it.feather : S.feather);
  for (const id of ["#bSize", "#bMix", "#bFeather"]) paintRange($(id));
  for (const b of $$("#brushbar [data-t]")) b.classList.toggle("on", b.dataset.t === S.tool);
  const always = S.eyeMode === "always";
  $("#bEye").classList.toggle("on", always);
  $("#bEyeIcon").setAttribute("href", always ? "#i-eye" : "#i-eye-auto");
  $("#bEye").title = always ? "一直显示涂抹范围（点击改成涂完自动隐藏）；按住 M 看全部涂抹" : "涂完自动隐藏范围（点击改成一直显示）；按住 M 看全部涂抹";
  $("#brushCur").classList.toggle("erase", S.tool === "erase");
  const lasso = S.tool === "lasso", paint = S.layer === "paint", P = S.P;
  // the lasso fills an outline, so brush size does not apply: grey it out but keep its place, so the tool buttons don't move
  $("#bSizeField").classList.toggle("off", lasso); $("#bSize").disabled = lasso;
  $("#fbProtect").hidden = paint; $("#fbPaint").hidden = !paint;
  $("#bInvert").hidden = $("#bEye").hidden = $("#bAuto").hidden = paint;  // these two are about the protected area only
  $("#pColor").value = P.color; $("#pSwatch").style.background = P.color;
  $("#pSize").value = P.size; $("#pSizeOut").textContent = P.size;
  $("#pHard").value = P.hard; $("#pHardOut").textContent = P.hard + "%";
  $("#pOpac").value = P.opac; $("#pOpacOut").textContent = P.opac + "%";
  for (const id of ["#pSize", "#pHard", "#pOpac"]) paintRange($(id));
  $("#pPixel").classList.toggle("on", P.pixel);
  $("#pHardField").classList.toggle("off", P.pixel); $("#pHard").disabled = P.pixel;  // a pixel pen is always hard
  $("#eraseBtn").title = paint ? "橡皮（E，或右键拖动）：擦掉上的颜色" : "橡皮（E，或右键拖动）：擦掉保护区";
  $("#bClear").title = paint ? "清除全部颜色（可撤销）" : "清除全部保护区（可撤销）";
  $("#bDone").title = lasso ? "完成套索（L）：没闭合的选框会自动闭合并填好；Esc 放弃选框"
    : paint ? "完成上色（P 或 Esc）" : "完成涂抹（B 或 Esc）";
  $("#brushTip").textContent = lasso
    ? "沿轮廓移动自动吸附 · 单击加锚点 · 回起点单击 / 双击 / 回车闭合 · Alt 或右键闭合 = 减去 · ⌫ 删锚点 · L / 完成 = 闭合并退出 · Esc 放弃"
    : paint && S.tool === "erase"
      ? "擦掉上的颜色 · [ ] 大小 · Shift+[ ] 软硬 · 数字键 力度 · Shift+单击画直线 · P 回到上色笔"
      : paint
        ? "拖动上色 · 按住 Alt / Ctrl 单击取色 · Shift+单击画直线 · [ ] 大小 · Shift+[ ] 软硬 · 数字键 不透明度 · 右键拖动擦色"
        : "涂到的地方混回原图 · 右键拖动擦除 · Shift+单击画直线 · 按住空格：拖动画面 / 滚轮调笔刷大小 · 按住 M 看全部涂抹";
  $("#lassoBtn").classList.toggle("on", S.brushMode && lasso);
}
// B / L select the protect layer, P the colour layer; E (the eraser) keeps whichever layer was in use
function chooseTool(tool) {
  if (tool === "paint") S.layer = "paint";
  else if (tool === "brush" || tool === "lasso") S.layer = "mask";
  S.tool = tool;
}
function setBrushMode(on, tool) {
  if (on && !S.cur) return;
  if (!on || (tool && tool !== S.tool)) endPaint();
  S.brushMode = on;
  if (tool) chooseTool(tool);
  if (!on || S.tool !== "lasso") lassoFinish();
  if (!on) S.pickHeld = false;
  $("#brushbar").hidden = !on; $("#brushTip").hidden = !on;
  if (on) { $("#bSaved").textContent = S.cur?.saved ? "已保存" : ""; }
  syncBrushUI(); syncPanel(); render(); updateCursor();
}
$("#brushBtn").onclick = () => S.brushMode && S.layer === "mask" && S.tool !== "lasso" ? setBrushMode(false)
  : setBrushMode(true, S.layer === "mask" && S.tool === "erase" ? "erase" : "brush");
$("#paintBtn").onclick = () => S.brushMode && S.layer === "paint" ? setBrushMode(false) : setBrushMode(true, "paint");
$("#bDone").onclick = () => setBrushMode(false);
$$("#brushbar [data-t]").forEach(b => b.onclick = () => setBrushMode(true, b.dataset.t));
$("#lassoBtn").onclick = () => S.brushMode && S.tool === "lasso" ? setBrushMode(false) : setBrushMode(true, "lasso");
$("#invertBtn").onclick = $("#bInvert").onclick = () => invertMask();
$("#bEye").onclick = () => {
  S.eyeMode = S.eyeMode === "always" ? "auto" : "always"; store("eyeMode", S.eyeMode);
  toast(S.eyeMode === "always" ? "涂抹范围：一直显示" : "涂抹范围：涂完自动隐藏（按住 M 看全部）", "", 2200);
  syncBrushUI(); render();
};
$("#bSize").addEventListener("input", e => { S.brush = +e.target.value; syncBrushUI(); updateCursor(); });
$("#bMix").addEventListener("input", e => { S.mix = +e.target.value; syncBrushUI(); syncPanel(); updateCursor(); });  // only affects new strokes
$("#bFeather").addEventListener("input", e => { const it = S.cur; S.feather = +e.target.value; if (it) { it.feather = S.feather; scheduleComposite(); scheduleSave(it); } syncBrushUI(); syncPanel(); });
// one undo history for both layers; each step stores only the layer it changed
function snapshot(it, layer = "mask") {
  return layer === "paint" ? { layer, data: g2(paintLayer(it), true).getImageData(0, 0, it.w, it.h), has: !!it.hasPaint }
    : { layer, data: g2(it.mask, true).getImageData(0, 0, it.w, it.h), has: it.hasMask };
}
function pushUndo(it, layer = "mask") { it.undo.push(snapshot(it, layer)); while (it.undo.length > 1 && it.undo.reduce((n,x)=>n+x.data.data.byteLength,0)>64*1024*1024) it.undo.shift(); it.redo = []; }
function restore(it, from, to) {
  const u = from.pop();
  if (!u) return;
  to.push(snapshot(it, u.layer));
  if (u.layer === "paint") { g2(paintLayer(it), true).putImageData(u.data, 0, 0); it.hasPaint = u.has; drawPaint(); }
  else { g2(it.mask, true).putImageData(u.data, 0, 0); it.hasMask = u.has; composite(); }
  scheduleSave(it); syncPanel(); renderStrip();
}
const undo = () => S.cur && restore(S.cur, S.cur.undo, S.cur.redo);
const redo = () => S.cur && restore(S.cur, S.cur.redo, S.cur.undo);
$("#bUndo").onclick = undo; $("#bRedo").onclick = redo;
function clearMask() {
  const it = S.cur;
  if (!it || !it.hasMask) return;
  pushUndo(it); { const c = g2(it.mask, true); c.fillStyle = "#000"; c.fillRect(0, 0, it.w, it.h); } it.hasMask = false;
  composite(); scheduleSave(it); syncPanel(); renderStrip();
  toast("已清除保护区（Ctrl+Z 可撤销）");
}
$("#bClear").onclick = () => S.layer === "paint" ? clearPaint() : clearMask();
$("#clearMask").onclick = clearMask;
$("#clearPaint").onclick = () => clearPaint();
function hasPixels(it) {
  const d = g2(it.mask, true).getImageData(0, 0, it.w, it.h).data;
  for (let i = 0; i < d.length; i += 4) if (d[i]) return true;  // any non-black grey
  return false;
}
let lastPt = null, strokeTool = "brush";
function strokeTo(pt) {
  const it = S.cur, c = g2(it.mask, true);
  const v = strokeTool === "erase" ? 0 : Math.round(S.mix * 2.55);
  c.globalCompositeOperation = "source-over";
  c.strokeStyle = c.fillStyle = `rgb(${v},${v},${v})`;  // sets this stroke's strength; overlapping strokes replace, not stack
  c.lineWidth = S.brush; c.lineCap = c.lineJoin = "round";
  const sc = g2(strokeC);  // same segment into the current-stroke canvas (only used for its tint)
  sc.strokeStyle = sc.fillStyle = c.fillStyle; sc.lineWidth = S.brush; sc.lineCap = sc.lineJoin = "round";
  for (const g of [c, sc]) {
    if (!lastPt) { g.beginPath(); g.arc(pt[0], pt[1], S.brush / 2, 0, Math.PI * 2); g.fill(); }
    else { g.beginPath(); g.moveTo(lastPt[0], lastPt[1]); g.lineTo(pt[0], pt[1]); g.stroke(); }
  }
  c.globalCompositeOperation = "source-over";
  lastPt = pt;
  if (strokeTool === "brush") it.hasMask = true;
  scheduleComposite();
}
function endStroke() {
  if (!S.painting) return;
  const it = S.cur;
  it.lastMaskPt = lastPt;  // for Shift+click: a straight line from here
  S.painting = false; lastPt = null;
  it.hasMask = hasPixels(it);
  if (S.eyeMode === "auto" && strokeTool === "brush") {  // keep this stroke's tint a moment after lifting, then fade
    S.flash = true; clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { S.flash = false; render(); }, 700);
  }
  composite(); scheduleSave(it); syncPanel(); renderStrip();
}
let flashTimer = 0, flashAllTimer = 0;
function flashAll(ms) {  // briefly show the whole protected area (after an invert or a lasso subtraction)
  if (S.eyeMode === "always") return render();
  S.flashAll = true; clearTimeout(flashAllTimer); render();
  flashAllTimer = setTimeout(() => { S.flashAll = false; render(); }, ms);
}

/* ---------------- invert ---------------- */
// Swaps protected and denoised areas, keeping the strength the user chose: grey v -> max - v.
// Lasso the character -> only the background is denoised; invert -> only the character is.
function invertMask() {
  const it = S.cur;
  if (!it) return;
  lassoFinish();  // an outline still open is what the user means to invert
  if (!it.hasMask) return toast("还没有保护区：先用磁性套索圈住人物（或用笔刷涂），再反选", "", 3800);
  const c = g2(it.mask, true), im = c.getImageData(0, 0, it.w, it.h), d = im.data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > max) max = d[i];
  pushUndo(it);
  for (let i = 0; i < d.length; i += 4) { const v = max - d[i]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  c.putImageData(im, 0, 0);
  it.hasMask = hasPixels(it);
  composite(); scheduleSave(it); syncPanel(); renderStrip();
  flashAll(1200);
  toast(it.hasMask ? "已反选：原来去噪的地方改为保持原图，原来保持原图的地方改为去噪（Ctrl+Z 可撤销）" : "反选后没有保护区了（整张都已保护时反选 = 整张去噪）", "", 4200);
}

/* ---------------- auto-select the character ---------------- */
// SkyTNT anime-segmentation in a browser GPU worker returns a grey map (white = character). It is added to the protected area
// at the current "恢复原图" strength, keeping what was already painted (lighten), so it combines with brush and lasso.
async function autoSelect() {
  if (!$("#enableSeg").checked) return toast("请先勾选启用 AI 人物选择；此功能需额外下载约 176 MB 模型", "", 6000);
  const it = S.cur;
  if (!it || S.segmentBusy || S.running) return;
  lassoFinish();
  it.segBusy = true; S.segmentBusy = true; syncPanel();
  if (!(S.info && S.info.seg_ready)) toast("第一次使用要下载人物识别模型（约 176 MB，只下载一次），请稍等", "", 6000);
  try {
    const r = await api("/api/segment", { method: "POST", body: it.file });
    const share = +r.headers.get("X-Share") || 0;
    const bmp = await createImageBitmap(await r.blob());
    if (S.info) S.info.seg_ready = true;
    if (!S.items.includes(it)) { bmp.close(); return; }
    if (share < 0.005) { bmp.close(); return toast("没有认出人物：自动选中只认二次元风格的人物，写实照片或纯风景请用磁性套索", "err", 6000); }
    const t = mk(); fit2(t, it.w, it.h);
    const tc = g2(t, true); tc.drawImage(bmp, 0, 0, it.w, it.h); bmp.close();
    const p = tc.getImageData(0, 0, it.w, it.h).data;
    const c = g2(it.mask, true), im = c.getImageData(0, 0, it.w, it.h), d = im.data, s = S.mix / 100;
    pushUndo(it);
    for (let i = 0; i < d.length; i += 4) {
      const v = p[i] < 38 ? 0 : Math.round(p[i] * s);  // below ~15 % is background noise of the model
      if (v > d[i]) d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    c.putImageData(im, 0, 0);
    it.hasMask = hasPixels(it);
    composite(); scheduleSave(it); renderStrip();
    flashAll(1500);
    toast(`已自动选中人物（约占画面 ${Math.round(share * 100)}%），人物保持原图、只给背景去噪。想反过来只给人物去噪：按 I 反选。边缘不准可以用笔刷或橡皮补（Ctrl+Z 可撤销）`, "", 7000);
  } catch (err) {
    toast("自动选中失败：" + err.message, "err", 8000);
  } finally {
    it.segBusy = false; S.segmentBusy = false; syncPanel(); pump();
  }
}
$("#enableSeg").onchange = () => syncPanel();
$("#autoSelBtn").onclick = $("#bAuto").onclick = () => autoSelect();

/* ---------------- magnetic lasso ---------------- */
// Live-wire ("intelligent scissors"): the outline from the last anchor to the cursor is the cheapest route over an
// edge-cost map, so it hugs the strongest nearby contour. Anchors drop automatically as the cursor travels.
// Closing fills the outline into the protect mask at the current "恢复原图" strength (Alt / right click: subtract).
const L = { on: false, it: null, pts: [], anchors: [], live: [], want: null, near: false, raf: 0 };
function blur3(a, w, h) {
  const t = new Uint16Array(a.length), o = new Uint8Array(a.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) { const i = r + x; t[i] = a[i] + a[x > 0 ? i - 1 : i] + a[x < w - 1 ? i + 1 : i]; }
  }
  for (let y = 0; y < h; y++) {
    const u = y > 0 ? -w : 0, dn = y < h - 1 ? w : 0, r = y * w;
    for (let x = 0; x < w; x++) { const i = r + x; o[i] = (t[i] + t[i + u] + t[i + dn]) / 9; }
  }
  return o;
}
function edgeMap(it) {
  // the denoised result has clean outlines; the original still has the texture noise this tool removes
  const src = it.result ? it.result.img : it.srcImg;
  if (it.edge && it.edge.src === src) return it.edge.e;
  const w = it.w, h = it.h, n = w * h;
  const c = mk(); c.width = w; c.height = h;
  const cc = c.getContext("2d", { willReadFrequently: true });
  cc.drawImage(src, 0, 0);
  const d = cc.getImageData(0, 0, w, h).data;
  const lum = new Uint8Array(n), alp = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3];
    alp[i] = a;
    lum[i] = ((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8) * a / 255;
  }
  const bl = blur3(lum, w, h), e = new Uint8Array(n);
  const sob = (p, i) => {
    const t = i - w, b = i + w;
    const gx = p[t + 1] + 2 * p[i + 1] + p[b + 1] - p[t - 1] - 2 * p[i - 1] - p[b - 1];
    const gy = p[b - 1] + 2 * p[b] + p[b + 1] - p[t - 1] - 2 * p[t] - p[t + 1];
    return Math.abs(gx) + Math.abs(gy);
  };
  for (let y = 1; y < h - 1; y++)
    for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) e[i] = Math.min(255, Math.max(sob(bl, i), sob(alp, i)) / 4);  // transparent edges count too
  // the picture's own border is a boundary too: an outline swept outside the image runs along it (a figure that
  // fills the whole height is cut off by the top and bottom of the picture)
  for (let x = 0; x < w; x++) e[x] = e[(h - 1) * w + x] = 255;
  for (let y = 0; y < h; y++) e[y * w] = e[y * w + w - 1] = 255;
  it.edge = { src, e };
  return e;
}
function liveWire(e, w, h, a, b) {
  // Dijkstra over a window around the two points; returns [x0, y0, x1, y1, ...] from a to b
  const m = 24;
  const x0 = Math.max(0, Math.min(a[0], b[0]) - m), y0 = Math.max(0, Math.min(a[1], b[1]) - m);
  const x1 = Math.min(w - 1, Math.max(a[0], b[0]) + m), y1 = Math.min(h - 1, Math.max(a[1], b[1]) + m);
  const W = x1 - x0 + 1, H = y1 - y0 + 1, N = W * H;
  if (N > 1.5e6) return [a[0], a[1], b[0], b[1]];  // a huge jump: draw it straight rather than freeze
  let mx = 1;  // local normalisation: the strongest edge in view is cheapest, so faint outlines still attract
  for (let y = y0; y <= y1; y++) for (let x = x0, i = y * w + x0; x <= x1; x++, i++) if (e[i] > mx) mx = e[i];
  const cost = new Float32Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0, i = (y + y0) * w + x0, k = y * W; x < W; x++, i++, k++) { const f = 1 - e[i] / mx; cost[k] = 0.1 + f * f; }
  const dist = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const s = (a[1] - y0) * W + a[0] - x0, t = (b[1] - y0) * W + b[0] - x0;
  let hk = new Float32Array(1024), hv = new Int32Array(1024), hn = 0;
  const push = (v, k) => {
    if (hn === hk.length) { const k2 = new Float32Array(hn * 2), v2 = new Int32Array(hn * 2); k2.set(hk); v2.set(hv); hk = k2; hv = v2; }
    let i = hn++;
    while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; }
    hk[i] = k; hv[i] = v;
  };
  const pop = () => {
    const top = hv[0], k = hk[--hn], v = hv[hn];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hn) break;
      if (c + 1 < hn && hk[c + 1] < hk[c]) c++;
      if (hk[c] >= k) break;
      hk[i] = hk[c]; hv[i] = hv[c]; i = c;
    }
    hk[i] = k; hv[i] = v;
    return top;
  };
  dist[s] = 0; push(s, 0);
  while (hn) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === t) break;
    const ux = u % W, uy = (u - ux) / W, du = dist[u];
    for (let dy = -1; dy <= 1; dy++) {
      const ny = uy + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = ux + dx;
        if ((!dx && !dy) || nx < 0 || nx >= W) continue;
        const v = ny * W + nx;
        if (done[v]) continue;
        const nd = du + cost[v] * (dx && dy ? 1.4142 : 1);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
      }
    }
  }
  const out = [];
  for (let v = t; v !== -1; v = v === s ? -1 : prev[v]) out.push(v % W + x0, ((v - v % W) / W) + y0);
  const pts = [];
  for (let i = out.length - 2; i >= 0; i -= 2) pts.push(out[i], out[i + 1]);
  return pts;
}
function clampPt(it, p) { return [Math.min(it.w - 1, Math.max(0, Math.floor(p[0]))), Math.min(it.h - 1, Math.max(0, Math.floor(p[1])))]; }
function snap(e, it, p) {
  // pull the point onto the strongest edge within a few screen pixels (if there is a real edge there)
  const r = Math.min(24, Math.max(2, Math.round(10 / S.vp.s)));
  let bx = p[0], by = p[1], best = -1;
  for (let y = Math.max(0, p[1] - r); y <= Math.min(it.h - 1, p[1] + r); y++)
    for (let x = Math.max(0, p[0] - r); x <= Math.min(it.w - 1, p[0] + r); x++) {
      const d2 = (x - p[0]) ** 2 + (y - p[1]) ** 2;
      if (d2 > r * r) continue;
      const sc = e[y * it.w + x] - 16 * Math.sqrt(d2) / r;
      if (sc > best) { best = sc; bx = x; by = y; }
    }
  return best >= 20 ? [bx, by] : p;
}
const lassoLast = () => [L.pts[L.pts.length - 2], L.pts[L.pts.length - 1]];
function lassoCommit() {
  if (L.live.length > 2) for (let i = 2; i < L.live.length; i++) L.pts.push(L.live[i]);  // live[0..1] is the last anchor
  L.anchors.push(L.pts.length / 2 - 1);
  L.live = [];
}
function lassoUpdate() {
  L.raf = 0;
  const it = S.cur;
  if (!L.on || it !== L.it || !L.want || !S.vp) return;
  const e = edgeMap(it), a = lassoLast(), raw = clampPt(it, L.want);
  const outside = L.want[0] < 0 || L.want[1] < 0 || L.want[0] >= it.w || L.want[1] >= it.h;
  const p = outside ? raw : snap(e, it, raw);  // outside the picture: stay on its border, don't get pulled inward
  const n = L.pts.length / 2 + L.live.length / 2;
  L.near = n > 8 && Math.hypot(raw[0] - L.pts[0], raw[1] - L.pts[1]) * S.vp.s < 10;
  L.live = L.near ? liveWire(e, it.w, it.h, a, [L.pts[0], L.pts[1]]) : liveWire(e, it.w, it.h, a, p);
  if (!L.near && Math.hypot(p[0] - a[0], p[1] - a[1]) * S.vp.s > 48) lassoCommit();  // automatic anchor
  lassoDraw();
}
function lassoMove(pt) { L.want = pt; if (!L.raf) L.raf = requestAnimationFrame(lassoUpdate); }
function lassoDown(pt, ev) {
  const it = S.cur, raw = clampPt(it, pt);
  if (!L.on) {
    if (ev.button !== 0) return;
    const out = pt[0] < 0 || pt[1] < 0 || pt[0] >= it.w || pt[1] >= it.h;
    const p = out ? raw : snap(edgeMap(it), it, raw);
    Object.assign(L, { on: true, it, pts: [p[0], p[1]], anchors: [0], live: [], want: pt, near: false });
    lassoDraw();
    return;
  }
  if (ev.button === 2) return lassoClose(true);
  if (L.raf) { cancelAnimationFrame(L.raf); L.raf = 0; }
  L.want = pt; lassoUpdate();
  if (L.near) return lassoClose(ev.altKey);
  lassoCommit(); lassoDraw();
}
function lassoBack() {
  if (L.anchors.length <= 1) return lassoCancel();
  L.anchors.pop();
  L.pts.length = (L.anchors[L.anchors.length - 1] + 1) * 2;
  L.live = [];
  if (L.want) lassoUpdate(); else lassoDraw();
}
function lassoFinish() {  // leaving the lasso keeps what was drawn, like a brush stroke (Esc discards instead)
  if (L.on && L.it === S.cur && L.pts.length + L.live.length >= 6) lassoClose(false);
  else lassoCancel();
}
function lassoCancel() {
  if (L.raf) cancelAnimationFrame(L.raf);
  Object.assign(L, { on: false, it: null, pts: [], anchors: [], live: [], want: null, near: false, raf: 0 });
  lassoDraw();
}
function lassoClose(sub) {
  const it = L.it;
  if (!L.on || it !== S.cur) return lassoCancel();
  if (L.live.length) lassoCommit();
  const e = edgeMap(it), back = liveWire(e, it.w, it.h, lassoLast(), [L.pts[0], L.pts[1]]);
  const poly = L.pts.concat(back.slice(2));
  lassoCancel();
  let area = 0;
  for (let i = 0, n = poly.length; i < n; i += 2) { const j = (i + 2) % n; area += poly[i] * poly[j + 1] - poly[j] * poly[i + 1]; }
  if (poly.length < 6 || Math.abs(area) / 2 < 4) return;
  const path = new Path2D();
  path.moveTo(poly[0] + 0.5, poly[1] + 0.5);
  for (let i = 2; i < poly.length; i += 2) path.lineTo(poly[i] + 0.5, poly[i + 1] + 0.5);
  path.closePath();
  const v = sub ? 0 : Math.round(S.mix * 2.55), col = `rgb(${v},${v},${v})`;
  pushUndo(it);
  const targets = [g2(it.mask, true)];
  if (!sub) {  // also into the current-stroke canvas, for its tint
    fit2(strokeC, it.w, it.h);
    const sc = g2(strokeC); sc.fillStyle = "#000"; sc.fillRect(0, 0, it.w, it.h);
    targets.push(sc);
  }
  for (const c of targets) {
    c.globalCompositeOperation = "source-over";
    c.fillStyle = c.strokeStyle = col; c.lineWidth = 1; c.lineJoin = "round";
    c.fill(path); c.stroke(path);  // the outline pixels sit on the edge itself: include them
  }
  it.hasMask = sub ? hasPixels(it) : true;
  composite(); scheduleSave(it); syncPanel(); renderStrip();
  if (sub) flashAll(900);
  else if (S.eyeMode === "auto") {  // show the filled area a moment, like a brush stroke
    strokeTool = "brush"; S.flash = true; clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { S.flash = false; render(); }, 900);
    render();
  }
}
function lassoDraw() {
  const svg = $("#lassoSvg");
  const show = L.on && S.cur && S.cur === L.it && S.vp && L.pts.length;
  svg.toggleAttribute("hidden", !show);
  if (!show) return;
  const { s, x, y } = S.vp;
  const X = v => ((v + 0.5) * s + x).toFixed(1), Y = v => ((v + 0.5) * s + y).toFixed(1);
  const all = L.live.length ? L.pts.concat(L.live.slice(2)) : L.pts;
  let d = "", lx = -1e9, ly = -1e9;
  for (let i = 0; i < all.length; i += 2) {
    const sx = (all[i] + 0.5) * s, sy = (all[i + 1] + 0.5) * s;
    if (i && i < all.length - 2 && Math.abs(sx - lx) < 1.5 && Math.abs(sy - ly) < 1.5) continue;  // thin out for long outlines
    d += (i ? "L" : "M") + X(all[i]) + " " + Y(all[i + 1]);
    lx = sx; ly = sy;
  }
  $("#lzB").setAttribute("d", d); $("#lzW").setAttribute("d", d);
  let a = "";
  for (const k of L.anchors.slice(1)) a += `M${(+X(L.pts[k * 2]) - 2.5).toFixed(1)} ${(+Y(L.pts[k * 2 + 1]) - 2.5).toFixed(1)}h5v5h-5z`;
  $("#lzA").setAttribute("d", a);
  const st = $("#lzStart");
  st.setAttribute("cx", X(L.pts[0])); st.setAttribute("cy", Y(L.pts[1]));
  st.classList.toggle("near", L.near);
}

/* ---------------- colour layer: paint brush + eyedropper ---------------- */
// A transparent layer on top of the result (protection included). It never changes the original or the protected
// area, it survives re-denoising, and it is part of the downloaded / auto-saved PNG.
// Strokes work like PS: dabs build up inside one stroke, and the stroke's opacity caps how much it covers.
const strokeP = mk(), stampC = mk();
let pStroke = null, stampKey = "", paintRaf = 0;
function paintLayer(it) {
  if (!it.paint) { it.paint = mk(); it.paint.width = it.w; it.paint.height = it.h; }
  return it.paint;
}
function drawPaint() {
  const it = S.cur;
  if (!it) return;
  fit2(cvP, it.w, it.h);
  const c = g2(cvP);
  c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.clearRect(0, 0, it.w, it.h);
  if (it.paint) c.drawImage(it.paint, 0, 0);
  if (pStroke) {
    c.globalAlpha = S.P.opac / 100;
    c.globalCompositeOperation = pStroke.erase ? "destination-out" : "source-over";
    c.drawImage(strokeP, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
  }
}
const schedulePaint = () => { if (!paintRaf) paintRaf = requestAnimationFrame(() => { paintRaf = 0; drawPaint(); }); };
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
function stamp(erase) {
  const P = S.P, col = erase ? "#000000" : P.color, key = `${P.size}|${P.hard}|${P.pixel}|${col}`;
  if (key === stampKey) return stampC;
  stampKey = key;
  const c = g2(stampC);
  if (P.pixel) {  // whole pixels, no anti-aliasing: a 1 px pen is exactly one pixel, 2 px a 2x2 block
    const s = Math.max(1, Math.round(P.size)), r2 = (s / 2) ** 2 + 0.25;
    stampC.width = stampC.height = s;
    c.clearRect(0, 0, s, s); c.fillStyle = col;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if ((x + 0.5 - s / 2) ** 2 + (y + 0.5 - s / 2) ** 2 <= r2) c.fillRect(x, y, 1, 1);
    return stampC;
  }
  const r = P.size / 2, n = Math.ceil(P.size) + 2, m = n / 2;
  stampC.width = stampC.height = n;
  c.clearRect(0, 0, n, n);
  if (P.hard >= 100) { c.fillStyle = col; c.beginPath(); c.arc(m, m, r, 0, Math.PI * 2); c.fill(); return stampC; }
  const [R, G, B] = hexRGB(col), g = c.createRadialGradient(m, m, r * P.hard / 100, m, m, r);
  g.addColorStop(0, `rgba(${R},${G},${B},1)`); g.addColorStop(1, `rgba(${R},${G},${B},0)`);  // fade to the same colour, no grey fringe
  c.fillStyle = g; c.fillRect(0, 0, n, n);
  return stampC;
}
function dab(x, y) {
  const st = stamp(pStroke.erase), c = g2(strokeP);
  if (S.P.pixel) { const s = st.width; c.drawImage(st, Math.floor(x) - Math.floor((s - 1) / 2), Math.floor(y) - Math.floor((s - 1) / 2)); }
  else c.drawImage(st, x - st.width / 2, y - st.height / 2);
}
function paintTo(pt) {  // dabs along the segment, evenly spaced across segments
  const a = pStroke.last, dx = pt[0] - a[0], dy = pt[1] - a[1], dist = Math.hypot(dx, dy);
  if (!dist) return;
  const step = S.P.pixel ? 1 : Math.max(0.5, S.P.size * 0.1);
  let s = step - pStroke.carry;
  for (; s <= dist; s += step) dab(a[0] + dx * s / dist, a[1] + dy * s / dist);
  pStroke.carry = dist - (s - step);
  pStroke.last = pt;
  schedulePaint();
}
function beginPaint(pt, erase, line) {
  const it = S.cur;
  paintLayer(it);
  pushUndo(it, "paint");
  fit2(strokeP, it.w, it.h); g2(strokeP).clearRect(0, 0, it.w, it.h);
  const from = line && it.lastPaintPt;
  pStroke = { erase, carry: 0, last: from || pt };
  if (from) { dab(...from); paintTo(pt); } else { dab(...pt); schedulePaint(); }
}
function endPaint() {
  const it = S.cur;
  if (!pStroke || !it) return;
  const c = g2(it.paint, true);
  c.globalAlpha = S.P.opac / 100;
  c.globalCompositeOperation = pStroke.erase ? "destination-out" : "source-over";
  c.drawImage(strokeP, 0, 0);
  c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
  it.lastPaintPt = pStroke.last;
  const erased = pStroke.erase;
  pStroke = null;
  it.hasPaint = erased ? paintHasPixels(it) : true;
  drawPaint(); scheduleSave(it); syncPanel(); renderStrip();
}
function paintHasPixels(it) {
  if (!it.paint) return false;
  const d = g2(it.paint, true).getImageData(0, 0, it.w, it.h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
  return false;
}
function clearPaint() {
  const it = S.cur;
  if (!it || !it.hasPaint) return;
  pushUndo(it, "paint");
  g2(it.paint, true).clearRect(0, 0, it.w, it.h); it.hasPaint = false;
  drawPaint(); scheduleSave(it); syncPanel(); renderStrip();
  toast("已清除上的颜色（Ctrl+Z 可撤销）");
}
// eyedropper: hold Alt (PS, SAI, CSP) or Ctrl (Krita) with the colour brush
function picking() { return S.brushMode && S.tool === "paint" && S.pickHeld; }
function readerOf(it, kind) {  // a readable copy of the original or of the unprotected result
  const key = kind === "orig" ? it.srcURL : it.result.url;
  it.readers ??= {};
  if (it.readers[kind]?.key !== key) {
    const c = mk(); c.width = it.w; c.height = it.h;
    const g = g2(c, true); g.drawImage(kind === "orig" ? it.srcImg : it.result.img, 0, 0);
    it.readers[kind] = { key, g };
  }
  return it.readers[kind].g;
}
function sampleAt(pt, screenX) {
  // the colour shown under the cursor: in the comparison view the left side gives the original, the right the result
  const it = S.cur, x = Math.floor(pt[0]), y = Math.floor(pt[1]);
  if (!it || x < 0 || y < 0 || x >= it.w || y >= it.h) return null;
  const m = S.peekOrig ? "before" : (it.result ? S.view : "before");
  const left = m === "before" || (m === "cmp" && screenX < S.split * stage.clientWidth);
  let px;
  if (left) px = readerOf(it, m === "cmp" && S.base === "den" && it.hasMask ? "den" : "orig").getImageData(x, y, 1, 1).data;
  else {
    px = [...g2(cvA, true).getImageData(x, y, 1, 1).data];
    if (it.paint && it.hasPaint) {
      const q = g2(it.paint, true).getImageData(x, y, 1, 1).data, a = q[3] / 255;
      for (let k = 0; k < 3; k++) px[k] = q[k] * a + px[k] * (1 - a);
    }
  }
  return "#" + [0, 1, 2].map(k => Math.round(px[k]).toString(16).padStart(2, "0")).join("");
}
function setPaintColor(col) {
  if (!col) return;
  S.P.color = col; store("pColor", col); stampKey = "";
  syncBrushUI(); updateCursor();
}
function showLoupe(at, col) {
  const l = $("#pickLoupe");
  if (!at || !col) { l.hidden = true; return; }
  l.hidden = false;
  l.style.left = at[0] + "px"; l.style.top = at[1] + "px";
  l.style.setProperty("--new", col); l.style.setProperty("--cur", S.P.color);
}
$("#pColor").addEventListener("input", e => setPaintColor(e.target.value));
$("#pSize").addEventListener("input", e => { S.P.size = +e.target.value; syncBrushUI(); updateCursor(); });
$("#pHard").addEventListener("input", e => { S.P.hard = +e.target.value; syncBrushUI(); });
$("#pOpac").addEventListener("input", e => { S.P.opac = +e.target.value; syncBrushUI(); });
$("#pPixel").onclick = () => { S.P.pixel = !S.P.pixel; syncBrushUI(); updateCursor(); };
function setHardness(v) {
  S.P.hard = Math.min(100, Math.max(0, v)); syncBrushUI();
  showTipAt(`硬度 ${S.P.hard}%`, true);
}
let digitAt = 0, digitPrev = "";
function opacityKey(d) {  // PS: 1-9 = 10-90%, 0 = 100%; two digits typed quickly = that exact percent (4 5 -> 45%)
  const now = performance.now(), quick = now - digitAt < 600 && digitPrev !== "";
  const v = quick ? Math.max(1, +(digitPrev + d)) : d === "0" ? 100 : +d * 10;
  digitPrev = quick ? "" : d; digitAt = now;
  S.P.opac = v; syncBrushUI();
  showTipAt(`${S.tool === "erase" ? "力度" : "不透明度"} ${v}%`, true);
}

/* ---------------- pointer ---------------- */
let drag = null, cursorPt = null;
const onUI = e => !!(e.target && e.target.closest && e.target.closest(".floatbar"));  // toolbar inside the stage
const toImg = (e, r) => [(e.clientX - r.left - S.vp.x) / S.vp.s, (e.clientY - r.top - S.vp.y) / S.vp.s];
function updateCursor() {
  const b = $("#brushCur");
  const pt = S.spaceMode === "size" ? S.sizeAt : cursorPt;
  const pick = picking();
  stage.classList.toggle("picking", !!(S.cur && S.vp && !S.space && pick));
  stage.classList.toggle("paint", !!(S.cur && S.vp && S.brushMode && !S.space && S.tool !== "lasso" && !pick));
  if (!pick || !pt || !S.vp) showLoupe(null);
  else showLoupe(pt, sampleAt([(pt[0] - S.vp.x) / S.vp.s, (pt[1] - S.vp.y) / S.vp.s], pt[0]));
  if (!S.brushMode || S.tool === "lasso" || pick || !S.vp || !pt || (drag && drag.t === "pan") || (S.space && S.spaceMode !== "size")) { b.hidden = true; return; }
  const paint = S.layer === "paint";
  const d = Math.max(paint ? 4 : 0, curSize() * S.vp.s);
  b.hidden = false; b.style.width = b.style.height = d + "px";
  b.style.left = pt[0] + "px"; b.style.top = pt[1] + "px";
  b.classList.toggle("pc", paint);  // a centre dot: small colour brushes stay easy to aim
  b.style.borderRadius = paint && S.P.pixel ? "2px" : "";
  b.style.background = S.tool === "erase" || paint ? "none" : `rgba(${maskRGB()}, ${(0.32 * S.mix / 100).toFixed(3)})`;
}
stage.addEventListener("contextmenu", e => e.preventDefault());
stage.addEventListener("pointerdown", e => {
  if (!S.cur || !S.vp || onUI(e)) return;
  const r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
  const divOn = !$("#div").hidden, dx = px - S.split * r.width;
  const onKnob = divOn && Math.hypot(dx, py - r.height / 2) < 22, onLine = divOn && Math.abs(dx) < 9;
  stage.setPointerCapture(e.pointerId);
  if (e.button === 1 || S.space) { drag = { t: "pan", x: e.clientX, y: e.clientY }; if (S.space) { S.spaceMode = "pan"; $("#sizeTip").hidden = true; } }
  else if (e.button === 0 && (onKnob || (onLine && !S.brushMode))) drag = { t: "split" };
  else if (S.brushMode && S.tool === "lasso" && (e.button === 0 || e.button === 2)) lassoDown(toImg(e, r), e);
  else if (S.brushMode && S.layer === "paint" && (e.button === 0 || e.button === 2)) {
    S.pickHeld = e.altKey || e.ctrlKey;
    if (picking() && e.button === 0) { drag = { t: "pick" }; setPaintColor(sampleAt(toImg(e, r), px)); }
    else { drag = { t: "pstroke" }; beginPaint(toImg(e, r), e.button === 2 || S.tool === "erase", e.shiftKey); }
  }
  else if (S.brushMode && (e.button === 0 || e.button === 2)) {
    strokeTool = e.button === 2 ? "erase" : S.tool;
    pushUndo(S.cur); S.painting = true; drag = { t: "paint" };
    lastPt = e.shiftKey && S.cur.lastMaskPt ? S.cur.lastMaskPt : null;  // Shift+click: straight line from the last stroke
    fit2(strokeC, S.cur.w, S.cur.h); { const sc = g2(strokeC); sc.fillStyle = "#000"; sc.fillRect(0, 0, S.cur.w, S.cur.h); }
    clearTimeout(flashTimer); S.flash = false;
    strokeTo(toImg(e, r)); render();
  } else if (e.button === 0) drag = { t: "pan", x: e.clientX, y: e.clientY };
  if (drag && drag.t === "pan") stage.classList.add("panning");
  updateCursor();
});
stage.addEventListener("pointermove", e => {
  const r = stage.getBoundingClientRect();
  if (S.brushMode && S.tool === "paint" && !drag) S.pickHeld = e.altKey || e.ctrlKey;  // keys pressed outside the window
  cursorPt = !drag && onUI(e) ? null : [e.clientX - r.left, e.clientY - r.top]; updateCursor();  // no brush circle over the toolbar
  if (L.on && !drag && S.vp) lassoMove(toImg(e, r));
  if (!drag) return;
  if (drag.t === "split") { S.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); render(); }
  else if (drag.t === "paint") strokeTo(toImg(e, r));
  else if (drag.t === "pstroke") paintTo(toImg(e, r));
  else if (drag.t === "pick") setPaintColor(sampleAt(toImg(e, r), e.clientX - r.left));
  else { S.vp.x += e.clientX - drag.x; S.vp.y += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; render(); }
});
function pointerEnd() {
  if (drag && drag.t === "paint") endStroke();
  if (drag && drag.t === "pstroke") endPaint();
  drag = null; stage.classList.remove("panning"); render(); updateCursor();
}
stage.addEventListener("pointerup", pointerEnd);
stage.addEventListener("pointercancel", pointerEnd);
stage.addEventListener("pointerleave", () => { cursorPt = null; updateCursor(); });

/* ---------------- keyboard ---------------- */
// With a Chinese IME on, letter keys arrive as "Process" and [ ] as 【 】: read the physical key instead
function keyOf(e) {
  if (e.key && e.key !== "Process" && e.key !== "Unidentified") return ({ "【": "[", "】": "]", "{": "[", "}": "]" })[e.key] || e.key.toLowerCase();
  const c = e.code || "";
  return /^Key[A-Z]$/.test(c) ? c.slice(3).toLowerCase() : /^(Digit|Numpad)\d$/.test(c) ? c.slice(-1)
    : ({ BracketLeft: "[", BracketRight: "]", Space: " ", Escape: "escape", Enter: "enter", Backspace: "backspace" })[c] || "";
}
addEventListener("keydown", e => {
  if ($("#helpDlg").open || $("#quitDlg").open) return;
  const k = keyOf(e), el = e.target;
  const typing = (el.tagName === "INPUT" && el.type !== "range" && el.type !== "color") || el.tagName === "TEXTAREA";
  if (e.key === "Alt" || e.key === "Control") {  // held with the colour brush: eyedropper
    if (S.brushMode && S.tool === "paint") {
      if (e.key === "Alt") e.preventDefault();  // otherwise Windows moves focus to the browser menu on release
      if (!S.pickHeld) { S.pickHeld = true; updateCursor(); }
    }
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (k === "o") { e.preventDefault(); pick(); }
    else if (k === "s") { e.preventDefault(); download(); }
    else if (k === "enter") { e.preventDefault(); if (S.cur) enqueue(S.cur, true); }
    else if (k === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === "y" && !typing) { e.preventDefault(); redo(); }
    else if (k === "i" && e.shiftKey && !typing) { e.preventDefault(); invertMask(); }  // PS: inverse selection
    else if (k === "0") { e.preventDefault(); fit(); }  // PS: fit on screen
    else if (k === "1") { e.preventDefault(); zoomAt(1, null, null, true); }  // PS: 100%
    else if (k === "=" || k === "+" || e.code === "NumpadAdd") { e.preventDefault(); zoomAt(1.25); }  // instead of the browser's page zoom
    else if (k === "-" || e.code === "NumpadSubtract") { e.preventDefault(); zoomAt(0.8); }
    return;
  }
  if (typing || e.altKey) return;
  if ((k === "[" || k === "]") && S.cur) {  // [ ] size; Shift+[ ] hardness (PS)
    e.preventDefault();
    const up = k === "]";
    if (e.shiftKey) { if (S.layer === "paint" && !S.P.pixel) setHardness(S.P.hard + (up ? 25 : -25)); }
    else { const v = curSize(); setBrushSize(up ? Math.max(v + 1, v * 1.2) : Math.min(v - 1, v / 1.2), true); }
    return;
  }
  if (/^\d$/.test(k) && S.cur && S.brushMode && S.layer === "paint") {  // PS: number keys = opacity
    e.preventDefault(); opacityKey(k);
    return;
  }
  if (k === " ") { e.preventDefault(); if (!S.space) { S.space = true; S.spaceMode = "idle"; render(); updateCursor(); } return; }
  if (e.key === "?") { $("#helpDlg").showModal(); return; }
  if (!S.cur) return;
  const onRange = el.tagName === "INPUT";
  const act = {
    "1": () => { S.view = "cmp"; render(); }, "2": () => { S.view = "before"; render(); }, "3": () => { S.view = "after"; render(); },
    x: () => { if (e.repeat || !S.cur.result) return; S.view = S.view === "after" ? "before" : "after"; render(); },
    z: () => { if (!e.repeat) { S.peekOrig = true; render(); } },
    m: () => { if (!e.repeat) { S.peekMask = true; render(); } },
    // B toggles: enter painting; in painting with the eraser -> back to brush; with the brush -> finish
    b: () => { if (e.repeat) return; if (!S.brushMode) setBrushMode(true, "brush"); else if (S.tool !== "brush") setBrushMode(true, "brush"); else setBrushMode(false); },
    e: () => setBrushMode(true, "erase"),  // erases the layer in use: the protected area, or the colour after P
    // P toggles the colour brush the same way
    p: () => { if (e.repeat) return; if (!S.brushMode || S.tool !== "paint") setBrushMode(true, "paint"); else setBrushMode(false); },
    // L toggles the lasso (an open outline is closed and kept); Esc leaves the brush or the lasso (an open outline is dropped)
    l: () => { if (!e.repeat) S.brushMode && S.tool === "lasso" ? setBrushMode(false) : setBrushMode(true, "lasso"); },
    i: () => { if (!e.repeat) invertMask(); },
    a: () => { if (!e.repeat) autoSelect(); },
    ...(L.on && {  // only while an outline is open, so Enter still presses a focused button otherwise
      enter: () => lassoClose(false),
      backspace: lassoBack,
      delete: lassoBack,
    }),
    escape: () => { lassoCancel(); setBrushMode(false); },
    f: fit, "0": () => zoomAt(1, null, null, true),
    arrowleft: () => !onRange && step(-1), arrowright: () => !onRange && step(1),
  }[k];
  if (act) { if (!(onRange && k.startsWith("arrow"))) e.preventDefault(); act(); }
});
addEventListener("keyup", e => {
  const k = keyOf(e);
  if ((e.key === "Alt" || e.key === "Control") && S.pickHeld) {
    if (e.key === "Alt") e.preventDefault();
    S.pickHeld = false; updateCursor();
  }
  if (k === " ") { S.space = false; S.spaceMode = ""; $("#sizeTip").hidden = true; render(); updateCursor(); }
  if (k === "z" && S.peekOrig) { S.peekOrig = false; render(); }
  if (k === "m" && S.peekMask) { S.peekMask = false; render(); }
});
addEventListener("blur", () => { S.space = S.peekOrig = S.peekMask = S.pickHeld = false; S.spaceMode = ""; $("#sizeTip").hidden = true; render(); updateCursor(); });

syncBrushUI(); syncPanel(); renderStrip(); render();
