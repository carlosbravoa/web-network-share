"use strict";

const $ = (id) => document.getElementById(id);
const fileList = $("fileList");
const crumbs = $("crumbs");
const dropzone = $("dropzone");
const dropOverlay = $("dropOverlay");
const emptyState = $("empty");
const diskInfo = $("diskInfo");

let cwd = ""; // current folder, relative to share root
let currentItems = []; // items shown in the current folder
const selected = new Set(); // selected item paths
let dragItems = []; // paths currently being dragged for a move
const MOVE_TYPE = "application/x-msb-move"; // marks an internal (move) drag

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //
function fmtSize(bytes) {
  if (bytes === 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const n = bytes / Math.pow(1024, i);
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function fmtDate(epoch) {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

function svgIcon(kind) {
  if (kind === "folder") {
    return `<svg class="icon folder" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>`;
  }
  return `<svg class="icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`;
}

const ICONS = {
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`,
  rename: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>`,
  move: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h6l2 2h10v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 13h6"/><path d="M13 11l2 2-2 2"/></svg>`,
};

let toastTimer = null;
function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

// --------------------------------------------------------------------------- //
// Listing & rendering
// --------------------------------------------------------------------------- //
async function load(path) {
  cwd = path || "";
  selected.clear(); // selection is scoped to the folder being viewed
  let data;
  try {
    const r = await fetch(`/api/list?path=${encodeURIComponent(cwd)}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    data = await r.json();
  } catch (e) {
    toast("Could not load folder: " + e.message, true);
    return;
  }
  cwd = data.path;
  renderCrumbs();
  renderList(data.items);
  const d = data.disk;
  diskInfo.textContent =
    `${fmtSize(d.used)} used · ${fmtSize(d.free)} free of ${fmtSize(d.total)}`;
}

function renderCrumbs() {
  crumbs.innerHTML = "";
  const parts = cwd ? cwd.split("/") : [];
  const home = document.createElement("a");
  home.textContent = "🏠 Home";
  home.onclick = () => load("");
  if (!parts.length) home.classList.add("current");
  wireDropTarget(home, () => "");
  crumbs.appendChild(home);
  let acc = "";
  parts.forEach((p, i) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    crumbs.appendChild(sep);
    acc = acc ? `${acc}/${p}` : p;
    const a = document.createElement("a");
    a.textContent = p;
    const target = acc;
    a.onclick = () => load(target);
    wireDropTarget(a, () => target);
    if (i === parts.length - 1) a.classList.add("current");
    crumbs.appendChild(a);
  });
}

function renderList(items) {
  currentItems = items;
  fileList.innerHTML = "";
  emptyState.hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement("li");
    li.className = "file-row";

    // Drag this row to move it (or the whole selection, if it's part of one).
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      dragItems = selected.has(it.path) && selected.size > 1
        ? [...selected] : [it.path];
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(MOVE_TYPE, "1");
      e.dataTransfer.setData("text/plain", dragItems.join("\n"));
      li.classList.add("dragging-row");
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging-row");
      dragItems = [];
    });
    // Folders are also drop targets: drop an item onto one to move it inside.
    if (it.is_dir) wireDropTarget(li, () => it.path);

    const nameCell = document.createElement("div");
    nameCell.className = "name-cell " + (it.is_dir ? "folder" : "file");

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "row-check";
    check.checked = selected.has(it.path);
    check.onchange = () => {
      if (check.checked) selected.add(it.path);
      else selected.delete(it.path);
      updateSelbar();
    };
    nameCell.appendChild(check);

    nameCell.insertAdjacentHTML("beforeend",
      svgIcon(it.is_dir ? "folder" : "file") + `<span class="label"></span>`);
    nameCell.querySelector(".label").textContent = it.name;
    if (it.is_dir) {
      nameCell.querySelector(".label").onclick = () => load(it.path);
    } else {
      const lbl = nameCell.querySelector(".label");
      lbl.style.cursor = "pointer";
      lbl.title = "Download";
      lbl.onclick = () => download(it.path);
    }

    const sizeCell = document.createElement("div");
    sizeCell.className = "col-size";
    sizeCell.textContent = it.is_dir ? "—" : fmtSize(it.size);

    const modCell = document.createElement("div");
    modCell.className = "col-mod";
    modCell.textContent = fmtDate(it.modified);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    if (!it.is_dir) {
      actions.appendChild(iconButton(ICONS.download, "Download", () => download(it.path)));
    }
    actions.appendChild(iconButton(ICONS.move, "Move to…", () => openMovePicker([it])));
    actions.appendChild(iconButton(ICONS.rename, "Rename", () => rename(it)));
    actions.appendChild(iconButton(ICONS.trash, "Delete", () => remove(it), true));

    li.append(nameCell, sizeCell, modCell, actions);
    fileList.appendChild(li);
  }
  updateSelbar();
}

// --------------------------------------------------------------------------- //
// Multi-select: ZIP download & bulk delete
// --------------------------------------------------------------------------- //
const selbar = $("selbar");
const selectAll = $("selectAll");

function updateSelbar() {
  const n = selected.size;
  selbar.hidden = n === 0;
  $("selCount").textContent = `${n} selected`;
  selectAll.checked = n > 0 && n === currentItems.length;
  selectAll.indeterminate = n > 0 && n < currentItems.length;
}

selectAll.onchange = () => {
  selected.clear();
  if (selectAll.checked) currentItems.forEach((it) => selected.add(it.path));
  // re-tick the visible checkboxes without a full reload
  document.querySelectorAll(".row-check").forEach((c, i) => {
    c.checked = selectAll.checked;
  });
  updateSelbar();
};

$("clearSelBtn").onclick = () => {
  selected.clear();
  document.querySelectorAll(".row-check").forEach((c) => (c.checked = false));
  updateSelbar();
};

$("zipBtn").onclick = () => {
  if (!selected.size) return;
  // A form POST lets the browser stream the zip straight to a download,
  // and avoids any URL-length limit when many files are selected.
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/zip";
  for (const p of selected) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "path";
    input.value = p;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  form.remove();
};

$("bulkDeleteBtn").onclick = async () => {
  const paths = [...selected];
  if (!paths.length) return;
  if (!confirm(`Delete ${paths.length} selected item${paths.length === 1 ? "" : "s"}? ` +
    `Folders are removed with everything inside.`)) return;
  let failed = 0;
  for (const path of paths) {
    try {
      const r = await fetch("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!r.ok) failed++;
    } catch (_) { failed++; }
  }
  if (failed) toast(`${failed} item(s) could not be deleted`, true);
  else toast(`Deleted ${paths.length} item(s)`);
  load(cwd);
};

// --------------------------------------------------------------------------- //
// Drag-to-move
// --------------------------------------------------------------------------- //
function isInternalDrag(e) {
  return e.dataTransfer && [...e.dataTransfer.types].includes(MOVE_TYPE);
}

// Make `el` accept dropped rows; getDest() returns the destination folder path.
function wireDropTarget(el, getDest) {
  el.addEventListener("dragover", (e) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
  });
  el.addEventListener("drop", (e) => {
    if (!isInternalDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drop-target");
    moveItems(dragItems.slice(), getDest());
  });
}

async function moveItems(paths, dest) {
  let moved = 0, failed = 0, lastErr = "";
  for (const path of paths) {
    // Skip dropping a folder onto itself, and items already in the target.
    if (path === dest) continue;
    try {
      const r = await fetch("/api/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, dest }),
      });
      if (r.ok) moved++;
      else { failed++; lastErr = (await r.json()).error || ""; }
    } catch (e) { failed++; lastErr = e.message; }
  }
  if (moved) toast(`Moved ${moved} item${moved === 1 ? "" : "s"}` +
    (dest ? ` to ${dest.split("/").pop()}` : " to Home"));
  if (failed) toast(`${failed} couldn't be moved${lastErr ? ": " + lastErr : ""}`, true);
  load(cwd);
}

// ----- "Move to…" folder picker (works on touch, no dragging needed) ------- //
const movePicker = $("movePicker");
let moveTargets = []; // item objects {path, name, is_dir} being moved
let pickerCwd = "";   // folder currently browsed inside the picker

// A destination is blocked if it's a folder being moved, or inside one.
function destBlocked(dest) {
  return moveTargets.some((t) =>
    t.is_dir && (dest === t.path || dest.startsWith(t.path + "/")));
}

function openMovePicker(items) {
  moveTargets = items;
  if (!moveTargets.length) return;
  pickerCwd = ""; // start at Home so any destination is reachable
  const n = moveTargets.length;
  $("moveTitle").textContent = n === 1
    ? `Move “${moveTargets[0].name}” to…`
    : `Move ${n} items to…`;
  movePicker.hidden = false;
  renderPicker();
}

function closePicker() {
  movePicker.hidden = true;
  moveTargets = [];
}

async function renderPicker() {
  const pathEl = $("movePath");
  const listEl = $("moveList");
  // Breadcrumb inside the picker.
  pathEl.innerHTML = "";
  const mk = (label, target, current) => {
    const a = document.createElement("a");
    a.textContent = label;
    if (current) a.classList.add("current");
    else a.onclick = () => { pickerCwd = target; renderPicker(); };
    return a;
  };
  pathEl.appendChild(mk("🏠 Home", "", pickerCwd === ""));
  let acc = "";
  (pickerCwd ? pickerCwd.split("/") : []).forEach((p, i, arr) => {
    const sep = document.createElement("span");
    sep.className = "sep"; sep.textContent = "/";
    pathEl.appendChild(sep);
    acc = acc ? `${acc}/${p}` : p;
    pathEl.appendChild(mk(p, acc, i === arr.length - 1));
  });

  // Folders inside the current picker folder.
  listEl.innerHTML = "";
  let data;
  try {
    const r = await fetch(`/api/list?path=${encodeURIComponent(pickerCwd)}`);
    data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
  } catch (e) {
    listEl.innerHTML = `<li class="move-empty">Couldn’t load: ${e.message}</li>`;
    return;
  }
  pickerCwd = data.path;
  const folders = data.items.filter((it) => it.is_dir && !destBlocked(it.path));
  if (!folders.length) {
    listEl.innerHTML = `<li class="move-empty">No subfolders here</li>`;
  } else {
    for (const f of folders) {
      const li = document.createElement("li");
      li.className = "move-row";
      li.innerHTML = svgIcon("folder") + `<span class="label"></span>` +
        `<span class="enter">›</span>`;
      li.querySelector(".label").textContent = f.name;
      li.onclick = () => { pickerCwd = f.path; renderPicker(); };
      listEl.appendChild(li);
    }
  }

  // "Move here" targets the folder currently shown; block invalid spots.
  const confirm = $("moveConfirm");
  const blocked = destBlocked(pickerCwd);
  confirm.disabled = blocked;
  confirm.textContent = pickerCwd
    ? `Move here: ${pickerCwd.split("/").pop()}` : "Move to Home";
}

$("moveBtn").onclick = () =>
  openMovePicker(currentItems.filter((it) => selected.has(it.path)));
$("moveConfirm").onclick = () => {
  const dest = pickerCwd;
  const paths = moveTargets.map((t) => t.path);
  closePicker();
  moveItems(paths, dest);
};
$("moveNewFolder").onclick = async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    const r = await fetch("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: joinPath(pickerCwd, name) }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    renderPicker();
  } catch (e) { toast("Could not create folder: " + e.message, true); }
};
$("moveCancel").onclick = closePicker;
$("moveClose").onclick = closePicker;
movePicker.onclick = (e) => { if (e.target === movePicker) closePicker(); };

function iconButton(svg, title, onClick, danger) {
  const b = document.createElement("button");
  b.className = "icon-btn" + (danger ? " danger" : "");
  b.title = title;
  b.innerHTML = svg;
  b.onclick = onClick;
  return b;
}

// --------------------------------------------------------------------------- //
// File operations
// --------------------------------------------------------------------------- //
function download(path) {
  window.location.href = `/api/download?path=${encodeURIComponent(path)}`;
}

async function remove(it) {
  if (!confirm(`Delete ${it.is_dir ? "folder" : "file"} "${it.name}"?` +
    (it.is_dir ? "\nEverything inside it will be removed." : ""))) return;
  try {
    const r = await fetch("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: it.path }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    toast(`Deleted "${it.name}"`);
    load(cwd);
  } catch (e) {
    toast("Delete failed: " + e.message, true);
  }
}

async function rename(it) {
  const name = prompt("Rename to:", it.name);
  if (!name || name === it.name) return;
  try {
    const r = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: it.path, name }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    load(cwd);
  } catch (e) {
    toast("Rename failed: " + e.message, true);
  }
}

async function makeFolder() {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    const r = await fetch("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: joinPath(cwd, name) }),
    });
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    load(cwd);
  } catch (e) {
    toast("Could not create folder: " + e.message, true);
  }
}

// --------------------------------------------------------------------------- //
// Upload queue (raw streamed PUT, with progress)
// --------------------------------------------------------------------------- //
const uploadsBox = $("uploads");
const uploadList = $("uploadList");
const uploadsTitle = $("uploadsTitle");
let queue = [];
let active = 0;
const MAX_CONCURRENT = 3;
let pending = 0;

$("uploadsClose").onclick = () => {
  uploadsBox.hidden = true;
  uploadList.innerHTML = "";
  queue = [];
};

function enqueue(file, relPath) {
  // relPath is the destination path relative to current cwd (may include subdirs)
  const dest = joinPath(cwd, relPath);
  const row = document.createElement("li");
  row.className = "up-item";
  row.innerHTML =
    `<div class="up-top"><span class="up-name"></span><span class="up-pct">0%</span></div>` +
    `<div class="bar"><span></span></div>`;
  row.querySelector(".up-name").textContent = relPath;
  uploadList.appendChild(row);
  queue.push({ file, dest, row });
  pending++;
  uploadsBox.hidden = false;
  updateTitle();
  pump();
}

function updateTitle() {
  uploadsTitle.textContent = pending > 0
    ? `Uploading ${pending} item${pending === 1 ? "" : "s"}…`
    : "Uploads complete";
}

function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    active++;
    sendOne(job);
  }
}

