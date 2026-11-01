const LOCAL_KEY = "gbdc-doc";
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];

const gate = document.querySelector("#gate");
const gateForm = document.querySelector("#gate-form");
const gateTitle = document.querySelector("#gate-title");
const gateHelp = document.querySelector("#gate-help");
const gatePassword = document.querySelector("#gate-password");
const gateSubmit = document.querySelector("#gate-submit");
const gateError = document.querySelector("#gate-error");
const app = document.querySelector("#app");
const range = document.querySelector("#range");
const sync = document.querySelector("#sync");
const syncText = document.querySelector("#sync-text");
const daysEl = document.querySelector("#days");
const main = document.querySelector("#main");
const bottom = document.querySelector("#bottom");
const editor = document.querySelector("#editor");
const editorForm = document.querySelector("#editor-form");
const tabPlan = document.querySelector("#tab-plan");
const tabInfo = document.querySelector("#tab-info");

let doc = null;
let tab = "plan";
let selectedDayId = location.hash.slice(1);
let editing = null;
let dirty = false;
let saving = false;
let saveAgain = false;
let saveTimer = 0;
let events = null;
let online = navigator.onLine;
let needsSetup = false;

function nowIso() {
  return new Date().toISOString();
}

function dayLabel(date) {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return `${month}월 ${day}일 ${WEEK[utc.getUTCDay()]}`;
}

function setSync(state, text) {
  sync.dataset.state = state;
  syncText.textContent = text;
}

function showError(message) {
  gateError.hidden = !message;
  gateError.textContent = message || "";
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || "요청 실패");
    error.status = response.status;
    throw error;
  }
  return body;
}

async function waitForServer() {
  gate.hidden = false;
  gateHelp.textContent = "서버에 연결하는 중입니다. 잠시 꺼져 있었다면 깨우는 데 1분 정도 걸립니다.";
  gateSubmit.disabled = true;
  const started = Date.now();
  while (Date.now() - started < 90000) {
    try {
      return await request("/api/status");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return null;
}

function readLocal() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || "null");
  } catch {
    return null;
  }
}

function writeLocal() {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(doc));
}

function currentDay() {
  return doc?.days.find((day) => day.id === selectedDayId) || doc?.days[0] || null;
}

function ensureSelection() {
  if (!doc.days.some((day) => day.id === selectedDayId)) selectedDayId = doc.days[0]?.id || "";
}

function touchDoc() {
  const stamp = nowIso();
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  return stamp;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setSync(online ? "save" : "off", online ? "저장 중" : "이 기기에 저장");
  saveTimer = setTimeout(saveNow, 350);
}

async function saveNow() {
  if (!online) {
    setSync("off", "이 기기에 저장");
    return;
  }
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  const sentWhileDirty = dirty;
  dirty = false;
  try {
    const next = await request("/api/itinerary", {
      method: "PUT",
      body: JSON.stringify({ mode: "merge", doc }),
    });
    if (!dirty) {
      doc = next;
      writeLocal();
      render();
    }
    setSync("live", "연결됨");
  } catch (error) {
    if (sentWhileDirty) dirty = true;
    if (error.status === 401) return showGate(needsSetup);
    online = false;
    setSync("off", "이 기기에 저장");
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      saveNow();
    }
  }
}

function render() {
  if (!doc) return;
  ensureSelection();
  const first = doc.days[0]?.date;
  const last = doc.days[doc.days.length - 1]?.date;
  range.textContent = first && last ? `${first.replaceAll("-", ".")} – ${last.slice(5).replace("-", ".")}` : "";
  tabPlan.setAttribute("aria-selected", String(tab === "plan"));
  tabInfo.setAttribute("aria-selected", String(tab === "info"));
  daysEl.hidden = tab !== "plan";
  bottom.hidden = tab !== "plan";
  if (tab === "plan") renderDays();
  renderMain();
}

function renderDays() {
  daysEl.replaceChildren();
  for (const day of doc.days) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = dayLabel(day.date);
    if (day.id === selectedDayId) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => selectDay(day.id));
    daysEl.append(button);
  }
}

