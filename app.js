const EMPLOYEE_TOKEN_KEY = 'base-employee-token-v3';
const EMPLOYEE_ID_KEY = 'base-employee-id-v3';

const config = window.WORKTIME_CONFIG || {};
const isConfigured = Boolean(config.supabaseUrl && config.supabaseAnonKey && window.supabase);
const supabaseClient = isConfigured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

let data = { employees: [], shifts: [], serverNow: null };
let state = {
  view: 'terminal',
  adminAuthenticated: false,
  employeeToken: sessionStorage.getItem(EMPLOYEE_TOKEN_KEY) || '',
  employeeId: sessionStorage.getItem(EMPLOYEE_ID_KEY) || '',
  closeVerification: false,
  codeValue: '',
  employeeEditor: null
};

const app = document.querySelector('#app');
const toast = document.querySelector('#toast');

async function rpc(name, parameters = {}) {
  const { data: result, error } = await supabaseClient.rpc(name, parameters);
  if (error) throw new Error(error.message || 'Не удалось выполнить действие.');
  return result;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatName(employee) {
  return `${employee.firstName} ${employee.lastName}`;
}

function getOpenShift(employeeId) {
  return data.shifts.find((shift) => shift.employeeId === employeeId && !shift.endAt) || null;
}

function getActiveSegment(shift) {
  return shift?.segments.find((segment) => !segment.endAt) || null;
}

function durationMs(startAt, endAt = new Date().toISOString()) {
  return Math.max(0, new Date(endAt).getTime() - new Date(startAt).getTime());
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function formatShortDuration(milliseconds) {
  const minutes = Math.floor(milliseconds / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

function formatTime(iso) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function segmentTotals(shift, now = new Date().toISOString()) {
  const totals = { work: 0, break: 0, sleep: 0 };
  if (!shift) return totals;
  shift.segments.forEach((segment) => {
    totals[segment.type] += durationMs(segment.startAt, segment.endAt || now);
  });
  return totals;
}

function currentStatus(shift) {
  return getActiveSegment(shift)?.type || 'work';
}

function statusLabel(status) {
  return { work: 'На работе', break: 'На перерыве', sleep: 'Сон' }[status] || 'Неизвестно';
}

function statusIcon(status) {
  if (status === 'work') return '●';
  if (status === 'break') return 'Ⅱ';
  return 'Z';
}

function getEmployee(id) {
  return data.employees.find((employee) => employee.id === id) || null;
}

function getSessionEmployee() {
  const employee = getEmployee(state.employeeId);
  return employee && getOpenShift(employee.id) && state.employeeToken ? employee : null;
}

function showToast(message, variant = 'success') {
  toast.textContent = message;
  toast.className = `toast show ${variant}`;
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    toast.className = 'toast';
  }, 3600);
}

function applyEmployeeSession(payload, token = state.employeeToken) {
  data = { employees: [payload.employee], shifts: [payload.shift], serverNow: null };
  state.employeeId = payload.employee.id;
  state.employeeToken = token;
  sessionStorage.setItem(EMPLOYEE_ID_KEY, payload.employee.id);
  sessionStorage.setItem(EMPLOYEE_TOKEN_KEY, token);
}

function clearEmployeeSession() {
  state.employeeId = '';
  state.employeeToken = '';
  state.closeVerification = false;
  state.codeValue = '';
  sessionStorage.removeItem(EMPLOYEE_ID_KEY);
  sessionStorage.removeItem(EMPLOYEE_TOKEN_KEY);
}

function render() {
  if (!isConfigured) {
    app.innerHTML = renderConfigurationScreen();
    return;
  }
  app.innerHTML = `
    <div class="page-background"></div>
    <header class="topbar">
      <a class="brand" href="#terminal" data-view="terminal" aria-label="База — терминал">
        <span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>
        <span>БАЗА</span>
      </a>
      <nav class="topnav" aria-label="Разделы приложения">
        <button class="nav-link ${state.view === 'terminal' ? 'is-active' : ''}" data-view="terminal">Терминал</button>
        <button class="nav-link ${state.view === 'admin' ? 'is-active' : ''}" data-view="admin">Администратор</button>
      </nav>
      <div class="clock" aria-live="off">
        <span id="header-time">${formatTime(new Date().toISOString())}</span>
        <span id="header-date">${new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())}</span>
      </div>
    </header>
    <div class="page-content">
      ${state.view === 'admin' ? renderAdmin() : renderTerminal()}
    </div>
  `;
  bindEmployeeForm();
}

function bindEmployeeForm() {
  const form = app.querySelector('#employee-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    run(() => saveEmployee(form));
  });
}

function renderConfigurationScreen() {
  return `
    <div class="page-background"></div>
    <section class="admin-login-wrap" aria-labelledby="configuration-title">
      <div class="admin-login-card">
        <div class="admin-login-symbol" aria-hidden="true">◆</div>
        <p class="eyebrow">Требуется подключение</p>
        <h1 id="configuration-title">Подключите облачную базу</h1>
        <p>Добавьте адрес проекта и публичный ключ Supabase в файл <strong>config.js</strong>, затем обновите страницу.</p>
        <p class="initial-code">Данные сотрудников и смен будут храниться централизованно и доступны с любого устройства через интернет.</p>
      </div>
    </section>
  `;
}

function renderTerminal() {
  const employee = getSessionEmployee();
  if (!employee) return renderCodeEntry();
  return state.closeVerification ? renderCloseVerification(employee) : renderEmployeePanel(employee);
}

function renderCodeEntry() {
  return `
    <section class="terminal-layout" aria-labelledby="terminal-title">
      <div class="terminal-copy">
        <p class="eyebrow">Терминал учёта</p>
        <h1 id="terminal-title">Отметьте<br><em>рабочее время.</em></h1>
        <p class="lead">Введите личный код, чтобы открыть смену. Если смена уже открыта, вы сразу вернётесь в свой рабочий экран.</p>
        <div class="terminal-note">
          <span class="note-symbol" aria-hidden="true">+</span>
          <div><strong>Просто и прозрачно</strong><p>Перерывы и сон учитываются отдельно от рабочего времени.</p></div>
        </div>
      </div>
      <div class="terminal-card code-card">
        <div class="card-heading">
          <span class="card-kicker">Личный доступ</span>
          <h2>Введите код</h2>
          <p>Код состоит из 4–8 цифр.</p>
        </div>
        <form id="employee-code-form" class="code-form" novalidate>
          <label class="sr-only" for="employee-code">Индивидуальный код</label>
          <input id="employee-code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*" placeholder="••••" value="${escapeHtml(state.codeValue)}" autofocus />
          <div class="keypad" aria-label="Цифровая клавиатура">
            ${[1,2,3,4,5,6,7,8,9].map((number) => `<button type="button" class="key" data-key="${number}">${number}</button>`).join('')}
            <button type="button" class="key clear-key" data-key="clear" aria-label="Очистить код">C</button>
            <button type="button" class="key" data-key="0">0</button>
            <button type="button" class="key delete-key" data-key="delete" aria-label="Удалить последнюю цифру">←</button>
          </div>
          <button class="primary-button full-button" type="submit">Продолжить <span aria-hidden="true">→</span></button>
        </form>
        <p class="card-footnote">Не знаете код? Обратитесь к администратору базы.</p>
      </div>
    </section>
  `;
}

function renderEmployeePanel(employee) {
  const shift = getOpenShift(employee.id);
  const totals = segmentTotals(shift);
  const status = currentStatus(shift);
  const activeSegment = getActiveSegment(shift);
  const startedAt = activeSegment?.startAt || shift.startAt;
  return `
    <section class="employee-layout" aria-labelledby="employee-title">
      <div class="employee-header">
        <div>
          <p class="eyebrow">Открытая смена</p>
          <h1 id="employee-title">${escapeHtml(formatName(employee))}</h1>
          <p class="started-line">Смена начата сегодня в ${formatTime(shift.startAt)}</p>
        </div>
        <div class="status-chip ${status}"><span aria-hidden="true">${statusIcon(status)}</span>${statusLabel(status)}</div>
      </div>
      <div class="work-panel">
        <section class="main-status-card">
          <div class="status-orb ${status}" aria-hidden="true"><span>${statusIcon(status)}</span></div>
          <p class="status-title">${statusLabel(status)}</p>
          <strong id="current-status-duration" class="big-duration">${formatDuration(durationMs(startedAt))}</strong>
          <p class="muted">${status === 'work' ? 'в текущем рабочем отрезке' : status === 'break' ? 'длительность текущего перерыва' : 'длительность текущего сна'}</p>
          <div class="control-grid">
            <button class="control-button work ${status === 'work' ? 'selected' : ''}" data-action="set-status" data-status="work" ${status === 'work' ? 'disabled' : ''}><span class="control-symbol">●</span><span>Работа</span></button>
            <button class="control-button break ${status === 'break' ? 'selected' : ''}" data-action="set-status" data-status="${status === 'break' ? 'work' : 'break'}"><span class="control-symbol">Ⅱ</span><span>${status === 'break' ? 'Закончить перерыв' : 'Перерыв'}</span></button>
            <button class="control-button sleep ${status === 'sleep' ? 'selected' : ''}" data-action="set-status" data-status="${status === 'sleep' ? 'work' : 'sleep'}"><span class="control-symbol">Z</span><span>${status === 'sleep' ? 'Закончить сон' : 'Сон'}</span></button>
          </div>
        </section>
        <aside class="shift-summary-card">
          <div class="summary-top">
            <span>Сводка смены</span>
            <span class="live-badge"><i></i> Обновляется</span>
          </div>
          <div class="summary-list">
            ${summaryRow('work', 'Рабочее время', totals.work)}
            ${summaryRow('break', 'Перерывы', totals.break)}
            ${summaryRow('sleep', 'Сон', totals.sleep)}
          </div>
          <div class="total-row"><span>В смене</span><strong id="shift-total-duration">${formatDuration(durationMs(shift.startAt))}</strong></div>
          <button type="button" class="outline-button close-shift-button" data-action="ask-close-shift">Закрыть смену <span aria-hidden="true">→</span></button>
        </aside>
      </div>
      <div class="privacy-note"><span aria-hidden="true">◆</span> Чтобы закрыть смену, нужно снова ввести личный код.</div>
    </section>
  `;
}

function summaryRow(type, label, duration) {
  return `<div class="summary-row"><span class="summary-label"><i class="summary-dot ${type}"></i>${label}</span><strong data-total="${type}">${formatDuration(duration)}</strong></div>`;
}

function renderCloseVerification(employee) {
  return `
    <section class="verification-wrap" aria-labelledby="close-title">
      <div class="verification-card">
        <button class="back-button" type="button" data-action="cancel-close"><span aria-hidden="true">←</span> Назад</button>
        <div class="verification-icon" aria-hidden="true">✓</div>
        <p class="eyebrow">Закрытие смены</p>
        <h1 id="close-title">Подтвердите код</h1>
        <p>Введите личный код сотрудника <strong>${escapeHtml(formatName(employee))}</strong>, чтобы завершить смену.</p>
        <form id="close-shift-form" class="code-form compact" novalidate>
          <label class="sr-only" for="close-code">Индивидуальный код</label>
          <input id="close-code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*" placeholder="••••" value="${escapeHtml(state.codeValue)}" autofocus />
          <div class="keypad compact-keypad" aria-label="Цифровая клавиатура">
            ${[1,2,3,4,5,6,7,8,9].map((number) => `<button type="button" class="key" data-key="${number}">${number}</button>`).join('')}
            <button type="button" class="key clear-key" data-key="clear" aria-label="Очистить код">C</button>
            <button type="button" class="key" data-key="0">0</button>
            <button type="button" class="key delete-key" data-key="delete" aria-label="Удалить последнюю цифру">←</button>
          </div>
          <button class="primary-button full-button" type="submit">Подтвердить и закрыть</button>
        </form>
      </div>
    </section>
  `;
}

function renderAdmin() {
  if (!state.adminAuthenticated) return renderAdminLogin();
  const openShifts = data.shifts.filter((shift) => !shift.endAt);
  const rows = openShifts.map((shift) => ({ shift, employee: getEmployee(shift.employeeId), totals: segmentTotals(shift), status: currentStatus(shift) })).filter((entry) => entry.employee);
  const onBase = rows.filter((entry) => entry.status === 'work').length;
  const onBreak = rows.filter((entry) => entry.status === 'break').length;
  const sleeping = rows.filter((entry) => entry.status === 'sleep').length;
  const todayEnded = data.shifts.filter((shift) => shift.endAt && new Date(shift.startAt).getTime() >= todayRange());
  const todayWork = todayEnded.reduce((total, shift) => total + segmentTotals(shift, shift.endAt).work, 0) + rows.reduce((total, entry) => total + entry.totals.work, 0);

  return `
    <section class="admin-page" aria-labelledby="admin-title">
      <div class="admin-titlebar">
        <div>
          <p class="eyebrow">Управление базой</p>
          <h1 id="admin-title">Онлайн-статус</h1>
        </div>
        <div class="admin-actions"><span class="live-badge"><i></i> Онлайн</span><button class="text-button" data-action="logout-admin">Выйти</button></div>
      </div>
      <section class="metrics-grid" aria-label="Статистика по сотрудникам">
        ${metricCard('На базе', onBase, 'Сотрудники в рабочем режиме', 'work')}
        ${metricCard('На перерыве', onBreak, 'Перерывы идут прямо сейчас', 'break')}
        ${metricCard('Сон', sleeping, 'Отдельно от рабочего времени', 'sleep')}
        ${metricCard('Сегодня', formatShortDuration(todayWork), 'Суммарно рабочего времени', 'total')}
      </section>
      <div class="admin-grid">
        <section class="dashboard-card presence-card" aria-labelledby="presence-title">
          <div class="section-heading">
            <div><h2 id="presence-title">Кто сейчас на базе</h2><p>Все открытые смены обновляются автоматически.</p></div>
            <span class="count-label">${rows.length} ${pluralPeople(rows.length)}</span>
          </div>
          ${rows.length ? `<div class="presence-table"><div class="table-header"><span>Сотрудник</span><span>Статус</span><span>Смена</span><span>Работа</span><span>Перерыв / сон</span></div>${rows.map(renderPresenceRow).join('')}</div>` : renderEmptyPresence()}
        </section>
        <section class="dashboard-card activity-card" aria-labelledby="activity-title">
          <div class="section-heading"><div><h2 id="activity-title">Последние смены</h2><p>Закрытые смены за сегодня.</p></div></div>
          <div class="activity-list">${renderRecentShifts()}</div>
        </section>
      </div>
      <section class="management-section" aria-labelledby="employee-management-title">
        <div class="section-heading management-heading">
          <div><p class="eyebrow">Доступ сотрудников</p><h2 id="employee-management-title">Сотрудники и коды</h2></div>
          <button class="primary-button small" type="button" data-action="new-employee"><span aria-hidden="true">+</span> Добавить сотрудника</button>
        </div>
        <div class="employees-table-wrap">
          <table class="employees-table">
            <thead><tr><th>Сотрудник</th><th>Индивидуальный код</th><th>Статус доступа</th><th class="align-right">Действия</th></tr></thead>
            <tbody>${data.employees.map(renderEmployeeRow).join('')}</tbody>
          </table>
        </div>
      </section>
      ${state.employeeEditor ? renderEmployeeModal(state.employeeEditor) : ''}
    </section>
  `;
}

function metricCard(label, value, description, tone) {
  return `<article class="metric-card ${tone}"><span class="metric-marker" aria-hidden="true"></span><p>${label}</p><strong>${value}</strong><small>${description}</small></article>`;
}

function renderPresenceRow({ shift, employee, totals, status }) {
  return `<div class="presence-row"><div class="person-cell"><span class="avatar">${escapeHtml(employee.firstName[0] || '')}${escapeHtml(employee.lastName[0] || '')}</span><div><strong>${escapeHtml(formatName(employee))}</strong><small>с ${formatTime(shift.startAt)}</small></div></div><div><span class="status-pill ${status}"><i>${statusIcon(status)}</i>${statusLabel(status)}</span></div><strong>${formatDuration(durationMs(shift.startAt))}</strong><div class="split-time"><span><i class="summary-dot break"></i><b data-shift-break="${shift.id}">${formatDuration(totals.break)}</b></span><span><i class="summary-dot sleep"></i><b data-shift-sleep="${shift.id}">${formatDuration(totals.sleep)}</b></span></div></div>`;
}

function renderEmptyPresence() {
  return `<div class="empty-state"><span class="empty-symbol" aria-hidden="true">○</span><h3>Сейчас на базе никого нет</h3><p>Открытые смены появятся здесь после ввода сотрудниками своих кодов.</p></div>`;
}

function renderRecentShifts() {
  const shifts = data.shifts.filter((shift) => shift.endAt && new Date(shift.startAt).getTime() >= todayRange()).sort((a, b) => new Date(b.endAt) - new Date(a.endAt)).slice(0, 5);
  if (!shifts.length) return `<div class="empty-activity"><span>Пока нет закрытых смен за сегодня.</span></div>`;
  return shifts.map((shift) => {
    const employee = getEmployee(shift.employeeId);
    const totals = segmentTotals(shift, shift.endAt);
    return `<article class="activity-item"><span class="avatar small-avatar">${escapeHtml(employee?.firstName?.[0] || '?')}${escapeHtml(employee?.lastName?.[0] || '')}</span><div><strong>${escapeHtml(employee ? formatName(employee) : 'Удалённый сотрудник')}</strong><p>${formatTime(shift.startAt)} — ${formatTime(shift.endAt)}</p></div><div class="activity-total"><strong>${formatShortDuration(totals.work)}</strong><span>работа</span></div></article>`;
  }).join('');
}

function pluralPeople(number) {
  const remainder = number % 10;
  const hundred = number % 100;
  if (hundred >= 11 && hundred <= 14) return 'человек';
  if (remainder === 1) return 'человек';
  if (remainder >= 2 && remainder <= 4) return 'человека';
  return 'человек';
}

function renderEmployeeRow(employee) {
  const openShift = getOpenShift(employee.id);
  return `<tr><td><div class="table-person"><span class="avatar small-avatar">${escapeHtml(employee.firstName[0] || '')}${escapeHtml(employee.lastName[0] || '')}</span><strong>${escapeHtml(formatName(employee))}</strong></div></td><td><span class="employee-code">Не отображается</span></td><td>${openShift ? '<span class="access-badge active">Открытая смена</span>' : employee.active ? '<span class="access-badge">Активен</span>' : '<span class="access-badge inactive">Отключён</span>'}</td><td class="align-right"><button type="button" class="row-action" data-action="edit-employee" data-id="${employee.id}">Изменить</button></td></tr>`;
}

function renderEmployeeModal(editor) {
  const isNew = editor === 'new';
  const employee = isNew ? { firstName: '', lastName: '', active: true } : getEmployee(editor);
  if (!employee) return '';
  return `<div class="modal-backdrop" role="presentation"><section class="employee-modal" role="dialog" aria-modal="true" aria-labelledby="employee-modal-title"><button type="button" class="modal-close" aria-label="Закрыть" data-action="close-editor">×</button><p class="eyebrow">${isNew ? 'Новый доступ' : 'Данные сотрудника'}</p><h2 id="employee-modal-title">${isNew ? 'Добавить сотрудника' : 'Изменить сотрудника'}</h2><form id="employee-form"><input type="hidden" name="id" value="${isNew ? '' : employee.id}" /><div class="form-grid"><label>Имя<input name="firstName" maxlength="40" required value="${escapeHtml(employee.firstName)}" /></label><label>Фамилия<input name="lastName" maxlength="40" required value="${escapeHtml(employee.lastName)}" /></label></div><label>Индивидуальный код<input name="code" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" minlength="4" ${isNew ? 'required' : ''} placeholder="${isNew ? 'Например, 2404' : 'Новый код при необходимости'}" /><small>${isNew ? 'От 4 до 8 цифр. Сообщите его сотруднику и сохраните — в базе он хранится в защищённом виде.' : 'Оставьте пустым, чтобы сохранить текущий код. Новый код заменит старый без возможности его просмотра.'}</small></label><label class="checkbox-label"><input name="active" type="checkbox" ${employee.active ? 'checked' : ''} /><span>Сотрудник может открывать смены</span></label><div class="modal-actions"><button type="button" class="outline-button" data-action="close-editor">Отмена</button><button type="submit" class="primary-button">Сохранить</button></div></form></section></div>`;
}

function renderAdminLogin() {
  return `
    <section class="admin-login-wrap" aria-labelledby="admin-login-title">
      <div class="admin-login-card">
        <div class="admin-login-symbol" aria-hidden="true">◆</div>
        <p class="eyebrow">Защищённый раздел</p>
        <h1 id="admin-login-title">Панель администратора</h1>
        <p>Войдите по рабочему адресу электронной почты и паролю администратора.</p>
        <form id="admin-login-form" class="admin-login-form">
          <label for="admin-email">Электронная почта</label>
          <input id="admin-email" name="email" type="email" autocomplete="username" required />
          <label for="admin-password">Пароль</label>
          <input id="admin-password" name="password" type="password" autocomplete="current-password" minlength="8" required />
          <button class="primary-button full-button" type="submit">Войти в панель <span aria-hidden="true">→</span></button>
        </form>
      </div>
    </section>
  `;
}

function useKeypad(key) {
  if (key === 'clear') state.codeValue = '';
  else if (key === 'delete') state.codeValue = state.codeValue.slice(0, -1);
  else if (state.codeValue.length < 8) state.codeValue += key;
  const input = document.querySelector('#employee-code, #close-code');
  if (input) {
    input.value = state.codeValue;
    input.focus();
  }
}

async function handleEmployeeCode(form) {
  const code = form.elements.code.value.trim();
  state.codeValue = code;
  if (!/^\d{4,8}$/.test(code)) throw new Error('Введите код из 4–8 цифр.');
  const payload = await rpc('clock_in', { p_code: code });
  applyEmployeeSession(payload, payload.token);
  state.codeValue = '';
  render();
  showToast(payload.opened ? `Смена сотрудника «${formatName(payload.employee)}» открыта.` : `Открыта текущая смена: ${formatName(payload.employee)}.`);
}

async function setShiftStatus(targetStatus) {
  const employee = getSessionEmployee();
  if (!employee) throw new Error('Введите личный код ещё раз.');
  const shift = await rpc('set_employee_status', { p_token: state.employeeToken, p_status: targetStatus });
  data.shifts = [shift];
  render();
  showToast(targetStatus === 'work' ? 'Рабочее время снова учитывается.' : targetStatus === 'break' ? 'Перерыв начался. Он учитывается отдельно.' : 'Режим сна начался и учитывается отдельно.');
}

async function handleCloseCode(form) {
  const employee = getSessionEmployee();
  if (!employee) throw new Error('Введите личный код ещё раз.');
  const code = form.elements.code.value.trim();
  if (!/^\d{4,8}$/.test(code)) throw new Error('Введите код из 4–8 цифр.');
  await rpc('close_shift', { p_token: state.employeeToken, p_code: code });
  const employeeName = formatName(employee);
  clearEmployeeSession();
  render();
  showToast(`Смена сотрудника «${employeeName}» закрыта.`);
}

async function saveEmployee(form) {
  const formData = new FormData(form);
  const id = String(formData.get('id') || '');
  const code = String(formData.get('code') || '').trim();
  const employee = {
    firstName: String(formData.get('firstName')).trim(),
    lastName: String(formData.get('lastName')).trim(),
    active: formData.get('active') === 'on'
  };
  if ((!id || code) && !/^\d{4,8}$/.test(code)) throw new Error('Индивидуальный код должен содержать от 4 до 8 цифр.');
  if (id) {
    await rpc('update_employee', { p_id: id, p_first_name: employee.firstName, p_last_name: employee.lastName, p_code: code || null, p_active: employee.active });
  } else {
    await rpc('create_employee', { p_first_name: employee.firstName, p_last_name: employee.lastName, p_code: code, p_active: employee.active });
  }
  data = await rpc('admin_dashboard');
  state.adminAuthenticated = true;
  state.employeeEditor = null;
  render();
  showToast(id ? 'Данные сотрудника сохранены.' : 'Сотрудник добавлен. Сохраните выданный код — его нельзя посмотреть повторно.');
}

async function refreshAdminData({ quiet = false } = {}) {
  if (!supabaseClient) return;
  const { data: sessionData } = await supabaseClient.auth.getSession();
  if (!sessionData.session) {
    state.adminAuthenticated = false;
    if (state.view === 'admin') render();
    return;
  }
  try {
    data = await rpc('admin_dashboard');
    state.adminAuthenticated = true;
    if (state.view === 'admin') render();
  } catch (error) {
    state.adminAuthenticated = false;
    if (state.view === 'admin') render();
    if (!quiet) showToast(error.message, 'error');
  }
}

async function refreshEmployeeSession({ quiet = false } = {}) {
  if (!state.employeeToken) return;
  try {
    const payload = await rpc('employee_session', { p_token: state.employeeToken });
    applyEmployeeSession(payload);
    if (state.view === 'terminal') render();
  } catch (error) {
    clearEmployeeSession();
    if (state.view === 'terminal') render();
    if (!quiet) showToast(error.message, 'error');
  }
}

function run(action) {
  Promise.resolve(action()).catch((error) => showToast(error.message || 'Не удалось выполнить действие.', 'error'));
}

document.addEventListener('click', (event) => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) {
    event.preventDefault();
    state.view = viewButton.dataset.view;
    state.codeValue = '';
    render();
    if (state.view === 'admin') run(() => refreshAdminData());
    if (state.view === 'terminal' && state.employeeToken) run(() => refreshEmployeeSession({ quiet: true }));
    return;
  }
  const key = event.target.closest('[data-key]');
  if (key) {
    useKeypad(key.dataset.key);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'set-status') run(() => setShiftStatus(button.dataset.status));
  if (action === 'ask-close-shift') {
    state.closeVerification = true;
    state.codeValue = '';
    render();
  }
  if (action === 'cancel-close') {
    state.closeVerification = false;
    state.codeValue = '';
    render();
  }
  if (action === 'logout-admin') {
    run(async () => {
      await supabaseClient.auth.signOut();
      state.adminAuthenticated = false;
      state.employeeEditor = null;
      render();
    });
  }
  if (action === 'new-employee') {
    state.employeeEditor = 'new';
    render();
  }
  if (action === 'edit-employee') {
    state.employeeEditor = button.dataset.id;
    render();
  }
  if (action === 'close-editor') {
    state.employeeEditor = null;
    render();
  }
});

