/* ============================================================
   DAILY PLAN — app.js
   ============================================================

   SETUP REQUIRED
   ──────────────
   1. Go to https://console.cloud.google.com/
   2. Create a project → Enable "Google Calendar API" and "Tasks API"
   3. Create OAuth 2.0 credentials (Web application)
   4. Add your site URL (or http://localhost:PORT) to
      "Authorised JavaScript origins"
   5. Paste the Client ID below.

   ============================================================ */
const GOOGLE_CLIENT_ID = '340344849497-e65cr52t2udplgbe4mdc78r92vk1iopq.apps.googleusercontent.com';

/* ============================================================
   CONFIG
   ============================================================ */
const CFG = {
  calendarId:      'primary',
  timelineStart:   8,      // 08:00
  timelineEnd:     22,     // 22:00
  slotHeightPx:    54,     // px per 30-min slot  (matches --slot-h in CSS)
  pxPerMinute:     54 / 30,
  maxTasks:        6,
};

const TASKS_WORK_LIST_NAME = 'DailyPlan Work';
const TASKS_LIFE_LIST_NAME = 'DailyPlan Life';

/* ============================================================
   STATE
   ============================================================ */
let currentDate     = new Date();
let gapiReady       = false;
let gisReady        = false;
let tokenClient     = null;
let isSignedIn      = false;
let calEvents       = [];        // Google Calendar events for the day
let localEvents     = [];        // local-only events (no Google auth)
let dragState       = null;      // active drag context
let workTaskListId  = null;      // Google Tasks list ID for Work tasks
let lifeTaskListId  = null;      // Google Tasks list ID for Life tasks
const _syncTimers   = {};        // debounce timers for Google Tasks sync

/* ============================================================
   UTILITY
   ============================================================ */
const $ = id => document.getElementById(id);

function dateKey(d) {
  // "YYYY-MM-DD" for localStorage keys
  return d.toISOString().slice(0, 10);
}

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function isToday(d) {
  const t = new Date();
  return d.getFullYear() === t.getFullYear() &&
         d.getMonth()    === t.getMonth()    &&
         d.getDate()     === t.getDate();
}

function clampDate(d) {
  // No clamping—users should navigate freely
  return d;
}