function renderMain() {
  main.replaceChildren();
  if (tab === "info") {
    renderInfo();
    return;
  }
  const day = currentDay();
  if (!day) {
    main.append(paragraph("날짜를 추가하면 일정이 여기에 나타납니다."));
    return;
  }
  const head = document.createElement("div");
  head.className = "dayhead";
  const titles = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = dayLabel(day.date);
  const heading = document.createElement("h2");
  heading.textContent = day.title || "제목 없음";
  titles.append(eyebrow, heading);
  const editDay = document.createElement("button");
  editDay.type = "button";
  editDay.className = "text";
  editDay.textContent = "이 날 수정";
  editDay.addEventListener("click", () => openEditor({ kind: "day", dayId: day.id }));
  head.append(titles, editDay);
  main.append(head);
  if (day.memo) {
    const memo = document.createElement("p");
    memo.className = "memo";
    memo.textContent = day.memo;
    main.append(memo);
  }
  if (!day.items.length) main.append(paragraph("아직 일정이 없습니다."));
  for (const item of day.items) main.append(itemButton(day, item));
}

function itemButton(day, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = item.status === "open" ? "item open" : "item";
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = item.time || "시각 없음";
  const body = document.createElement("div");
  const place = document.createElement("span");
  place.className = "place";
  place.textContent = item.place || "장소 없음";
  body.append(place);
  if (item.status === "open") {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "미정";
    body.append(tag);
  }
  const action = document.createElement("div");
  action.textContent = item.action || "";
  body.append(action);
  const extra = [item.transport, item.travelTime].filter(Boolean).join(" · ");
  if (extra) body.append(detail(extra));
  if (item.note) body.append(detail(item.note));
  button.append(when, body);
  button.addEventListener("click", () => openEditor({ kind: "item", dayId: day.id, itemId: item.id }));
  return button;
}

function renderInfo() {
  main.append(sectionTitle("항공"));
  for (const flight of doc.flights) main.append(recordCard(flightLabel(flight), flight.note, () => openEditor({ kind: "flight", id: flight.id })));
  const addFlight = document.createElement("button");
  addFlight.type = "button";
  addFlight.className = "ghost";
  addFlight.textContent = "항공 추가";
  addFlight.addEventListener("click", addFlightRecord);
  main.append(addFlight);

  main.append(sectionTitle("숙소"));
  for (const stay of doc.stays) main.append(recordCard(`${stay.name} · ${stay.when || ""}`, stay.note, () => openEditor({ kind: "stay", id: stay.id })));
  const addStay = document.createElement("button");
  addStay.type = "button";
  addStay.className = "ghost";
  addStay.textContent = "숙소 추가";
  addStay.addEventListener("click", addStayRecord);
  main.append(addStay);

  main.append(sectionTitle("메모"));
  const notes = document.createElement("textarea");
  notes.value = doc.notes || "";
  notes.addEventListener("input", () => {
    const stamp = nowIso();
    doc.notes = notes.value;
    doc.notesUpdatedAt = stamp;
    doc.updatedAt = stamp;
    dirty = true;
    writeLocal();
    scheduleSave();
  });
  main.append(notes);

  main.append(sectionTitle("휴대폰"));
  const lan = document.createElement("div");
  lan.id = "lan";
  lan.className = "card lan";
  lan.textContent = "주소를 불러오는 중";
  main.append(lan);
  loadLan(lan);

  const backupRow = document.createElement("div");
  backupRow.className = "row";
  const backup = document.createElement("button");
  backup.type = "button";
  backup.className = "ghost";
  backup.textContent = "백업 받기";
  backup.addEventListener("click", downloadBackup);
  const restoreLabel = document.createElement("label");
  restoreLabel.className = "ghost";
  restoreLabel.textContent = "백업 불러오기";
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "application/json";
  file.hidden = true;
  file.addEventListener("change", () => restoreBackup(file));
  restoreLabel.append(file);
  backupRow.append(backup, restoreLabel);
  main.append(sectionTitle("백업"), backupRow);

  main.append(sectionTitle("비밀번호 변경"));
  const passwordForm = document.createElement("form");
  passwordForm.className = "stack";
  const current = labeledInput("current", "현재 비밀번호", "password");
  const next = labeledInput("next", "새 비밀번호", "password");
  const change = document.createElement("button");
  change.className = "primary";
  change.type = "submit";
  change.textContent = "변경";
  const message = document.createElement("p");
  message.className = "help";
  passwordForm.append(current.label, next.label, change, message);
  passwordForm.addEventListener("submit", (event) => changePassword(event, current.input, next.input, message));
  main.append(passwordForm);
}

