(() => {
  const config = window.CSW_BOOKING || {};
  if (!/^https:\/\/script\.google\.com\/(?:a\/macros\/henricostudents\.org\/s|macros\/s)\/[\w-]+\/exec$/.test(config.webAppUrl)) return;

  const signup = document.getElementById('csw-open-form');
  if (signup) {
    const url = new URL(config.webAppUrl);
    const params = new URLSearchParams(location.search);
    const date = params.get('date') || '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) url.searchParams.set('date', date);
    if (params.get('manage') === '1') url.searchParams.set('manage', '1');
    signup.href = url.href;
    if (params.get('manage') === '1') signup.textContent = 'Open organizer dashboard ↗';
  }

  const tutoring = document.getElementById('tutoring-open');
  if (tutoring) {
    tutoring.hidden = config.tutoringEnabled !== true;
    tutoring.href = config.webAppUrl + '?view=tutoring';
    if (tutoring.hidden) {
      const notice = document.getElementById('tutoring-notice');
      notice.hidden = false;
      notice.textContent = 'Tutoring signup is being set up. Email hcps-joshisr1@henricostudents.org for help.';
    }
  }
})();
