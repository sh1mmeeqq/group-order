'use strict';
// Клиент группового заказа: один код для хоста и гостя. Роль определяет сервер (state.me.isHost).
// Экраны названы по ТЗ: H1–H7 (хост), G1–G8 (гость).
(function () {
  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  const $toasts = document.getElementById('toasts');
  const $live = document.getElementById('live');
  const $net = document.getElementById('net');

  // ---------- Утилиты ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rub = (kop) => {
    const v = kop / 100;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v) + ' ₽';
  };
  const plural = (n, a, b, c) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return a;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return b;
    return c;
  };
  const clockText = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const svgi = (d) => `<svg class="ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    users: svgi('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M17 14.2c2.4.2 4 2.1 4 4.8"/>'),
    clock: svgi('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    qr: svgi('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v1M14 20h1M18 20h3v-3"/>'),
    gear: svgi('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
    lock: svgi('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    check: svgi('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    alert: svgi('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
  };

  const ERR = {
    session_locked: 'Корзина заблокирована',
    time_up: 'Время выбора вышло',
    item_unavailable: 'Этого блюда нет в наличии',
    cart_full: 'Достигнут предел сессии',
    forbidden: 'Это действие недоступно',
    cart_empty: 'Корзина пуста',
    bad_state: 'Состояние заказа изменилось, попробуйте ещё раз',
    session_closed: 'Заказ уже закрыт',
    not_found: 'Не найдено',
    bad_request: 'Проверьте введённые данные',
    payment_failed: 'Оплата не прошла. Корзина осталась заблокированной',
    internal: 'Что-то пошло не так. Попробуйте ещё раз',
  };
  const CLOSE_TEXT = {
    cancelled: 'Хост отменил групповой заказ',
    expired: 'Время сессии истекло',
    completed: 'Этот групповой заказ завершён',
  };

  // ---------- Состояние ----------
  const path = location.pathname;
  const S = {
    role: path.startsWith('/j/') ? 'guest' : 'host',
    code: (path.split('/')[2] || '').toUpperCase() || null,
    token: null, ws: null, connected: false, retry: 0,
    menu: null, restaurant: null, st: null, anon: null, fatal: null,
    view: 'menu', tab: 'mine', cat: null, offset: 0,
    fresh: new Map(), draftName: '', sheet: null, warned: null, showInvite: false, trackedPaid: false,
  };
  if (S.code) S.token = store.get('go:token:' + S.code);

  const inviteUrl = () => `${location.origin}/j/${S.code}`;
  const me = () => S.st && S.st.me;

  // ---------- Сеть ----------
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      setNet(true);
      ws.send(JSON.stringify({ t: 'hello', code: S.code, token: S.token }));
    };
    ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      setNet(false);
      if (!S.fatal) setTimeout(connect, Math.min(10000, 1000 * 2 ** S.retry++));
    };
  }

  function setNet(ok) {
    S.connected = ok;
    $net.hidden = ok;
    if (S.st) render();
  }

  function send(msg) {
    if (!S.ws || S.ws.readyState !== 1) { toast('Нет связи. Пробуем подключиться…'); return false; }
    S.ws.send(JSON.stringify(msg));
    return true;
  }

  function onMsg(msg) {
    switch (msg.t) {
      case 'anon':
        if (S.role === 'host') { S.fatal = 'host_no_access'; S.ws.close(); return render(); }
        S.anon = msg.preview;
        if (!S.draftName) S.draftName = store.get('go:name') || '';
        return render();
      case 'welcome':
        S.menu = msg.menu;
        S.restaurant = msg.restaurant;
        if (msg.token) { S.token = msg.token; store.set('go:token:' + S.code, msg.token); }
        return;
      case 'state': return onState(msg);
      case 'event': return onEvent(msg);
      case 'kicked': S.fatal = 'kicked'; if (S.ws) S.ws.close(); return render();
      case 'error': return onError(msg);
      default: return undefined;
    }
  }

  function onState(next) {
    const prev = S.st;
    S.offset = next.now - Date.now();
    if (prev) {
      const old = new Map();
      for (const p of prev.participants) for (const it of p.items) old.set(`${p.id}:${it.menuItemId}`, it.qty);
      for (const p of next.participants) {
        if (p.id === next.me.id) continue;
        for (const it of p.items) {
          const k = `${p.id}:${it.menuItemId}`;
          if (old.get(k) !== it.qty) S.fresh.set(k, Date.now());
        }
      }
    }
    if (prev && prev.session.phase !== next.session.phase && !['waiting', 'selecting'].includes(next.session.phase)) closeSheet();
    if (next.session.phase === 'paid' && !next.me.isHost) store.set('go:name', next.me.name);
    S.st = next;
    S.anon = null;
    if (S.showInvite && next.me.isHost) { S.showInvite = false; render(); openInvite(); return; }
    render();
  }

  function onEvent(ev) {
    const text = eventText(ev);
    if (!text) return;
    live(text);
    if (me() && me().isHost && ['guest_joined', 'item_added', 'item_changed', 'item_removed'].includes(ev.kind)) toast(text);
    if (me() && !me().isHost && ['timer_extended', 'settings_changed'].includes(ev.kind)) toast(text);
  }

  function eventText(ev) {
    const who = ev.forName ? `${ev.by} → ${ev.forName}` : ev.by;
    switch (ev.kind) {
      case 'guest_joined': return `${ev.by} присоединился к заказу`;
      case 'item_added': return `${who}: добавлено «${ev.item}»`;
      case 'item_changed': return `${who}: «${ev.item}» × ${ev.qty}`;
      case 'item_removed': return `${who}: убрано «${ev.item}»`;
      case 'guest_done': return `${ev.by} закончил выбор`;
      case 'timer_extended': return `Хост продлил время на ${ev.minutes} мин`;
      case 'settings_changed': return 'Хост изменил настройки заказа';
      case 'locked': return 'Хост заблокировал корзину';
      case 'unlocked': return 'Корзина снова открыта';
      default: return '';
    }
  }

  function onError(msg) {
    const c = msg.code;
    if (c === 'session_not_found' || c === 'session_finished') {
      S.fatal = c;
      if (S.ws) S.ws.close();
      return render();
    }
    if (c === 'limit_exceeded') return openLimit(msg);
    if (!S.st && S.anon) {
      const el = document.getElementById('nerr');
      if (el) el.textContent = c === 'session_full' ? 'В этом заказе уже максимум гостей' : 'Введите имя, не длиннее 24 символов';
      return undefined;
    }
    return toast(ERR[c] || ERR.internal);
  }

  // ---------- Тосты и озвучивание ----------
  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $toasts.appendChild(el);
    while ($toasts.children.length > 3) $toasts.firstChild.remove();
    setTimeout(() => el.remove(), 2600);
  }
  let liveLast = 0, livePending = [], liveTimer = null;
  function live(text) { // не чаще раза в 3 секунды, накопленное склеивается
    livePending.push(text);
    const flush = () => { $live.textContent = livePending.join('. '); livePending = []; liveLast = Date.now(); liveTimer = null; };
    const wait = 3000 - (Date.now() - liveLast);
    if (wait <= 0) flush();
    else if (!liveTimer) liveTimer = setTimeout(flush, wait);
  }

  // ---------- Шторки ----------
  let lastFocus = null;
  function openSheet(kind, label, html) {
    lastFocus = document.activeElement;
    S.sheet = kind;
    $sheet.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">
        <button class="x" data-act="close-sheet" aria-label="Закрыть">×</button>${html}</div>`;
    document.body.classList.add('noscroll');
    const first = $sheet.querySelector('input:not([type=checkbox]), .btn.primary');
    if (first) first.focus();
  }
  function closeSheet() {
    if (!S.sheet) return;
    S.sheet = null;
    $sheet.innerHTML = '';
    document.body.classList.remove('noscroll');
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  // ---------- Рендер: общие куски ----------
  const avatar = (p) => `<span class="av" style="background:hsl(${(p.id * 47) % 360} 45% 36%)" aria-hidden="true">${esc([...p.name][0].toUpperCase())}</span>`;
  const mySubtotal = () => { const m = S.st.participants.find((p) => p.id === S.st.me.id); return m ? m.subtotal : 0; };
  const myQty = (mid) => {
    const m = S.st.participants.find((p) => p.id === S.st.me.id);
    const it = m && m.items.find((i) => i.menuItemId === mid);
    return it ? it.qty : 0;
  };

  function stepper(mid, qty, pid, can) {
    const off = can ? '' : ' off" aria-disabled="true';
    return `<div class="step" role="group" aria-label="Количество">
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty - 1}" data-pid="${pid || ''}" aria-label="Убрать одну порцию">−</button>
      <span class="sq">${qty}</span>
      <button class="sb${off}" data-act="qty" data-mid="${mid}" data-qty="${qty + 1}" data-pid="${pid || ''}" aria-label="Добавить порцию">+</button></div>`;
  }

  function dishHtml(m, mode) { // mode: null — без действий (экран H1), иначе { can }
    const act = !mode ? '' : !m.available ? '<span class="tag bad">Нет в наличии</span>'
      : myQty(m.id) > 0 ? stepper(m.id, myQty(m.id), '', mode.can)
        : `<button class="sb add${mode.can ? '' : ' off" aria-disabled="true'}" data-act="qty" data-mid="${m.id}" data-qty="1" aria-label="Добавить: ${esc(m.name)}">+</button>`;
    return `<article class="dish${m.available ? '' : ' na'}">
      <div class="dish-main"><h3>${esc(m.name)}</h3>${m.description ? `<p class="desc">${esc(m.description)}</p>` : ''}
        <p class="meta"><b>${rub(m.price)}</b>${m.weight ? ` · ${esc(m.weight)}` : ''}</p></div>${act}</article>`;
  }

  function menuListHtml(mode) {
    const cats = [...new Set(S.menu.map((m) => m.category))];
    const list = S.cat ? S.menu.filter((m) => m.category === S.cat) : S.menu;
    return `<div class="cats" role="group" aria-label="Категории">
        <button aria-pressed="${!S.cat}" data-act="cat" data-v="">Все</button>
        ${cats.map((c) => `<button aria-pressed="${S.cat === c}" data-act="cat" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <main>${list.map((m) => dishHtml(m, mode)).join('')}</main>`;
  }

  // ---------- H1: меню с кнопкой «Заказать компанией» ----------
  function hostHomeHtml() {
    if (!S.menu) return '<p class="boot">Загрузка меню…</p>';
    const tip = store.get('go:tip') ? '' : '<div class="tip" role="note">Закажите вместе: друзья выберут блюда сами<button data-act="tip-close">Понятно</button></div>';
    return `<header class="top"><div class="top-t"><div class="rest">Меню ресторана</div><h1>${esc(S.restaurant.name)}</h1></div></header>
      <div class="cta"><button class="btn outline wide" data-act="create-open">${ICON.users} Заказать компанией</button>${tip}</div>
      ${menuListHtml(null)}`;
  }

  // ---------- G1: вход по ссылке, ввод имени ----------
  function nameHtml() {
    const a = S.anon;
    return `<section class="hero">
      <p class="eyebrow">${esc(a.restaurant)}</p>
      <h1>${esc(a.hostName)} зовёт вас заказать вместе</h1>
      <form data-form="join" novalidate>
        <label class="f" for="nm">Как вас зовут?</label>
        <input id="nm" type="text" maxlength="24" autocomplete="given-name" autocapitalize="words" value="${esc(S.draftName)}" required>
        <p class="err" id="nerr" role="alert"></p>
        <button class="btn primary wide" type="submit">Продолжить</button>
        <p class="hint">Регистрация не нужна</p>
      </form></section>`;
  }

  // ---------- Итоговые экраны ----------
  function fatalHtml() {
    const map = {
      kicked: ['Вас исключили из заказа', 'Хост убрал вас из этого группового заказа.'],
      host_no_access: ['Заказ создан на другом устройстве', 'Откройте заказ там, где вы его создали. Друзья могут присоединиться по ссылке.'],
      session_not_found: ['Заказ не найден', 'Проверьте ссылку: возможно, она набрана с ошибкой.'],
    };
    const [title, text] = map[S.fatal] || ['Этот групповой заказ завершён', 'Ссылка устарела или заказ уже закрыт.'];
    return closedBlock(title, text);
  }
  function closedBlock(title, text) {
    return `<section class="hero"><p class="eyebrow">Групповой заказ</p><h1>${esc(title)}</h1>
      <p class="muted" style="margin-bottom:24px">${esc(text)}</p>
      <a class="btn primary wide" style="text-decoration:none" href="/host">Открыть ресторан</a></section>`;
  }

  // ---------- Сессия ----------
  function sessionHtml() {
    const { session: ss, me: m } = S.st;
    if (ss.phase === 'closed') return closedBlock(CLOSE_TEXT[ss.closeReason] || CLOSE_TEXT.completed, 'Можно оформить новый заказ в ресторане.');
    if (ss.phase === 'paid') return m.isHost ? hostPaidHtml() : guestPaidHtml();
    const units = m.isHost ? ss.units : (S.st.participants.find((p) => p.id === m.id) || { items: [] }).items.reduce((a, i) => a + i.qty, 0);
    return `${topHtml()}${stripHtml()}${bannerHtml()}
      <nav class="seg" role="tablist" aria-label="Раздел">
        <button role="tab" aria-selected="${S.view === 'menu'}" data-act="view" data-v="menu">Меню</button>
        <button role="tab" aria-selected="${S.view === 'cart'}" data-act="view" data-v="cart">Корзина${units ? ` · ${units}` : ''}</button></nav>
      ${S.view === 'cart' ? cartHtml() : menuListHtml({ can: m.canEdit && S.connected })}
      ${barHtml()}`;
  }

  function topHtml() {
    const { session: ss, me: m } = S.st;
    const tools = m.isHost
      ? `<div class="top-a"><button class="ib" data-act="invite" aria-label="Пригласить: QR-код и ссылка">${ICON.qr}</button>
         <button class="ib" data-act="settings" aria-label="Настройки заказа">${ICON.gear}</button></div>` : '';
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div>${tools}</header>`;
  }

  function remaining() { return S.st.session.deadlineAt - (Date.now() + S.offset); }

  function stripHtml() {
    const { session: ss, me: m } = S.st;
    const chips = [`<span class="chip">${ICON.users} ${ss.guestCount} ${plural(ss.guestCount, 'гость', 'гостя', 'гостей')}</span>`];
    if (ss.deadlineAt) {
      const up = ss.phase === 'time_up';
      chips.push(`<span class="chip${up ? ' warn' : ''}" data-timer>${ICON.clock}<span>${up ? '00:00' : clockText(remaining())}</span></span>`);
    }
    chips.push(`<span class="chip strong">${rub(ss.total)}</span>`);
    let meter = '';
    if (!m.isHost && ss.limit) {
      const sub = mySubtotal();
      const left = Math.max(0, ss.limit - sub);
      const ratio = Math.min(1, sub / ss.limit);
      chips.push(`<span class="chip${ratio >= 0.8 ? ' warn' : ''}">Лимит: осталось ${rub(left)}</span>`);
      meter = `<div class="meter${ratio >= 0.8 ? ' warn' : ''}" role="progressbar" aria-label="Использовано из лимита" aria-valuemin="0" aria-valuemax="${ss.limit}" aria-valuenow="${Math.min(sub, ss.limit)}"><i style="width:${Math.round(ratio * 100)}%"></i></div>`;
    }
    return `<div class="strip">${chips.join('')}</div>${meter}`;
  }

  function bannerHtml() {
    const { session: ss, me: m } = S.st;
    const out = [];
    if (ss.phase === 'time_up') {
      out.push(`<div class="banner warn" role="status">${ICON.clock}<div><b>Время выбора вышло</b><span>${m.isHost ? 'Гости больше не могут добавлять блюда.' : 'Меню в режиме просмотра, пока хост не продлит время.'}</span></div>
        ${m.isHost ? '<button class="btn small" data-act="extend" data-min="5">+5 мин</button>' : ''}</div>`);
    }
    if (ss.phase === 'locked') {
      out.push(`<div class="banner lock" role="status">${ICON.lock}<div><b>${m.isHost ? 'Корзина заблокирована' : 'Хост оформляет заказ'}</b><span>${m.isHost ? 'Гости видят это и не могут менять заказ.' : 'Изменения закрыты.'}</span></div></div>`);
    }
    if (m.isHost && ss.unavailable > 0 && ss.phase !== 'locked') {
      out.push(`<div class="banner warn" role="status">${ICON.alert}<div><b>Есть недоступные блюда: ${ss.unavailable}</b><span>Замените их до оплаты.</span></div></div>`);
    }
    return out.join('');
  }

  function groupHtml(p, opts) {
    const { session: ss, me: m } = S.st;
    const mine = p.id === m.id;
    const can = m.canEdit && S.connected && (m.isHost || mine);
    const showCtl = (m.isHost || mine);
    const over = ss.limit && !p.isHost && p.subtotal > ss.limit;
    const left = ss.limit && !p.isHost ? ss.limit - p.subtotal : null;
    const sub = over ? '<small class="over">Выше лимита</small>'
      : left != null ? `<small>Осталось ${rub(left)} из ${rub(ss.limit)}</small>` : '';
    const items = p.items.map((it) => {
      const k = `${p.id}:${it.menuItemId}`;
      const age = Date.now() - (S.fresh.get(k) || 0);
      const fresh = age < 1500 ? ` fresh" style="animation-delay:-${age}ms` : '';
      return `<li class="item${showCtl ? '' : ' dim'}${fresh}"><span class="nm">${esc(it.name)}${it.unavailable ? ' <span class="tag bad">Нет в наличии</span>' : ''}<small>${it.qty} × ${rub(it.price)}</small></span>
        <span class="px">${rub(it.qty * it.price)}</span>${showCtl ? stepper(it.menuItemId, it.qty, p.id === m.id ? '' : p.id, can) : ''}</li>`;
    }).join('');
    const kick = m.isHost && !p.isHost && m.canEdit
      ? `<div class="g-foot"><button class="btn small danger" data-act="kick-open" data-pid="${p.id}">Исключить из заказа</button></div>` : '';
    return `<section class="group${mine ? ' mine' : ''}" aria-label="Заказ: ${esc(p.name)}">
      <div class="g-head">${avatar(p)}<div class="g-name"><b>${esc(p.name)}${p.isHost ? ' · хост' : ''}${mine && !p.isHost ? ' (вы)' : ''}</b>${sub}</div>
        ${p.done ? `<span class="done" title="Закончил выбор">${ICON.check}<span class="sr">Закончил выбор</span></span>` : ''}
        <span class="g-sum">${rub(p.subtotal)}</span></div>
      ${p.items.length ? `<ul class="items">${items}</ul>` : `<p class="g-empty">${mine ? 'Вы пока ничего не выбрали' : 'Пока ничего не выбрал'}</p>`}${opts && opts.kick === false ? '' : kick}</section>`;
  }

  function totalsHtml() {
    const ss = S.st.session;
    return `<dl class="totals"><div><dt>Блюда</dt><dd>${rub(ss.total)}</dd></div>
      <div><dt>Доставка</dt><dd>${rub(ss.deliveryFee)}</dd></div>
      ${ss.servicePct ? `<div><dt>Сервисный сбор ${ss.servicePct}%</dt><dd>${rub(ss.serviceFee)}</dd></div>` : ''}
      <div class="grand"><dt>Итого</dt><dd>${rub(ss.grandTotal)}</dd></div></dl>`;
  }

  function cartHtml() {
    const { session: ss, me: m, participants } = S.st;
    if (m.isHost) {
      if (ss.phase === 'waiting') {
        return `<main><div class="empty"><b>Пока никто не присоединился</b>Покажите QR-код друзьям или отправьте ссылку в чат.
          <div style="margin-top:16px"><button class="btn primary" data-act="invite">${ICON.qr} Показать QR</button></div></div>${participants.map((p) => groupHtml(p)).join('')}</main>`;
      }
      return `<main>${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
    }
    const tabs = `<div class="subtabs" role="tablist"><button role="tab" aria-selected="${S.tab === 'mine'}" data-act="tab" data-v="mine">Моё</button>
      <button role="tab" aria-selected="${S.tab === 'all'}" data-act="tab" data-v="all">Все</button></div>`;
    if (S.tab === 'mine') {
      const mineP = participants.find((p) => p.id === m.id);
      return `<main>${tabs}${mineP.items.length ? groupHtml(mineP) : '<div class="empty"><b>В корзине пусто</b>Выберите блюда в меню.</div>'}</main>`;
    }
    return `<main>${tabs}${participants.map((p) => groupHtml(p)).join('')}${totalsHtml()}</main>`;
  }

  function barHtml() {
    const { session: ss, me: m } = S.st;
    let inner;
    if (m.isHost) {
      inner = ss.phase === 'locked'
        ? `<button class="btn" data-act="unlock">Разблокировать</button><button class="btn primary" data-act="pay-open">Оплатить · ${rub(ss.grandTotal)}</button>`
        : `<div class="bar-total"><span>Итого с доставкой</span><b>${rub(ss.grandTotal)}</b></div>
           <button class="btn primary" data-act="lock-open"${ss.total ? '' : ' aria-disabled="true"'}>К оплате</button>`;
    } else if (S.view === 'menu') {
      inner = `<button class="btn primary" data-act="view" data-v="cart">Моя корзина · ${rub(mySubtotal())}</button>`;
    } else {
      inner = m.canEdit
        ? `<button class="btn" data-act="view" data-v="menu">В меню</button>
           <button class="btn primary" data-act="done">${m.done ? 'Вернуться к выбору' : 'Готово'}</button>`
        : '<button class="btn primary" data-act="view" data-v="menu">В меню</button>';
    }
    return `<footer class="bar"><div class="bar-in">${inner}</div></footer>`;
  }

  // ---------- H7 / G7: итог и Split Bill ----------
  function hostPaidHtml() {
    const { session: ss, settlement: rows } = S.st;
    const debts = rows.filter((r) => !r.isHost);
    const left = debts.filter((r) => r.status === 'owes').reduce((a, r) => a + r.amount, 0);
    return `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)} · заказ ${esc(ss.code)}</div><h1>${esc(ss.title)}</h1></div></header>
      <section class="final"><div class="sub">Оплачено</div><div class="big">${rub(ss.grandTotal)}</div>
        <div class="sub">Вернуть осталось: <b style="color:var(--ink)">${rub(left)}</b></div></section>
      <div class="stack">
        <ul class="split">${rows.map((r) => `<li><div class="who"><b>${esc(r.name)}${r.isHost ? ' · хост' : ''}</b>
          <small class="muted">блюда ${rub(r.itemsTotal)} + доставка и сервис ${rub(r.feesShare)}</small></div>
          <span class="amt">${rub(r.amount)}</span>
          ${r.isHost ? '<span class="tag">Ваша доля</span>' : `<button class="pill${r.status === 'paid' ? ' ok' : ''}" data-act="mark" data-pid="${r.pid}" data-v="${r.status === 'paid' ? 'owes' : 'paid'}" aria-pressed="${r.status === 'paid'}">${r.status === 'paid' ? 'Отдал' : 'Должен'}</button>
          ${r.status === 'owes' ? `<button class="btn small" data-act="remind" data-pid="${r.pid}">Напомнить</button>` : ''}`}</li>`).join('')}</ul>
        <button class="btn wide" data-act="copy-split">Скопировать расчёт</button>
        <button class="btn primary wide" data-act="finish-open">Завершить заказ</button></div>`;
  }

  function guestPaidHtml() {
    const { session: ss, settlement: rows, me: m } = S.st;
    const mine = rows.find((r) => r.pid === m.id);
    const p = S.st.participants.find((x) => x.id === m.id);
    const head = `<header class="top"><div class="top-t"><div class="rest">${esc(ss.restaurant.name)}</div><h1>${esc(ss.title)}</h1></div></header>`;
    if (!mine) {
      return `${head}<section class="final"><div class="big">Вы ничего не заказали</div><div class="sub">Платить не нужно.</div></section>${installLink()}`;
    }
    return `${head}<section class="final"><div class="sub">Ваша доля</div><div class="big">${rub(mine.amount)}</div>
        <div class="sub">${mine.status === 'paid' ? 'Хост отметил, что вы отдали' : `Переведите ${esc(ss.hostName)}`}</div></section>
      <div class="stack"><section class="group"><ul class="items">
        ${p.items.map((it) => `<li class="item"><span class="nm">${esc(it.name)}<small>${it.qty} × ${rub(it.price)}</small></span><span class="px">${rub(it.qty * it.price)}</span></li>`).join('')}
        <li class="item"><span class="nm">Доставка и сервис (ваша доля)</span><span class="px">${rub(mine.feesShare)}</span></li></ul></section>
        ${mine.status === 'owes' ? '<button class="btn primary wide" data-act="copy-amount">Скопировать сумму</button>' : ''}</div>${installLink()}`;
  }
  const installLink = () => '<p style="text-align:center"><a class="link" href="/host" data-act="install">Скачать приложение</a></p>';

  // ---------- Шторки ----------
  const limitTimerFields = (init) => `
    <label class="row"><span>Лимит на гостя</span><input type="checkbox" id="f-limit-on" role="switch" ${init.limit ? 'checked' : ''}></label>
    <div class="sub" id="f-limit-box" ${init.limit ? '' : 'hidden'}>
      <div class="inp"><input id="f-limit" type="number" inputmode="numeric" min="1" max="100000" value="${init.limit || ''}" placeholder="1500" aria-label="Лимит в рублях"><span>₽</span></div>
      <div class="chips">${[500, 1000, 1500, 2000].map((v) => `<button type="button" data-act="preset" data-for="f-limit" data-v="${v}">${v} ₽</button>`).join('')}</div></div>`;

  function openCreate() {
    openSheet('create', 'Новый групповой заказ', `<h2>Групповой заказ</h2>
      <form data-form="create" novalidate>
        <label class="f" for="f-name">Ваше имя</label>
        <input id="f-name" type="text" maxlength="24" value="${esc(store.get('go:hostname') || '')}" autocomplete="given-name" required>
        <label class="f" for="f-title" style="margin-top:14px">Название <span class="muted">(необязательно)</span></label>
        <input id="f-title" type="text" maxlength="60" placeholder="Обед в офисе">
        <div style="margin-top:8px">${limitTimerFields({})}
        <label class="row"><span>Таймер выбора</span><input type="checkbox" id="f-timer-on" role="switch"></label>
        <div class="sub" id="f-timer-box" hidden><div class="inp"><input id="f-timer" type="number" inputmode="numeric" min="1" max="240" placeholder="15" aria-label="Минут на выбор"><span>мин</span></div>
          <div class="chips">${[10, 15, 30].map((v) => `<button type="button" data-act="preset" data-for="f-timer" data-v="${v}">${v} мин</button>`).join('')}</div></div></div>
        <p class="err" id="ferr" role="alert"></p>
        <div class="acts"><button class="btn primary" type="submit" id="f-go">Создать ссылку</button></div></form>`);
  }

  function readFields() {
    const out = {};
    const num = (id) => { const v = document.getElementById(id).value.trim(); return v === '' ? NaN : Number(v); };
    out.limitRub = null; out.timerMin = null;
    if (document.getElementById('f-limit-on').checked) {
      out.limitRub = num('f-limit');
      if (!Number.isInteger(out.limitRub) || out.limitRub < 1 || out.limitRub > 100000) return { error: 'Укажите лимит от 1 до 100 000 ₽' };
    }
    const t = document.getElementById('f-timer-on');
    if (t && t.checked) {
      out.timerMin = num('f-timer');
      if (!Number.isInteger(out.timerMin) || out.timerMin < 1 || out.timerMin > 240) return { error: 'Укажите время от 1 до 240 минут' };
    }
    return out;
  }

  async function submitCreate() {
    const err = document.getElementById('ferr');
    const hostName = document.getElementById('f-name').value.trim();
    if (!hostName) { err.textContent = 'Введите ваше имя'; return; }
    const f = readFields();
    if (f.error) { err.textContent = f.error; return; }
    const body = { restaurantId: S.restaurant.id, hostName, limitRub: f.limitRub, timerMin: f.timerMin };
    const title = document.getElementById('f-title').value.trim();
    if (title) body.title = title;
    const btn = document.getElementById('f-go');
    btn.disabled = true; btn.textContent = 'Создаём…';
    try {
      const r = await fetch('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(String(r.status));
      const { code, hostToken } = await r.json();
      store.set('go:hostname', hostName);
      store.set('go:token:' + code, hostToken);
      S.code = code; S.token = hostToken; S.showInvite = true; S.view = 'menu';
      history.replaceState(null, '', '/host/' + code);
      closeSheet();
      connect();
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Создать ссылку';
      err.textContent = e.message === '429' ? 'Слишком много заказов за час, попробуйте позже' : 'Не удалось создать заказ. Проверьте соединение и повторите.';
    }
  }

  // H3: приглашение — QR и ссылка
  function openInvite() {
    const url = inviteUrl();
    let qr;
    try { qr = QR.svg(url, { margin: 2, dark: '#111', light: '#fff', label: 'QR-код со ссылкой на групповой заказ' }); } catch { qr = ''; }
    openSheet('invite', 'Пригласить друзей', `<h2>Пригласите друзей</h2>
      <div class="qr">${qr}</div>
      <div class="link-box"><code dir="ltr">${esc(url)}</code><button class="btn small" data-act="copy-link">Копировать</button></div>
      ${navigator.share ? '<button class="btn wide" data-act="share" style="margin-bottom:12px">Поделиться</button>' : ''}
      <p class="joined" id="joined"></p>
      <div class="acts"><button class="btn primary" data-act="close-sheet">Перейти к меню</button></div>`);
    updateInvite();
    // Экран не гаснет, пока QR на экране, — по возможности.
    if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').catch(() => {});
  }
  function updateInvite() {
    const el = document.getElementById('joined');
    if (!el || !S.st) return;
    const guests = S.st.participants.filter((p) => !p.isHost);
    el.innerHTML = `Присоединились: ${guests.length}` + (guests.length ? `<small>${guests.map((g) => esc(g.name)).join(', ')}</small>` : '<small>Покажите QR друзьям или отправьте ссылку в чат</small>');
  }

  function openSettings() {
    const ss = S.st.session;
    const timer = ss.deadlineAt
      ? `<p class="row" style="margin:0">Таймер: <span data-timer><span>${ss.phase === 'time_up' ? '00:00' : clockText(remaining())}</span></span></p>
         <div class="chips"><button data-act="extend" data-min="5">+5 мин</button><button data-act="extend" data-min="10">+10 мин</button><button data-act="timer-off">Выключить</button></div>`
      : `<div class="inp sub" style="display:flex;gap:10px;align-items:center"><input id="f-timer" type="number" inputmode="numeric" min="1" max="240" placeholder="15" aria-label="Минут на выбор"><span>мин</span>
         <button class="btn small" data-act="timer-on">Включить таймер</button></div>`;
    openSheet('settings', 'Настройки заказа', `<h2>Настройки заказа</h2>
      ${limitTimerFields({ limit: ss.limit ? ss.limit / 100 : 0 })}
      <p class="err" id="ferr" role="alert"></p>
      <button class="btn small" data-act="save-limit">Сохранить лимит</button>
      <hr style="border:0;border-top:1px solid var(--line);margin:18px 0">${timer}
      <div class="acts"><button class="btn danger" data-act="cancel-open">Отменить групповой заказ</button></div>`);
  }

  function confirmSheet(kind, title, text, okLabel, okAct, extra) {
    openSheet(kind, title, `<h2>${esc(title)}</h2><p>${text}</p>${extra || ''}
      <div class="acts"><button class="btn primary" data-act="${okAct}">${esc(okLabel)}</button><button class="btn" data-act="close-sheet">Отмена</button></div>`);
  }

  function openLimit(msg) {
    openSheet('limit', 'Лимит превышен', `<h2>Это превысит ваш лимит</h2>
      <p>Лимит на гостя — ${rub(msg.limit)}. Осталось ${rub(msg.remaining)}.</p>
      <div class="acts"><button class="btn primary" data-act="limit-ok">Выбрать другое</button></div>`);
  }

  // ---------- Действия ----------
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* нет доступа к буферу */ }
      ta.remove();
      return ok;
    }
  };

  function disabledReason() {
    if (!S.connected) return 'Нет связи. Пробуем подключиться…';
    const ph = S.st && S.st.session.phase;
    if (ph === 'locked') return 'Корзина заблокирована';
    if (ph === 'time_up') return 'Время выбора вышло';
    return 'Сейчас это недоступно';
  }

  const ACT = {
    'close-sheet': () => closeSheet(),
    'tip-close': () => { store.set('go:tip', '1'); render(); },
    'create-open': () => openCreate(),
    preset: (d) => { document.getElementById(d.for).value = d.v; },
    cat: (d) => { S.cat = d.v || null; render(); },
    view: (d) => { S.view = d.v; render(); window.scrollTo(0, 0); },
    tab: (d) => { S.tab = d.v; render(); },
    qty: (d) => {
      const msg = { t: 'set_item', menuItemId: Number(d.mid), qty: Number(d.qty) };
      if (d.pid) msg.targetId = Number(d.pid);
      send(msg);
    },
    done: () => { send({ t: 'set_done', done: !me().done }); if (!me().done) S.view = 'menu'; },
    'limit-ok': () => { closeSheet(); S.view = 'menu'; render(); },
    invite: () => openInvite(),
    'copy-link': async () => { toast((await copyText(inviteUrl())) ? 'Ссылка скопирована' : 'Не удалось скопировать'); send({ t: 'track', name: 'invite_shared' }); },
    share: () => { navigator.share({ title: S.st.session.title, text: 'Присоединяйтесь к заказу', url: inviteUrl() }).then(() => send({ t: 'track', name: 'invite_shared' })).catch(() => {}); },
    settings: () => openSettings(),
    'save-limit': () => {
      const f = readFields();
      if (f.error) { document.getElementById('ferr').textContent = f.error; return; }
      if (send({ t: 'settings', limitRub: f.limitRub })) { closeSheet(); toast('Лимит сохранён'); }
    },
    extend: (d) => { if (send({ t: 'extend', minutes: Number(d.min) })) toast(`Время продлено на ${d.min} мин`); },
    'timer-off': () => { send({ t: 'settings', timerMin: null }); closeSheet(); },
    'timer-on': () => {
      const v = Number(document.getElementById('f-timer').value);
      if (!Number.isInteger(v) || v < 1 || v > 240) { document.getElementById('ferr').textContent = 'Укажите время от 1 до 240 минут'; return; }
      send({ t: 'settings', timerMin: v }); closeSheet();
    },
    'kick-open': (d) => {
      const p = S.st.participants.find((x) => x.id === Number(d.pid));
      if (p) confirmSheet('kick', `Исключить ${p.name}?`, 'Его блюда будут удалены из общей корзины.', 'Исключить', 'kick', `<input type="hidden" id="kick-pid" value="${p.id}">`);
    },
    kick: () => { send({ t: 'kick', participantId: Number(document.getElementById('kick-pid').value) }); closeSheet(); },
    'lock-open': () => {
      const ss = S.st.session;
      if (!ss.total) return toast(ERR.cart_empty);
      const warn = ss.unavailable ? `<p style="color:var(--danger)"><b>В заказе есть недоступные блюда: ${ss.unavailable}.</b> Лучше заменить их до оплаты.</p>` : '';
      return confirmSheet('lock', 'Заблокировать корзину?', 'Гости больше не смогут менять заказ. Продолжить?', 'Заблокировать и оплатить', 'lock', warn);
    },
    lock: () => { closeSheet(); send({ t: 'lock' }); },
    unlock: () => send({ t: 'unlock' }),
    'pay-open': () => confirmSheet('pay', 'Оплатить заказ', `Сумма к оплате — <b>${rub(S.st.session.grandTotal)}</b>. В прототипе оплата имитируется: деньги не списываются.`, `Оплатить ${rub(S.st.session.grandTotal)}`, 'pay'),
    pay: () => { closeSheet(); send({ t: 'pay' }); },
    mark: (d) => send({ t: 'mark_debt', participantId: Number(d.pid), status: d.v }),
    remind: async (d) => {
      const r = S.st.settlement.find((x) => x.pid === Number(d.pid));
      const text = `${r.name}, привет! Заказ «${S.st.session.title}» оплачен. Твоя доля — ${rub(r.amount)}. Переведи, пожалуйста, ${S.st.session.hostName}.`;
      toast((await copyText(text)) ? 'Текст напоминания скопирован' : 'Не удалось скопировать');
    },
    'copy-split': async () => {
      const rows = S.st.settlement.filter((r) => !r.isHost);
      const text = `Заказ «${S.st.session.title}»: ${rub(S.st.session.grandTotal)}\n` + rows.map((r) => `${r.name}: ${rub(r.amount)}${r.status === 'paid' ? ' ✓' : ''}`).join('\n');
      toast((await copyText(text)) ? 'Расчёт скопирован' : 'Не удалось скопировать');
    },
    'copy-amount': async () => {
      const r = S.st.settlement.find((x) => x.pid === me().id);
      toast((await copyText(String(r.amount / 100))) ? 'Сумма скопирована' : 'Не удалось скопировать');
    },
    'finish-open': () => confirmSheet('finish', 'Завершить заказ?', 'Расчёт перестанет быть доступен гостям по ссылке.', 'Завершить', 'close'),
    'cancel-open': () => confirmSheet('cancel', 'Отменить групповой заказ?', 'Гости увидят, что заказ отменён. Корзина будет потеряна.', 'Отменить заказ', 'close'),
    close: () => { closeSheet(); send({ t: 'close' }); },
    install: () => send({ t: 'track', name: 'guest_app_install_tap' }),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'install') { ACT.install(); return; } // ссылка работает как обычно
    e.preventDefault();
    if (el.getAttribute('aria-disabled') === 'true') {
      toast(el.dataset.act === 'lock-open' ? ERR.cart_empty : disabledReason());
      return;
    }
    if (ACT[act]) ACT[act](el.dataset);
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-limit-on') document.getElementById('f-limit-box').hidden = !e.target.checked;
    if (e.target.id === 'f-timer-on') document.getElementById('f-timer-box').hidden = !e.target.checked;
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'nm') S.draftName = e.target.value; });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.form === 'create') submitCreate();
    if (form.dataset.form === 'join') {
      const name = document.getElementById('nm').value.trim();
      if (!name) { document.getElementById('nerr').textContent = 'Введите имя'; return; }
      send({ t: 'join', name });
    }
  });

  // ---------- Рендер и таймер ----------
  function render() {
    const y = window.scrollY;
    let html;
    if (S.fatal) html = fatalHtml();
    else if (S.role === 'host' && !S.code) html = hostHomeHtml();
    else if (!S.st) html = S.anon ? nameHtml() : '<p class="boot">Подключаемся…</p>';
    else html = sessionHtml();
    $app.innerHTML = html;
    window.scrollTo(0, y);
    if (S.sheet === 'invite') updateInvite();
    if (S.st && S.st.session.phase === 'paid' && !S.trackedPaid) { S.trackedPaid = true; send({ t: 'track', name: 'split_bill_viewed' }); }
    tickTimers();
  }

  function tickTimers() {
    const ss = S.st && S.st.session;
    if (!ss || !ss.deadlineAt) return;
    const rem = remaining();
    document.querySelectorAll('[data-timer]').forEach((el) => {
      const txt = el.querySelector('span');
      if (txt) txt.textContent = ss.phase === 'time_up' ? '00:00' : clockText(rem);
      el.classList.toggle('warn', ss.phase === 'time_up' || (rem <= 120000 && rem > 0));
    });
    if (ss.phase === 'selecting' && rem <= 120000 && rem > 0 && S.warned !== ss.deadlineAt) {
      S.warned = ss.deadlineAt;
      toast('Осталось 2 минуты');
      live('Осталось 2 минуты');
    }
  }
  setInterval(tickTimers, 1000);

  // ---------- Старт ----------
  render();
  if (S.role === 'host' && !S.code) {
    fetch('/api/restaurants/1/menu').then((r) => r.json()).then((d) => { S.menu = d.menu; S.restaurant = d.restaurant; render(); })
      .catch(() => { $app.innerHTML = '<p class="boot">Не удалось загрузить меню. Обновите страницу.</p>'; });
  } else if (S.code) {
    connect();
  }
})();