/** "HH:MM" → total minutes since midnight */
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** total minutes since midnight → "HH:MM" */
function minutesToTime(m) {
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** ISO string → "HH:MM" in local time */
function isoToLocalTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** "YYYY-MM-DD" + "HH:MM" → ISO string */
function buildISO(dateStr, timeStr) {
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

/** pixel offset from top of timeline → clamped minutes-from-midnight */
function pxToMinutes(px) {
  const minutesFromStart = px / CFG.pxPerMinute;
  const raw = CFG.timelineStart * 60 + minutesFromStart;
  // round to nearest 30 min
  const rounded = Math.round(raw / 30) * 30;
  return Math.max(CFG.timelineStart * 60, Math.min(CFG.timelineEnd * 60, rounded));
}

function minutesToPx(totalMin) {
  return (totalMin - CFG.timelineStart * 60) * CFG.pxPerMinute;
}

function randomId() {
  return 'local_' + Math.random().toString(36).slice(2, 10);
}

/* ============================================================
   TASK STORAGE — LOCAL STORAGE (fallback / cache)
   ============================================================ */
function loadTasksFromLocalStorage(type, dateStr) {
  const key = `dailyplan_${type}_${dateStr}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return Array.from({ length: CFG.maxTasks }, () => ({ text: '', done: false, scheduled: false, googleId: null }));
}

/* ============================================================
   TASK STORAGE — GOOGLE TASKS API
   ============================================================ */

/** Find or create the two DailyPlan task lists after sign-in */
async function ensureTaskLists() {
  try {
    const resp = await gapi.client.tasks.tasklists.list({ maxResults: 100 });
    const lists = resp.result.items || [];

    const workList = lists.find(l => l.title === TASKS_WORK_LIST_NAME);
    const lifeList = lists.find(l => l.title === TASKS_LIFE_LIST_NAME);

    if (workList) {
      workTaskListId = workList.id;
    } else {
      const r = await gapi.client.tasks.tasklists.insert({ resource: { title: TASKS_WORK_LIST_NAME } });
      workTaskListId = r.result.id;
    }

    if (lifeList) {
      lifeTaskListId = lifeList.id;
    } else {
      const r = await gapi.client.tasks.tasklists.insert({ resource: { title: TASKS_LIFE_LIST_NAME } });
      lifeTaskListId = r.result.id;
    }
  } catch (err) {
    console.error('Error setting up task lists:', err);
  }
}

/** Fetch tasks for a specific date from Google Tasks */
async function loadTasksFromGoogle(type, dateStr) {
  const listId = type === 'work' ? workTaskListId : lifeTaskListId;
  if (!listId) return loadTasksFromLocalStorage(type, dateStr);

  // Build date range: tasks due on dateStr (UTC date boundaries)
  const dueMin = `${dateStr}T00:00:00.000Z`;
  const nextDay = new Date(`${dateStr}T00:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dueMax = nextDay.toISOString().replace(/\.\d{3}Z$/, '.000Z');

  try {
    const resp = await gapi.client.tasks.tasks.list({
      tasklist:      listId,
      dueMin,
      dueMax,
      showCompleted: true,
      showHidden:    true,
      maxResults:    20,
    });

    const googleTasks = (resp.result.items || []).sort((a, b) =>
      (a.position || '').localeCompare(b.position || '')
    );

    // Build 6-slot array; tasks store their slot index in the notes field
    const slots = Array.from({ length: CFG.maxTasks }, () => ({
      text: '', done: false, scheduled: false, googleId: null,
    }));

    for (const gt of googleTasks) {
      let slotIdx = -1;
      let scheduled = false;
      try {
        const meta = JSON.parse(gt.notes || '{}');
        if (typeof meta.slot === 'number' && meta.slot >= 0 && meta.slot < CFG.maxTasks) {
          slotIdx = meta.slot;
        }
        scheduled = !!meta.scheduled;
      } catch (_) {}

      // Fallback: find first empty slot
      if (slotIdx < 0 || slots[slotIdx].googleId !== null) {
        slotIdx = slots.findIndex(s => s.googleId === null && s.text === '');
      }
      if (slotIdx < 0) break; // all slots filled

      slots[slotIdx] = {
        text:      gt.title || '',
        done:      gt.status === 'completed',
        scheduled,
        googleId:  gt.id,
      };
    }

    // Cache locally so offline / sign-out still shows last known state
    localStorage.setItem(`dailyplan_${type}_${dateStr}`, JSON.stringify(slots));

    return slots;
  } catch (err) {
    console.error('Error loading tasks from Google Tasks:', err);
    return loadTasksFromLocalStorage(type, dateStr);
  }
}

/** Sync a tasks array to Google Tasks (called debounced from saveTasks) */
async function syncTasksToGoogle(type, tasks, dateStr) {
  const listId = type === 'work' ? workTaskListId : lifeTaskListId;
  if (!listId) return;

  const due = `${dateStr}T00:00:00.000Z`;

  for (let i = 0; i < tasks.length; i++) {
    const task  = tasks[i];
    const notes = JSON.stringify({ scheduled: task.scheduled, slot: i });

    try {
      if (task.text && task.googleId) {
        // Update existing task
        await gapi.client.tasks.tasks.patch({
          tasklist: listId,
          task:     task.googleId,
          resource: {
            title:  task.text,
            status: task.done ? 'completed' : 'needsAction',
            due,
            notes,
          },
        });
      } else if (task.text && !task.googleId) {
        // Create new task
        const resp = await gapi.client.tasks.tasks.insert({
          tasklist: listId,
          resource: {
            title:  task.text,
            status: task.done ? 'completed' : 'needsAction',
            due,
            notes,
          },
        });
        task.googleId = resp.result.id;
        // Update cache with new googleId
        localStorage.setItem(`dailyplan_${type}_${dateStr}`, JSON.stringify(tasks));
      } else if (!task.text && task.googleId) {
        // Task was cleared — delete from Google Tasks
        await gapi.client.tasks.tasks.delete({ tasklist: listId, task: task.googleId });
        task.googleId = null;
        localStorage.setItem(`dailyplan_${type}_${dateStr}`, JSON.stringify(tasks));
      }
    } catch (err) {
      console.error(`Error syncing task slot ${i} (${type}):`, err);
    }
  }
}

/* ============================================================
   TASK STORAGE — UNIFIED API
   ============================================================ */
async function loadTasks(type) {
  const dateStr = dateKey(currentDate);
  if (isSignedIn && workTaskListId && lifeTaskListId) {
    return await loadTasksFromGoogle(type, dateStr);
  }
  return loadTasksFromLocalStorage(type, dateStr);
}

async function saveTasks(type, tasks) {
  const dateStr = dateKey(currentDate);
  // Always write to localStorage immediately (snappy UI, offline cache)
  localStorage.setItem(`dailyplan_${type}_${dateStr}`, JSON.stringify(tasks));

  if (!isSignedIn) return;

  // Debounce Google Tasks sync so rapid keystrokes don't flood the API
  clearTimeout(_syncTimers[type]);
  _syncTimers[type] = setTimeout(() => syncTasksToGoogle(type, tasks, dateStr), 800);
}

/* ============================================================
   LOCAL STORAGE — LOCAL EVENTS
   ============================================================ */
function loadLocalEvents() {
  const key = `dailyplan_events_${dateKey(currentDate)}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return [];
}

function saveLocalEvents() {
  const key = `dailyplan_events_${dateKey(currentDate)}`;
  localStorage.setItem(key, JSON.stringify(localEvents));
}

/* ============================================================
   HEADER / DATE DISPLAY
   ============================================================ */
function updateHeader() {
  $('date-title').textContent = fmtDate(currentDate);

  // Mark the correct weekday letter (Mon = index 0)
  const dow = (currentDate.getDay() + 6) % 7; // 0=Mon … 6=Sun
  document.querySelectorAll('.day-letter').forEach((el, i) => {
    el.classList.toggle('active', i === dow);
  });
}

/* ============================================================
   TIMELINE — BUILD SLOTS
   ============================================================ */
function buildTimeline() {
  const slots = $('slots-layer');
  slots.innerHTML = '';

  const totalSlots = (CFG.timelineEnd - CFG.timelineStart) * 2; // 2 per hour
  for (let i = 0; i < totalSlots; i++) {
    const totalMin = CFG.timelineStart * 60 + i * 30;
    const timeStr  = minutesToTime(totalMin);
    const isHour   = totalMin % 60 === 0;

    const row = document.createElement('div');
    row.className = `slot-row ${isHour ? 'hour-slot' : 'half-slot'}`;
    row.dataset.time = timeStr;
    row.style.height = CFG.slotHeightPx + 'px';

    const label = document.createElement('div');
    label.className = 'slot-time';
    label.textContent = isHour ? timeStr : timeStr;

    const content = document.createElement('div');
    content.className = 'slot-content';

    row.appendChild(label);
    row.appendChild(content);
    slots.appendChild(row);

    // Drop target for dragging
    row.addEventListener('dragover', onSlotDragOver);
    row.addEventListener('dragleave', onSlotDragLeave);
    row.addEventListener('drop', onSlotDrop);
    row.addEventListener('click', onSlotClick);
  }

  // Set timeline total height
  $('timeline').style.height = (totalSlots * CFG.slotHeightPx) + 'px';
}

/* ============================================================
   TIMELINE — RENDER EVENTS
   ============================================================ */
function renderEvents() {
  const layer = $('events-layer');
  layer.innerHTML = '';

  const allEvents = [
    ...calEvents.map(e => ({
      id:        e.id,
      title:     e.summary || '(no title)',
      start:     isoToLocalTime(e.start.dateTime || e.start.date),
      end:       isoToLocalTime(e.end.dateTime   || e.end.date),
      color:     'google',
      source:    'google',
      raw:       e,
    })),
    ...localEvents.map(e => ({
      id:     e.id,
      title:  e.title,
      start:  e.start,
      end:    e.end,
      color:  e.color || 'blue',
      source: 'local',
    })),
  ];

  // Group overlapping events into columns
  const positioned = resolveOverlaps(allEvents);

  for (const { ev, col, colCount } of positioned) {
    const startMin = timeToMinutes(ev.start);
    const endMin   = timeToMinutes(ev.end);
    const top      = minutesToPx(startMin);
    const height   = Math.max((endMin - startMin) * CFG.pxPerMinute, 20);

    if (startMin < CFG.timelineStart * 60 || startMin >= CFG.timelineEnd * 60) continue;

    const card = document.createElement('div');
    card.className = `event-card event-${ev.color}`;
    card.dataset.id     = ev.id;
    card.dataset.source = ev.source;
    card.draggable = true;

    // Column layout for overlapping events
    const colW = `calc((100% - 8px) / ${colCount})`;
    card.style.cssText = `
      top: ${top}px;
      height: ${height}px;
      left: calc(4px + (100% - 8px) / ${colCount} * ${col});
      width: ${colW};
      right: auto;
    `;

    const titleEl = document.createElement('div');
    titleEl.className = 'event-title';
    titleEl.textContent = ev.title;

    const timeEl = document.createElement('div');
    timeEl.className = 'event-time';
    timeEl.textContent = `${ev.start} – ${ev.end}`;

    card.appendChild(titleEl);
    if (height > 30) card.appendChild(timeEl);

    card.addEventListener('click', e => { e.stopPropagation(); openEditModal(ev); });
    card.addEventListener('dragstart', e => onEventDragStart(e, ev));
    card.addEventListener('dragend', onEventDragEnd);

    layer.appendChild(card);
  }
}

/** Simple overlap resolver: returns each event with a column index */
function resolveOverlaps(events) {
  // Sort by start time
  const sorted = [...events].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  const result = [];
  const columns = []; // each entry is the end-time of the last event in that column

  for (const ev of sorted) {
    const start = timeToMinutes(ev.start);
    const end   = timeToMinutes(ev.end);
    let placed  = false;
    for (let c = 0; c < columns.length; c++) {
      if (columns[c] <= start) {
        columns[c] = end;
        result.push({ ev, col: c });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push(end);
      result.push({ ev, col: columns.length - 1 });
    }
  }

  // Determine total column count for each event's time range
  for (const item of result) {
    const start = timeToMinutes(item.ev.start);
    const end   = timeToMinutes(item.ev.end);
    let maxCol = item.col;
    for (const other of result) {
      const os = timeToMinutes(other.ev.start);
      const oe = timeToMinutes(other.ev.end);
      if (os < end && oe > start) maxCol = Math.max(maxCol, other.col);
    }
    item.colCount = maxCol + 1;
  }

  return result;
}

/* ============================================================
   TASK LIST — RENDER
   ============================================================ */
async function renderTasks(type) {
  const el   = $(`${type}-tasks`);
  const data = await loadTasks(type);
  el.innerHTML = '';

  data.forEach((task, i) => {
    const li = document.createElement('li');
    li.className = `task-item${task.done ? ' done' : ''}${task.scheduled ? ' scheduled' : ''}`;
    li.draggable = true;
    li.dataset.type  = type;
    li.dataset.index = i;

    const handle = document.createElement('span');
    handle.className = 'task-drag-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'Drag to timeline to schedule';

    const num = document.createElement('span');
    num.className = 'task-num';
    num.textContent = i + 1;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-input';
    input.value = task.text;
    input.placeholder = `Task ${i + 1}…`;
    input.addEventListener('input', () => {
      data[i].text = input.value;
      saveTasks(type, data);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        // Move focus to next task
        const next = el.querySelectorAll('.task-input')[i + 1];
        if (next) next.focus();
      }
    });

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'task-check';
    check.checked = task.done;
    check.addEventListener('change', () => {
      data[i].done = check.checked;
      li.classList.toggle('done', check.checked);
      saveTasks(type, data);
    });

    li.appendChild(handle);
    li.appendChild(num);
    li.appendChild(input);
    li.appendChild(check);

    li.addEventListener('dragstart', e => onTaskDragStart(e, type, i, task.text));
    li.addEventListener('dragend',   () => li.classList.remove('dragging'));

    el.appendChild(li);
  });
}

/* ============================================================
   DRAG — FROM TASK LIST TO TIMELINE
   ============================================================ */
function onTaskDragStart(e, type, index, text) {
  dragState = { kind: 'task', type, index, text };
  e.dataTransfer.effectAllowed = 'copy';
  e.dataTransfer.setData('text/plain', text);
  e.currentTarget.classList.add('dragging');
}

/* ============================================================
   DRAG — EXISTING EVENT ON TIMELINE
   ============================================================ */
function onEventDragStart(e, ev) {
  dragState = { kind: 'event', ev };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', ev.id);
  const card = document.querySelector(`.event-card[data-id="${ev.id}"]`);
  if (card) card.classList.add('dragging');
}

function onEventDragEnd() {
  document.querySelectorAll('.event-card.dragging').forEach(c => c.classList.remove('dragging'));
  dragState = null;
  document.querySelectorAll('.slot-row.drag-over').forEach(s => s.classList.remove('drag-over'));
  $('drag-indicator').classList.add('hidden');
}

/* ============================================================
   DRAG — SLOT HANDLERS
   ============================================================ */
function onSlotDragOver(e) {
  if (!dragState) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = dragState.kind === 'task' ? 'copy' : 'move';

  document.querySelectorAll('.slot-row.drag-over').forEach(s => s.classList.remove('drag-over'));
  e.currentTarget.classList.add('drag-over');

  // Show indicator line
  const row   = e.currentTarget;
  const top   = row.offsetTop;
  const ind   = $('drag-indicator');
  ind.style.top = top + 'px';
  ind.classList.remove('hidden');
}

function onSlotDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onSlotDrop(e) {
  e.preventDefault();
  document.querySelectorAll('.slot-row.drag-over').forEach(s => s.classList.remove('drag-over'));
  $('drag-indicator').classList.add('hidden');

  const slot  = e.currentTarget;
  const sTime = slot.dataset.time; // "HH:MM"

  if (!dragState) return;

  if (dragState.kind === 'task') {
    // Open modal pre-filled with task name & start time
    const endMin = timeToMinutes(sTime) + 60;
    openAddModal(dragState.text, sTime, minutesToTime(Math.min(endMin, CFG.timelineEnd * 60)));
    // We'll mark the task as scheduled after modal save
    dragState.pendingTask = { type: dragState.type, index: dragState.index };
  } else if (dragState.kind === 'event') {
    // Move the event to the new slot
    const ev       = dragState.ev;
    const duration = timeToMinutes(ev.end) - timeToMinutes(ev.start);
    const newStart = timeToMinutes(sTime);
    const newEnd   = newStart + duration;
    const newStartStr = minutesToTime(Math.min(newStart, CFG.timelineEnd * 60 - 30));
    const newEndStr   = minutesToTime(Math.min(newEnd,   CFG.timelineEnd * 60));
    await moveEvent(ev, newStartStr, newEndStr);
  }

  dragState = null;
}

/* ============================================================
   SLOT / EMPTY AREA CLICK — ADD EVENT
   ============================================================ */
function onSlotClick(e) {
  if (e.target.closest('.event-card')) return; // handled by card
  const sTime  = e.currentTarget.dataset.time;
  const endMin = timeToMinutes(sTime) + 60;
  openAddModal('', sTime, minutesToTime(Math.min(endMin, CFG.timelineEnd * 60)));
}

/* ============================================================
   MODAL — ADD
   ============================================================ */
let modalMode       = 'add';  // 'add' | 'edit'
let modalEditTarget = null;
let selectedColor   = 'blue';
let pendingTaskRef  = null;

function openAddModal(title, start, end) {
  modalMode = 'add';
  modalEditTarget = null;
  pendingTaskRef = dragState?.pendingTask || null;

  $('modal-heading').textContent = 'Add Event';
  $('modal-title-input').value   = title;
  $('modal-start').value         = start;
  $('modal-end').value           = end;
  $('modal-delete').classList.add('hidden');
  setModalColor('blue');

  $('modal-overlay').classList.remove('hidden');
  $('modal-title-input').focus();
}

function openEditModal(ev) {
  modalMode       = 'edit';
  modalEditTarget = ev;

  $('modal-heading').textContent = 'Edit Event';
  $('modal-title-input').value   = ev.title;
  $('modal-start').value         = ev.start;
  $('modal-end').value           = ev.end;
  $('modal-delete').classList.remove('hidden');
  setModalColor(ev.color === 'google' ? 'blue' : ev.color);

  $('modal-overlay').classList.remove('hidden');
  $('modal-title-input').focus();
}

function closeModal() {
  $('modal-overlay').classList.add('hidden');
  pendingTaskRef = null;
}

function setModalColor(color) {
  selectedColor = color;
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === color);
  });
}

async function saveModalEvent() {
  const title = $('modal-title-input').value.trim() || 'New Event';
  const start = $('modal-start').value;
  const end   = $('modal-end').value;

  if (!start || !end) { alert('Please set start and end times.'); return; }
  if (timeToMinutes(start) >= timeToMinutes(end)) {
    alert('End time must be after start time.'); return;
  }

  if (modalMode === 'add') {
    await createEvent(title, start, end, selectedColor);
    if (pendingTaskRef) {
      // Mark that task as scheduled
      const tasks = await loadTasks(pendingTaskRef.type);
      tasks[pendingTaskRef.index].scheduled = true;
      await saveTasks(pendingTaskRef.type, tasks);
      await renderTasks(pendingTaskRef.type);
      pendingTaskRef = null;
    }
  } else if (modalMode === 'edit' && modalEditTarget) {
    await updateEvent(modalEditTarget, title, start, end, selectedColor);
  }

  closeModal();
  renderEvents();
}

async function deleteModalEvent() {
  if (!modalEditTarget) return;
  await deleteEvent(modalEditTarget);
  closeModal();
  renderEvents();
}

/* ============================================================
   EVENT CRUD — LOCAL + GOOGLE
   ============================================================ */
async function createEvent(title, start, end, color) {
  if (isSignedIn) {
    await createGoogleEvent(title, start, end);
    await refreshCalendarEvents();
  } else {
    localEvents.push({ id: randomId(), title, start, end, color });
    saveLocalEvents();
  }
}

async function updateEvent(ev, title, start, end, color) {
  if (ev.source === 'google' && isSignedIn) {
    await updateGoogleEvent(ev.id, title, start, end);
    await refreshCalendarEvents();
  } else {
    const idx = localEvents.findIndex(e => e.id === ev.id);
    if (idx >= 0) {
      localEvents[idx] = { ...localEvents[idx], title, start, end, color };
      saveLocalEvents();
    }
  }
}

async function moveEvent(ev, start, end) {
  if (ev.source === 'google' && isSignedIn) {
    await updateGoogleEvent(ev.id, ev.title, start, end);
    await refreshCalendarEvents();
  } else {
    const idx = localEvents.findIndex(e => e.id === ev.id);
    if (idx >= 0) {
      localEvents[idx] = { ...localEvents[idx], start, end };
      saveLocalEvents();
    }
  }
  renderEvents();
}

async function deleteEvent(ev) {
  if (ev.source === 'google' && isSignedIn) {
    await deleteGoogleEvent(ev.id);
    await refreshCalendarEvents();
  } else {
    localEvents = localEvents.filter(e => e.id !== ev.id);
    saveLocalEvents();
  }
}

/* ============================================================
   GOOGLE CALENDAR API CALLS
   ============================================================ */
async function refreshCalendarEvents() {
  if (!isSignedIn || !gapiReady) return;
  const dStr  = dateKey(currentDate);
  const start = new Date(`${dStr}T00:00:00`);
  const end   = new Date(`${dStr}T23:59:59`);

  try {
    const resp = await gapi.client.calendar.events.list({
      calendarId:   CFG.calendarId,
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      maxResults:   50,
    });
    calEvents = (resp.result.items || []).filter(e => e.start.dateTime); // skip all-day
  } catch (err) {
    console.error('Calendar fetch error', err);
    calEvents = [];
  }
}

async function createGoogleEvent(title, start, end) {
  const dStr = dateKey(currentDate);
  try {
    await gapi.client.calendar.events.insert({
      calendarId: CFG.calendarId,
      resource: {
        summary: title,
        start: { dateTime: buildISO(dStr, start), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end:   { dateTime: buildISO(dStr, end),   timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      },
    });
  } catch (err) { console.error('Create event error', err); }
}

async function updateGoogleEvent(id, title, start, end) {
  const dStr = dateKey(currentDate);
  const tz   = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    await gapi.client.calendar.events.patch({
      calendarId: CFG.calendarId,
      eventId:    id,
      resource: {
        summary: title,
        start: { dateTime: buildISO(dStr, start), timeZone: tz },
        end:   { dateTime: buildISO(dStr, end),   timeZone: tz },
      },
    });
  } catch (err) { console.error('Update event error', err); }
}

async function deleteGoogleEvent(id) {
  try {
    await gapi.client.calendar.events.delete({ calendarId: CFG.calendarId, eventId: id });
  } catch (err) { console.error('Delete event error', err); }
}

/* ============================================================
   GOOGLE AUTH
   ============================================================ */
function onGapiLoad() {
  gapi.load('client', async () => {
    try {
      await gapi.client.init({});
      await Promise.all([
        gapi.client.load('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'),
        gapi.client.load('https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest'),
      ]);
    } catch (err) {
      console.warn('GAPI init warning:', err);
    }
    gapiReady = true;
    maybeInitAuth();
  });
}

function onGisLoad() {
  if (GOOGLE_CLIENT_ID === 'YOUR_CLIENT_ID.apps.googleusercontent.com') {
    $('setup-banner').classList.remove('hidden');
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope:     'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks',
    callback:  async (resp) => {
      if (resp.error) { console.error('Auth error', resp); return; }
      gapi.client.setToken(resp);
      isSignedIn = true;
      updateAuthBtn();
      await ensureTaskLists();
      await refreshCalendarEvents();
      await renderTasks('work');
      await renderTasks('life');
      renderEvents();
    },
  });
  gisReady = true;
  maybeInitAuth();
}

function maybeInitAuth() {
  if (!gapiReady || !gisReady) return;
  $('btn-auth').disabled = false;
}

function updateAuthBtn() {
  const btn = $('btn-auth');
  if (isSignedIn) {
    btn.classList.add('connected');
    $('auth-label').textContent = 'Calendar Connected';
    $('auth-icon').textContent  = '✓';
  } else {
    btn.classList.remove('connected');
    $('auth-label').textContent = 'Connect Calendar';
    $('auth-icon').textContent  = '📅';
  }
}

async function handleAuthClick() {
  if (!tokenClient) {
    alert('Google API not ready yet. Please wait a moment and try again.');
    return;
  }
  if (isSignedIn) {
    // Sign out
    gapi.client.setToken(null);
    isSignedIn     = false;
    calEvents      = [];
    workTaskListId = null;
    lifeTaskListId = null;
    updateAuthBtn();
    renderEvents();
    await renderTasks('work');
    await renderTasks('life');
  } else {
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

/* ============================================================
   DATE NAVIGATION
   ============================================================ */
function navigateDay(delta) {
  const d = new Date(currentDate);
  d.setDate(d.getDate() + delta);
  currentDate = d;
  loadDay();
}

async function loadDay() {
  updateHeader();
  buildTimeline();
  localEvents = loadLocalEvents();
  if (isSignedIn) {
    await refreshCalendarEvents();
  }
  await renderTasks('work');
  await renderTasks('life');
  renderEvents();
  scrollToWorkHours();
}

function scrollToWorkHours() {
  // Scroll to 08:00 (start of timeline) with a small offset
  const scroll = $('timeline-scroll');
  scroll.scrollTop = 0;
}

/* ============================================================
   WIRE UP GOOGLE CALLBACK HOOKS
   (called by async script tags in index.html)
   ============================================================ */
window.gapiLoaded = onGapiLoad;  // not used directly; gapi calls onGapiLoad via load callback
window.onGisLoad  = onGisLoad;

// Poll for gapi / gis readiness (they load async)
function pollForLibs() {
  if (typeof gapi !== 'undefined') onGapiLoad();
  else setTimeout(pollForLibs, 100);
}

function pollForGis() {
  if (typeof google !== 'undefined' && google.accounts) onGisLoad();
  else setTimeout(pollForGis, 100);
}

/* ============================================================
   INIT
   ============================================================ */
function init() {
  // Header buttons
  $('btn-prev').addEventListener('click', () => navigateDay(-1));
  $('btn-next').addEventListener('click', () => navigateDay(+1));
  $('btn-auth').addEventListener('click', handleAuthClick);
  $('btn-auth').disabled = true;

  // Day-of-week letters jump to nearest matching weekday
  document.querySelectorAll('.day-letter').forEach((el, i) => {
    el.addEventListener('click', () => {
      const targetDow = (i + 1) % 7; // Mon=1..Sun=0 (getDay())
      const currDow   = currentDate.getDay();
      let delta = targetDow - currDow;
      // Jump to nearest (within -3..+3)
      if (delta > 3)  delta -= 7;
      if (delta < -3) delta += 7;
      navigateDay(delta);
    });
  });

  // Modal
  $('modal-save').addEventListener('click', saveModalEvent);
  $('modal-delete').addEventListener('click', deleteModalEvent);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-overlay').addEventListener('click', e => {
    if (e.target === $('modal-overlay')) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && !$('modal-overlay').classList.contains('hidden')) {
      if (document.activeElement?.tagName !== 'BUTTON') saveModalEvent();
    }
  });

  // Color swatches
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.addEventListener('click', () => setModalColor(s.dataset.color));
  });

  // Initial day load
  loadDay();

  // Start polling for async libs
  pollForLibs();
  pollForGis();
}

document.addEventListener('DOMContentLoaded', init);