function sendOne({ file, dest, row }) {
  const pct = row.querySelector(".up-pct");
  const bar = row.querySelector(".bar > span");
  const xhr = new XMLHttpRequest();
  xhr.open("PUT", `/api/upload?path=${encodeURIComponent(dest)}`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const p = Math.round((e.loaded / e.total) * 100);
      bar.style.width = p + "%";
      pct.textContent = p + "%";
    }
  };
  const finish = (ok, msg) => {
    active--;
    pending--;
    row.classList.add(ok ? "done" : "error");
    if (ok) { bar.style.width = "100%"; pct.textContent = "✓"; }
    else { pct.textContent = msg || "failed"; }
    updateTitle();
    if (ok && pending === 0) load(cwd);
    else if (ok) refreshSoon();
    pump();
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) finish(true);
    else {
      let m = "failed";
      try { m = JSON.parse(xhr.responseText).error || m; } catch (_) {}
      finish(false, m);
    }
  };
  xhr.onerror = () => finish(false, "network error");
  xhr.send(file);
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => load(cwd), 600);
}

// --------------------------------------------------------------------------- //
// Drag & drop (files and folders) + file picker
// --------------------------------------------------------------------------- //
// Recursively walk a dropped directory entry, enqueueing files with their path.
function walkEntry(entry, prefix) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        enqueue(file, prefix + entry.name);
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => {
        reader.readEntries((batch) => {
          if (!batch.length) {
            Promise.all(all.map((e) => walkEntry(e, prefix + entry.name + "/")))
              .then(resolve);
            return;
          }
          all.push(...batch);
          readBatch(); // directories may return entries in multiple batches
        }, () => resolve());
      };
      readBatch();
    } else {
      resolve();
    }
  });
}

let dragDepth = 0;
function showOverlay(show) {
  dropOverlay.hidden = !show;
  dropzone.classList.toggle("dragging", show);
}

window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  showOverlay(true);
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; showOverlay(false); }
});
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  showOverlay(false);
  const dt = e.dataTransfer;
  if (!dt) return;
  if (isInternalDrag(e)) return; // an internal move handled by a drop target

  // Prefer the entry API so dropped folders are walked recursively.
  const items = dt.items ? [...dt.items] : [];
  const entries = items
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length) {
    for (const entry of entries) await walkEntry(entry, "");
  } else if (dt.files && dt.files.length) {
    for (const f of dt.files) enqueue(f, f.name);
  }
});

// Upload button / file picker
$("uploadBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => {
  for (const f of e.target.files) enqueue(f, f.name);
  e.target.value = "";
};
$("newFolderBtn").onclick = makeFolder;

// --------------------------------------------------------------------------- //
load("");