document.addEventListener('input', (event) => {
  if (event.target.matches('#employee-code, #close-code')) {
    const sanitized = event.target.value.replace(/\D/g, '').slice(0, 8);
    event.target.value = sanitized;
    state.codeValue = sanitized;
  }
  if (event.target.matches('input[name="code"]')) event.target.value = event.target.value.replace(/\D/g, '');
});

document.addEventListener('submit', (event) => {
  if (event.target.id === 'employee-code-form') {
    event.preventDefault();
    run(() => handleEmployeeCode(event.target));
  }
  if (event.target.id === 'close-shift-form') {
    event.preventDefault();
    run(() => handleCloseCode(event.target));
  }
  if (event.target.id === 'admin-login-form') {
    event.preventDefault();
    const email = event.target.elements.email.value.trim();
    const password = event.target.elements.password.value;
    run(async () => {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message || 'Не удалось войти в панель.');
      await refreshAdminData();
    });
  }
});

window.setInterval(() => {
  const time = document.querySelector('#header-time');
  const date = document.querySelector('#header-date');
  if (time) time.textContent = formatTime(new Date().toISOString());
  if (date) date.textContent = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date());
  refreshLiveDurations();
}, 1000);

window.setInterval(() => {
  if (!supabaseClient) return;
  if (state.view === 'admin' && state.adminAuthenticated && !state.employeeEditor && !document.querySelector('input:focus')) run(() => refreshAdminData({ quiet: true }));
  if (state.view === 'terminal' && state.employeeToken && !state.closeVerification && !document.querySelector('input:focus')) run(() => refreshEmployeeSession({ quiet: true }));
}, 5000);

function refreshLiveDurations() {
  const employee = getSessionEmployee();
  if (employee && state.view === 'terminal' && !state.closeVerification) {
    const shift = getOpenShift(employee.id);
    const segment = getActiveSegment(shift);
    const total = document.querySelector('#shift-total-duration');
    const current = document.querySelector('#current-status-duration');
    if (total) total.textContent = formatDuration(durationMs(shift.startAt));
    if (current && segment) current.textContent = formatDuration(durationMs(segment.startAt));
  }
  if (state.view === 'admin' && state.adminAuthenticated) {
    data.shifts.filter((shift) => !shift.endAt).forEach((shift) => {
      const totals = segmentTotals(shift);
      const breakField = document.querySelector(`[data-shift-break="${shift.id}"]`);
      const sleepField = document.querySelector(`[data-shift-sleep="${shift.id}"]`);
      if (breakField) breakField.textContent = formatDuration(totals.break);
      if (sleepField) sleepField.textContent = formatDuration(totals.sleep);
    });
  }
}

async function initialize() {
  render();
  if (!supabaseClient) return;
  await Promise.all([
    refreshEmployeeSession({ quiet: true }),
    refreshAdminData({ quiet: true })
  ]);
}

initialize();
