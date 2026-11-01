function maxAt(...values) {
  return values.reduce((latest, value) => ((value || "") > latest ? value : latest), "");
}

function mergeRecords(left, right, leftAt, rightAt, tombstones) {
  const primary = (rightAt || "") >= (leftAt || "") ? right : left;
  const secondary = primary === right ? left : right;
  const byId = new Map();

  for (const record of [...left, ...right]) {
    if (!record?.id) continue;
    const previous = byId.get(record.id);
    if (!previous || (record.updatedAt || "") >= (previous.updatedAt || "")) {
      byId.set(record.id, structuredClone(record));
    }
  }

  const seen = new Set();
  const merged = [];
  for (const record of [...primary, ...secondary]) {
    if (!record?.id || seen.has(record.id)) continue;
    seen.add(record.id);
    const item = byId.get(record.id);
    if (!item) continue;
    if ((tombstones.get(item.id) || "") >= (item.updatedAt || "")) continue;
    merged.push(item);
  }
  return merged;
}

function mergeDay(left, right, tombstones) {
  const primary = (right.updatedAt || "") >= (left.updatedAt || "") ? right : left;
  return {
    id: left.id || right.id,
    date: left.date || right.date,
    title: primary.title ?? left.title ?? right.title ?? "",
    memo: primary.memo ?? "",
    updatedAt: maxAt(left.updatedAt, right.updatedAt),
    items: mergeRecords(left.items || [], right.items || [], left.updatedAt || "", right.updatedAt || "", tombstones),
  };
}

export function mergeDocs(serverDoc, clientDoc) {
  if (!clientDoc || !Array.isArray(clientDoc.days)) return serverDoc;
  if (!serverDoc || !Array.isArray(serverDoc.days)) return clientDoc;

  const tombstones = new Map();
  for (const entry of [...(serverDoc.tombstones || []), ...(clientDoc.tombstones || [])]) {
    if (!entry?.id) continue;
    if ((entry.at || "") >= (tombstones.get(entry.id) || "")) tombstones.set(entry.id, entry.at || "");
  }

  const dayOrder = (clientDoc.updatedAt || "") >= (serverDoc.updatedAt || "")
    ? [...clientDoc.days, ...serverDoc.days]
    : [...serverDoc.days, ...clientDoc.days];
  const days = new Map();
  for (const day of [...serverDoc.days, ...clientDoc.days]) {
    if (!day?.id) continue;
    const previous = days.get(day.id);
    days.set(day.id, previous ? mergeDay(previous, day, tombstones) : mergeDay(day, day, tombstones));
  }

  const seen = new Set();
  const orderedDays = [];
  for (const day of dayOrder) {
    if (!day?.id || seen.has(day.id)) continue;
    seen.add(day.id);
    const merged = days.get(day.id);
    if (!merged) continue;
    if ((tombstones.get(day.id) || "") >= (merged.updatedAt || "")) continue;
    orderedDays.push(merged);
  }
  orderedDays.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const useClientNotes = (clientDoc.notesUpdatedAt || "") >= (serverDoc.notesUpdatedAt || "");
  const useClientTitle = (clientDoc.updatedAt || "") >= (serverDoc.updatedAt || "");

  return {
    title: (useClientTitle ? clientDoc.title : serverDoc.title) || "굿바이대치",
    people: clientDoc.people || serverDoc.people || 2,
    notes: useClientNotes ? (clientDoc.notes ?? "") : (serverDoc.notes ?? ""),
    notesUpdatedAt: maxAt(serverDoc.notesUpdatedAt, clientDoc.notesUpdatedAt),
    flights: mergeRecords(serverDoc.flights || [], clientDoc.flights || [], serverDoc.updatedAt || "", clientDoc.updatedAt || "", tombstones),
    stays: mergeRecords(serverDoc.stays || [], clientDoc.stays || [], serverDoc.updatedAt || "", clientDoc.updatedAt || "", tombstones),
    days: orderedDays,
    tombstones: [...tombstones.entries()].map(([id, at]) => ({ id, at })).slice(-500),
    updatedAt: new Date().toISOString(),
  };
}
