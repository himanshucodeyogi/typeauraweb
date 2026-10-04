// TypeAura Website — app.js

const BACKEND_URL = 'https://typeaurabackend.vercel.app';

async function loadStats() {
  if (!BACKEND_URL) return; // no backend yet — keep "—" placeholders

  try {
    const res = await fetch(`${BACKEND_URL}/api/public-stats`);
    if (!res.ok) return;
    const data = await res.json();

    // Expected response shape:
    // { total_installs: 124, active_users: 31, keyboard_sessions: 842,
    //   ai_actions: 219, countries: 14 }

    setStatValue('stat-installs', 'total_installs',    data, '+', 30);
    setStatValue('stat-active',   'active_users',      data, '+', 25);
    setStatValue('stat-sessions', 'keyboard_sessions', data);
    setStatValue('stat-ai',       'ai_actions',        data);
    // No floor: this one is a real count of distinct countries, and rounding it
    // up to a marketing minimum would be a claim rather than a stat.
    setStatValue('stat-countries', 'countries',        data);
  } catch (e) {
    // silent fail — placeholders remain
  }
}

function setStatValue(cardId, key, data, suffix = '', minVal = 0) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const el = card.querySelector('.stat-value');
  if (!el) return;
  const val = data[key];
  if (val === undefined || val === null) {
    /* The site and the backend deploy separately, so a card can outrun the
       field that feeds it. Hide it rather than leaving a permanent "—", which
       reads as "zero countries" instead of "not deployed yet"; the grid is
       auto-fit, so the remaining cards close the gap. A failed or non-OK fetch
       never reaches here — loadStats() returns first and the placeholders
       stay, which is the right look for a temporary outage. */
    card.hidden = true;
    return;
  }
  card.hidden = false;
  el.classList.remove('loading');
  animateCount(el, Math.max(val, minVal), suffix);
}

function formatNumber(n, suffix = '') {
  const str = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  return str + suffix;
}

function animateCount(el, target, suffix = '') {
  // null, not 0: a first frame stamped 0 would otherwise reset the start
  // on every frame and pin the count at zero forever.
  let start = null;
  const duration = 1200;
  const step = (timestamp) => {
    if (start === null) start = timestamp;
    const progress = Math.min((timestamp - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = Math.floor(eased * target);
    el.textContent = formatNumber(current, suffix);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = formatNumber(target, suffix);
  };
  requestAnimationFrame(step);
}

// Hamburger nav and smooth anchor scroll now live in the shared site.js
// so every page gets a working mobile menu, not just this one.

// ── Reveal on scroll ─────────────────────────────────────────────
// The hidden state lives in CSS behind .reveal-ready, which only JS adds —
// so with JS off (or this file failing to load) nothing is ever invisible.
(function initReveal() {
  const items = document.querySelectorAll('.reveal');
  if (!items.length || !('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  document.documentElement.classList.add('reveal-ready');
  items.forEach(el => io.observe(el));
})();

document.addEventListener('DOMContentLoaded', () => {
  // Add loading state to stat values
  document.querySelectorAll('.stat-value').forEach(el => el.classList.add('loading'));
  loadStats();
});

// ── Lightbox ─────────────────────────────────────────────────────
const lightbox      = document.getElementById('lightbox');
const lightboxImg   = document.getElementById('lightboxImg');
const lightboxLabel = document.getElementById('lightboxLabel');
const lightboxClose = document.getElementById('lightboxClose');

// Remembers where focus came from so closing can return it there, instead
// of dumping the visitor back to <body> to tab from the top again.
let lightboxOpener = null;

function openLightbox(trigger) {
  const img = trigger.querySelector('img');
  if (!img || !lightbox) return;
  // With <picture>, img.src resolves to the JPEG *fallback* (305–599 KB).
  // data-full points at the 1080w WebP the browser already knows how to
  // decode; currentSrc is the responsive candidate actually in use.
  lightboxImg.src = img.dataset.full || img.currentSrc || img.src;
  lightboxImg.alt = img.alt;
  lightboxLabel.textContent = trigger.dataset.label || '';
  lightboxOpener = trigger;
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
  lightboxClose?.focus();
}

// The zoomable phones are real <button>s, so Enter/Space come for free.
document.addEventListener('click', e => {
  const trigger = e.target.closest('.device--zoom');
  if (trigger) openLightbox(trigger);
});

function closeLightbox() {
  if (!lightbox?.classList.contains('open')) return;
  lightbox.classList.remove('open');
  document.body.style.overflow = '';
  lightboxOpener?.focus?.();
  lightboxOpener = null;
}

lightboxClose?.addEventListener('click', closeLightbox);

// Click outside image to close
lightbox?.addEventListener('click', e => {
  if (e.target === lightbox) closeLightbox();
});

// Escape closes; Tab is trapped. Only one focusable element lives inside the
// dialog, so the "trap" is simply refusing to let Tab leave it.
document.addEventListener('keydown', e => {
  if (!lightbox?.classList.contains('open')) return;
  if (e.key === 'Escape') { closeLightbox(); return; }
  if (e.key === 'Tab') {
    e.preventDefault();
    lightboxClose?.focus();
  }
});

// Scroll progress bar and back-to-top now live in the shared site.js,
// rAF-batched into a single frame instead of two unthrottled listeners.

// ── Active nav link (highlight current section) ──────────────────
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');
const navSections = document.querySelectorAll('main section[id]');

const navObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(l => l.classList.remove('active'));
      const link = document.querySelector(`.nav-links a[href="#${entry.target.id}"]`);
      link?.classList.add('active');
    }
  });
}, { rootMargin: '-30% 0px -60% 0px' });

navSections.forEach(s => navObserver.observe(s));


// ── Lazy video playback ──────────────────────────────────────────
// None of the <video> elements carry `autoplay`: with that attribute set,
// browsers fetch the media regardless of preload="none", putting ~1 MB on
// the LCP critical path. Instead we start them here, after load, only while
// they're actually on screen — and never for prefers-reduced-motion, where
// the poster is the whole experience.
(function initLazyVideo() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

  const start = () => {
    const videos = [...document.querySelectorAll('video[preload="none"]')];
    if (!videos.length) return;

    const pauseBtn = document.getElementById('heroPause');
    const heroVideo = document.getElementById('heroVideo');
    let userPaused = false;

    if (reduce.matches) {
      // Poster only. Leave the pause button hidden — nothing is moving.
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const v = entry.target;
        if (entry.isIntersecting) {
          if (v === heroVideo && userPaused) return;
          v.play?.().catch(() => {});
        } else {
          v.pause?.();
        }
      });
    }, { threshold: 0.5 });

    videos.forEach(v => io.observe(v));

    // WCAG 2.2.2 — the hero clip loops past 5s, so it needs a stop control.
    if (pauseBtn && heroVideo) {
      heroVideo.addEventListener('playing', () => { pauseBtn.hidden = false; }, { once: true });
      pauseBtn.addEventListener('click', () => {
        userPaused = !heroVideo.paused;
        if (userPaused) {
          heroVideo.pause();
          pauseBtn.setAttribute('aria-label', 'Play demo video');
          pauseBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-play"/></svg>';
        } else {
          heroVideo.play().catch(() => {});
          pauseBtn.setAttribute('aria-label', 'Pause demo video');
          pauseBtn.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-pause"/></svg>';
        }
      });
    }
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
