(() => {
  const config = window.CSW_BOOKING;
  const frame = document.getElementById('csw-booking');
  if (!frame || !config) return;
  const date = new URLSearchParams(location.search).get('date') || '';
  const embedId = crypto.randomUUID();
  const calendarView = frame.dataset.view === 'calendar';
  const query =
    '?embedId=' +
    embedId +
    (calendarView ? '&view=calendar' : '') +
    (/^\d{4}-\d{2}-\d{2}$/.test(date) ? '&date=' + date : '');
  const live =
    /^https:\/\/script\.google\.com\/(?:a\/macros\/henricostudents\.org\/s|macros\/s)\/[\w-]+\/exec$/.test(
      config.webAppUrl
    );
  frame.src =
    (live
      ? config.webAppUrl
      : calendarView
        ? '../booking/Calendar.html'
        : '../booking/Widget.html') + query;
  const fallback = document.getElementById('csw-open-form');
  fallback.href = live ? config.webAppUrl + (calendarView ? '?view=calendar' : '') : frame.src;
  fallback.textContent = calendarView ? 'Open calendar in a new tab' : 'Open signup in a new tab';
  const notice = document.getElementById('csw-setup-notice');
  let connected = false;
  if (!live) notice.textContent = 'Local preview — reservations are not saved.';
  const connectionTimer = live
    ? setTimeout(() => {
        if (connected) return;
        frame.hidden = true;
        notice.hidden = false;
        notice.textContent =
          'Open the calendar below to sign in with your HCPS school account. Then refresh this page.';
      }, 10000)
    : null;
  window.addEventListener('message', (event) => {
    const trustedOrigin = live
      ? /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/.test(event.origin)
      : event.origin === location.origin;
    if (!trustedOrigin || !event.data || event.data.embedId !== embedId) return;
    if (calendarView && event.data.type === 'csw:manage') {
      location.href = 'CSW.html?manage=1#signup';
      return;
    }
    if (
      calendarView &&
      event.data.type === 'csw:date' &&
      /^\d{4}-\d{2}-\d{2}$/.test(event.data.date)
    ) {
      location.href = 'CSW.html?date=' + event.data.date + '#signup';
      return;
    }
    if (event.data.type !== 'csw:resize') return;
    const height = Number(event.data.height);
    if (Number.isFinite(height)) {
      frame.style.height = Math.min(5000, Math.max(600, height)) + 'px';
      // A Google sign-in/access-denied page also fires iframe load. Only the widget
      // knows this per-frame nonce and can confirm that the actual form rendered.
      connected = true;
      frame.hidden = false;
      clearTimeout(connectionTimer);
      if (live) notice.hidden = true;
    }
  });
  if (date)
    frame.addEventListener(
      'load',
      () => frame.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      { once: true }
    );
})();
