// דור קנה — portfolio. Content lives in data.js; this file only draws it.
(function () {
  const S = window.SITE;
  const $ = (s) => document.querySelector(s);
  const thumb = (id, w) => 'https://drive.google.com/thumbnail?id=' + id + '&sz=w' + (w || 640);
  const LOCAL = { showcase: { t: 'שואוקייס — דור קנה', src: 'media/showcase.mp4' } };

  // ---------------- player (Google Drive preview for works, local file for the showcase)
  let list = [], idx = 0;
  function open(items, i) {
    list = items; idx = i;
    show();
    $('#player').hidden = false;
    document.body.style.overflow = 'hidden';
    const v = $('#heroVideo'); if (v) v.pause();
  }
  function show() {
    const it = list[idx];
    $('#playerTitle').textContent = it.t;
    const f = $('#frame');
    f.innerHTML = '';
    if (it.src) {
      const v = document.createElement('video');
      v.src = it.src; v.controls = true; v.autoplay = true; v.playsInline = true;
      f.appendChild(v);
    } else {
      const fr = document.createElement('iframe');
      fr.src = 'https://drive.google.com/file/d/' + it.id + '/preview';
      fr.allow = 'autoplay; fullscreen'; fr.allowFullscreen = true;
      f.appendChild(fr);
    }
    $('#prevBtn').style.visibility = $('#nextBtn').style.visibility = list.length > 1 ? 'visible' : 'hidden';
  }
  function close() {
    $('#player').hidden = true; $('#frame').innerHTML = '';
    document.body.style.overflow = '';
    const v = $('#heroVideo'); if (v && !$('#page-home').hidden) v.play().catch(() => {});
  }
  $('#closeBtn').onclick = close;
  $('#player').addEventListener('click', (e) => { if (e.target.id === 'player') close(); });
  $('#nextBtn').onclick = () => { idx = (idx + 1) % list.length; show(); };
  $('#prevBtn').onclick = () => { idx = (idx - 1 + list.length) % list.length; show(); };
  document.addEventListener('keydown', (e) => {
    if ($('#player').hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') $('#nextBtn').click();
    if (e.key === 'ArrowRight') $('#prevBtn').click();
  });
  document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.play;
    if (k === 'tdreel') open([S.reel], 0); else open([LOCAL[k]], 0);
  }));

  // ---------------- cards
  function card(it, items, i, big) {
    const b = document.createElement('button');
    b.className = 'card fade';
    b.style.animationDelay = Math.min(i * 25, 500) + 'ms';
    const img = new Image();
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = it.t;
    img.src = thumb(it.id, big ? 960 : 560);
    img.onerror = () => { img.style.visibility = 'hidden'; };
    b.appendChild(img);
    b.insertAdjacentHTML('beforeend', '<span class="playi"></span><span class="cap"></span>');
    b.querySelector('.cap').textContent = it.t;
    b.onclick = () => open(items, i);
    return b;
  }

  // TouchDesigner page with simple filters
  const FILTERS = [
    ['sel', 'נבחרות', (x) => x.sel],
    ['all', 'הכל', () => true],
    ['sound', 'מגיב לסאונד', (x) => x.tag === 'sound'],
    ['abstract', 'אבסטרקט', (x) => x.tag === 'abstract'],
  ];
  let filter = 'sel';
  function drawTd() {
    const chips = $('#tdChips'); chips.innerHTML = '';
    for (const [k, label, fn] of FILTERS) {
      const c = document.createElement('button');
      c.className = 'chip' + (k === filter ? ' on' : '');
      c.innerHTML = label + '<span class="n"></span>';
      c.querySelector('.n').textContent = S.td.filter(fn).length;
      c.onclick = () => { filter = k; drawTd(); };
      chips.appendChild(c);
    }
    const fn = FILTERS.find((f) => f[0] === filter)[2];
    const items = S.td.filter(fn);
    const g = $('#tdGrid'); g.innerHTML = '';
    items.forEach((it, i) => g.appendChild(card(it, items, i)));
  }
  function drawVideo() {
    const films = S.films.filter((f) => f.kind === 'film'), shorts = S.films.filter((f) => f.kind !== 'film');
    const fg = $('#filmGrid'), sg = $('#shortGrid'); fg.innerHTML = sg.innerHTML = '';
    films.forEach((it, i) => fg.appendChild(card(it, films, i, true)));
    shorts.forEach((it, i) => sg.appendChild(card(it, shorts, i, true)));
  }
  function drawChoices() {
    const pick = (arr, n) => arr.slice(0, n);
    const td = pick(S.td.filter((x) => x.sel), 6), vid = pick(S.films, 6);
    for (const [el, arr] of [['#choiceTd', td], ['#choiceVideo', vid]]) {
      const box = $(el);
      arr.forEach((it) => { const im = new Image(); im.loading = 'lazy'; im.alt = ''; im.onerror = () => { im.style.visibility = 'hidden'; }; im.src = thumb(it.id, 480); box.appendChild(im); });
    }
  }

  // ---------------- routing (#/touchdesigner, #/video, #/contact)
  const pages = ['home', 'touchdesigner', 'video', 'contact'];
  let drawn = {};
  function route() {
    const h = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
    if (h === 'choose') return;
    const p = pages.includes(h) ? h : 'home';
    pages.forEach((x) => { $('#page-' + x).hidden = x !== p; });
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === p));
    if (p === 'touchdesigner' && !drawn.td) { drawTd(); drawn.td = 1; }
    if (p === 'video' && !drawn.video) { drawVideo(); drawn.video = 1; }
    const v = $('#heroVideo');
    if (p === 'home') v.play().catch(() => {}); else v.pause();
    window.scrollTo(0, 0);
    solid();
  }
  function solid() { $('#top').classList.toggle('solid', window.scrollY > 40 || $('#page-home').hidden); }
  window.addEventListener('scroll', solid, { passive: true });
  window.addEventListener('hashchange', route);
  $('#year').textContent = new Date().getFullYear();
  drawChoices();
  route();
})();