function flightLabel(flight) {
  return [flight.date, flight.code, flight.route, flight.time, flight.seat && `좌석 ${flight.seat}`, flight.bags].filter(Boolean).join(" · ");
}

function recordCard(title, note, onClick) {
  const card = document.createElement("article");
  card.className = "card";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "block";
  const heading = document.createElement("h2");
  heading.textContent = title;
  button.append(heading);
  if (note) button.append(detail(note));
  button.addEventListener("click", onClick);
  card.append(button);
  return card;
}

function sectionTitle(text) {
  const heading = document.createElement("h2");
  heading.className = "section-title";
  heading.textContent = text;
  return heading;
}

function paragraph(text) {
  const node = document.createElement("p");
  node.className = "muted";
  node.textContent = text;
  return node;
}

function detail(text) {
  const node = document.createElement("div");
  node.className = "detail";
  node.textContent = text;
  return node;
}

function labeledInput(name, label, type = "text") {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement(type === "area" ? "textarea" : "input");
  if (type !== "area") input.type = type === "status" ? "text" : type;
  input.name = name;
  wrap.append(input);
  return { label: wrap, input };
}

async function loadLan(node) {
  try {
    const meta = await request("/api/meta");
    node.replaceChildren();
    const lead = document.createElement("p");
    lead.textContent = meta.publicUrl
      ? "집 밖에서는 이 주소로 엽니다. 같은 와이파이에서는 아래 주소도 됩니다."
      : meta.lanUrls.length
        ? "같은 와이파이의 휴대폰 브라우저에서 이 주소를 엽니다."
        : "이 컴퓨터의 브라우저에서 http://localhost:" + meta.port + " 로 엽니다.";
    node.append(lead);
    if (meta.publicUrl) node.append(detail(meta.publicUrl));
    for (const url of meta.lanUrls) node.append(detail(url));
    node.append(detail("여행 중 이 서버에 연결되면 PC와 휴대폰 수정이 바로 맞습니다. 연결이 없으면 그 기기에 남고, 다시 연결될 때 합쳐집니다. 홈 화면에 추가하면 앱처럼 열립니다."));
  } catch {
    node.textContent = "주소는 서버에 연결된 뒤에 보입니다.";
  }
}

function selectDay(id) {
  selectedDayId = id;
  history.replaceState(null, "", `#${id}`);
  render();
  document.querySelector(".days [aria-current='true']")?.scrollIntoView({ inline: "center", block: "nearest" });
}

function findItem(dayId, itemId) {
  const day = doc.days.find((entry) => entry.id === dayId);
  return { day, item: day?.items.find((entry) => entry.id === itemId) };
}

const fields = {
  item: [["time", "시각"], ["place", "목적지"], ["action", "하는 일"], ["transport", "이동수단"], ["travelTime", "이동시간"], ["note", "비고", "area"], ["status", "상태", "status"]],
  flight: [["date", "날짜"], ["code", "편명"], ["route", "구간"], ["time", "시각"], ["seat", "좌석"], ["bags", "수하물"], ["note", "비고", "area"]],
  stay: [["name", "숙소"], ["when", "기간"], ["note", "비고", "area"]],
  day: [["title", "제목"], ["memo", "메모", "area"]],
};

function targetRecord() {
  if (!editing) return null;
  if (editing.kind === "item") return findItem(editing.dayId, editing.itemId).item;
  if (editing.kind === "day") return doc.days.find((day) => day.id === editing.dayId);
  if (editing.kind === "flight") return doc.flights.find((flight) => flight.id === editing.id);
  if (editing.kind === "stay") return doc.stays.find((stay) => stay.id === editing.id);
  return null;
}

function openEditor(next) {
  editing = next;
  const record = targetRecord();
  if (!record) return;
  document.body.classList.add("editing");
  editor.hidden = false;
  editorForm.replaceChildren();
  const head = document.createElement("div");
  head.className = "editor-head";
  const title = document.createElement("h2");
  title.id = "editor-title";
  title.textContent = editing.kind === "day" ? "이 날" : "수정";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "text";
  close.textContent = "닫기";
  close.addEventListener("click", closeEditor);
  head.append(title, close);
  editorForm.append(head);

  for (const [name, label, type] of fields[editing.kind]) {
    const wrap = document.createElement("label");
    wrap.textContent = label;
    let input;
    if (type === "status") {
      input = document.createElement("select");
      for (const [value, text] of [["confirmed", "확정"], ["open", "미정"]]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
    } else if (type === "area") {
      input = document.createElement("textarea");
    } else {
      input = document.createElement("input");
      input.type = "text";
    }
    input.name = name;
    input.value = record[name] || (name === "status" ? "confirmed" : "");
    input.addEventListener("input", () => applyField(name, input.value));
    wrap.append(input);
    editorForm.append(wrap);
  }

  const actions = document.createElement("div");
  actions.className = "row";
  if (editing.kind === "item") {
    actions.append(moveButton("위로", -1), moveButton("아래로", 1));
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "삭제";
  remove.addEventListener("click", () => removeRecord(remove));
  actions.append(remove);
  editorForm.append(actions);
  editorForm.querySelector("input, textarea, select")?.focus();
}

function applyField(name, value) {
  const record = targetRecord();
  if (!record) return;
  const stamp = nowIso();
  record[name] = value;
  record.updatedAt = stamp;
  if (editing.kind === "item") {
    const day = doc.days.find((entry) => entry.id === editing.dayId);
    if (day) day.updatedAt = stamp;
  }
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  if (tab === "plan") renderMain();
}

function moveButton(label, direction) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost";
  button.textContent = label;
  button.addEventListener("click", () => moveItem(direction));
  return button;
}

function moveItem(direction) {
  const { day, item } = findItem(editing.dayId, editing.itemId);
  if (!day || !item) return;
  const index = day.items.indexOf(item);
  const target = index + direction;
  if (target < 0 || target >= day.items.length) return;
  const [moved] = day.items.splice(index, 1);
  day.items.splice(target, 0, moved);
  const stamp = nowIso();
  day.updatedAt = stamp;
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  renderMain();
}

function removeRecord(button) {
  if (button.dataset.confirm !== "yes") {
    button.dataset.confirm = "yes";
    button.textContent = "정말 삭제";
    return;
  }
  const stamp = nowIso();
  const record = targetRecord();
  if (!record) return;
  doc.tombstones = doc.tombstones || [];
  doc.tombstones.push({ id: record.id, at: stamp });
  if (editing.kind === "item") {
    const day = doc.days.find((entry) => entry.id === editing.dayId);
    day.items = day.items.filter((item) => item.id !== record.id);
    day.updatedAt = stamp;
  } else if (editing.kind === "day") {
    doc.days = doc.days.filter((day) => day.id !== record.id);
  } else if (editing.kind === "flight") {
    doc.flights = doc.flights.filter((flight) => flight.id !== record.id);
  } else if (editing.kind === "stay") {
    doc.stays = doc.stays.filter((stay) => stay.id !== record.id);
  }
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  closeEditor();
  render();
}

function closeEditor() {
  editing = null;
  editor.hidden = true;
  document.body.classList.remove("editing");
  editorForm.replaceChildren();
}

function blank(kind) {
  const stamp = nowIso();
  const id = crypto.randomUUID();
  if (kind === "item") return { id, time: "", place: "", action: "", transport: "", travelTime: "", note: "", status: "confirmed", updatedAt: stamp };
  if (kind === "flight") return { id, date: "", code: "", route: "", time: "", seat: "", bags: "", note: "", updatedAt: stamp };
  return { id, name: "", when: "", note: "", updatedAt: stamp };
}

function addItem() {
  const day = currentDay();
  if (!day) return;
  const item = blank("item");
  const stamp = nowIso();
  item.updatedAt = stamp;
  day.items.push(item);
  day.updatedAt = stamp;
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  render();
  openEditor({ kind: "item", dayId: day.id, itemId: item.id });
}

function addDay() {
  const date = window.prompt("날짜를 YYYY-MM-DD 형식으로 입력합니다.", selectedDayId || "2026-11-28");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  if (doc.days.some((day) => day.id === date)) {
    selectDay(date);
    return;
  }
  const stamp = nowIso();
  doc.days.push({ id: date, date, title: "새 일정", memo: "", updatedAt: stamp, items: [] });
  doc.days.sort((a, b) => a.date.localeCompare(b.date));
  doc.updatedAt = stamp;
  dirty = true;
  writeLocal();
  scheduleSave();
  selectDay(date);
  openEditor({ kind: "day", dayId: date });
}

function addFlightRecord() {
  const flight = blank("flight");
  doc.flights.push(flight);
  touchDoc();
  render();
  openEditor({ kind: "flight", id: flight.id });
}

function addStayRecord() {
  const stay = blank("stay");
  doc.stays.push(stay);
  touchDoc();
  render();
  openEditor({ kind: "stay", id: stay.id });
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "gbdc-itinerary.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function restoreBackup(input) {
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const incoming = JSON.parse(await file.text());
  if (!Array.isArray(incoming.days)) return;
  doc = incoming;
  dirty = true;
  writeLocal();
  await request("/api/itinerary", { method: "PUT", body: JSON.stringify({ mode: "replace", doc }) });
  dirty = false;
  setSync("live", "연결됨");
  render();
}

async function changePassword(event, current, next, message) {
  event.preventDefault();
  message.textContent = "";
  try {
    await request("/api/password", {
      method: "POST",
      body: JSON.stringify({ current: current.value, next: next.value }),
    });
    current.value = "";
    next.value = "";
    message.textContent = "비밀번호를 바꿨습니다.";
  } catch (error) {
    message.textContent = error.message;
  }
}

function showGate(setup) {
  needsSetup = setup;
  app.hidden = true;
  gate.hidden = false;
  closeEditor();
  gateTitle.textContent = setup ? "비밀번호 정하기" : "굿바이대치";
  gateHelp.textContent = setup
    ? "PC와 휴대폰에서 같이 쓸 비밀번호입니다. 4자 이상으로 정합니다."
    : "일정은 이 비밀번호로 잠겨 있습니다.";
  gateSubmit.textContent = setup ? "시작" : "들어가기";
  gatePassword.autocomplete = setup ? "new-password" : "current-password";
  gatePassword.value = "";
  showError("");
}

async function enterApp() {
  gate.hidden = true;
  app.hidden = false;
  const local = readLocal();
  doc = await request("/api/itinerary");
  if (local?.updatedAt && doc?.updatedAt && local.updatedAt > doc.updatedAt) {
    doc = local;
    dirty = true;
    await saveNow();
  } else {
    writeLocal();
  }
  if (!selectedDayId) selectedDayId = doc.days[0]?.id || "";
  render();
  connectEvents();
  setSync("live", "연결됨");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

function connectEvents() {
  events?.close();
  events = new EventSource("/api/events");
  events.onmessage = async () => {
    if (dirty || saving) return;
    try {
      const next = await request("/api/itinerary");
      if (dirty || saving) return;
    doc = next;
    writeLocal();
    if (editing && !targetRecord()) closeEditor();
    render();
    } catch {
      setSync("off", "다시 연결 중");
    }
  };
  events.onerror = () => setSync(dirty ? "off" : "wait", dirty ? "이 기기에 저장" : "다시 연결 중");
}

gateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  try {
    await request(needsSetup ? "/api/setup" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: gatePassword.value }),
    });
    await enterApp();
  } catch (error) {
    showError(error.message);
  }
});

tabPlan.addEventListener("click", () => { tab = "plan"; render(); });
tabInfo.addEventListener("click", () => { tab = "info"; closeEditor(); render(); });
document.querySelector("#add-item").addEventListener("click", addItem);
document.querySelector("#add-day").addEventListener("click", addDay);
document.querySelector("#logout").addEventListener("click", async () => {
  await request("/api/logout", { method: "POST" });
  events?.close();
  showGate(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeEditor();
});
window.addEventListener("online", () => {
  online = true;
  if (dirty) saveNow();
  else setSync("live", "연결됨");
});
window.addEventListener("offline", () => {
  online = false;
  setSync("off", "이 기기에 저장");
});

const status = await waitForServer();
gateSubmit.disabled = false;
if (status?.authenticated) await enterApp();
else showGate(!status?.setup);
