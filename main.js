/**
 * PORTFOLIO — MAIN.JS
 * Handles:
 *   - Custom cursor
 *   - Particle / star field canvas
 *   - D3 rotating wireframe globe
 *   - Counter animations
 *   - Rotating text descriptor
 *   - Scroll-based nav state & reveal animations
 *   - Skill bar fill on scroll
 *   - Project filter
 *   - Contact form validation
 *   - Mobile menu
 */

'use strict';

/* ================================================================
   1. UTILITY HELPERS
================================================================ */

/**
 * Throttle a function to fire at most once per `limit` ms.
 */
function throttle(fn, limit) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= limit) { last = now; fn.apply(this, args); }
  };
}

/**
 * Linear interpolation between a and b by t.
 */
function lerp(a, b, t) { return a + (b - a) * t; }

/* ================================================================
   2. CUSTOM CURSOR
================================================================ */
(function initCursor() {
  const cursor   = document.getElementById('cursor');
  const follower = document.getElementById('cursorFollower');
  if (!cursor || !follower) return;

  let mx = -100, my = -100;
  let fx = -100, fy = -100;
  let raf;

  // Track real mouse position
  document.addEventListener('mousemove', (e) => {
    mx = e.clientX;
    my = e.clientY;
  });

  // Cursor dot follows instantly; follower ring lerps
  function animateCursor() {
    cursor.style.transform   = `translate(${mx}px, ${my}px) translate(-50%, -50%)`;

    fx = lerp(fx, mx, 0.14);
    fy = lerp(fy, my, 0.14);
    follower.style.transform = `translate(${fx}px, ${fy}px) translate(-50%, -50%)`;

    raf = requestAnimationFrame(animateCursor);
  }
  raf = requestAnimationFrame(animateCursor);

  // Hide when leaving window
  document.addEventListener('mouseleave', () => {
    cursor.style.opacity   = '0';
    follower.style.opacity = '0';
  });
  document.addEventListener('mouseenter', () => {
    cursor.style.opacity   = '1';
    follower.style.opacity = '1';
  });
})();

/* ================================================================
   3. PARTICLE / STAR FIELD CANVAS
   Creates a depth-layered star field effect in the hero section.
================================================================ */
(function initParticles() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let W, H, stars = [];

  const NUM_STARS  = 160;
  const ACCENT_HEX = '#00e5ff';

  /** Resize canvas to fill its container */
  function resize() {
    W = canvas.width  = canvas.offsetWidth;
    H = canvas.height = canvas.offsetHeight;
    buildStars();
  }

  /** Create a star object with random properties */
  function createStar() {
    return {
      x:     Math.random() * W,
      y:     Math.random() * H,
      r:     Math.random() * 1.4 + 0.2,   // radius
      vx:    (Math.random() - 0.5) * 0.18, // horizontal drift
      vy:    (Math.random() - 0.5) * 0.18, // vertical drift
      alpha: Math.random() * 0.6 + 0.1,   // opacity
      // accent-coloured stars are rare
      accent: Math.random() < 0.06,
    };
  }

  function buildStars() {
    stars = Array.from({ length: NUM_STARS }, createStar);
  }

  /**
   * Draw connection lines between nearby stars.
   * Only connects pairs closer than `maxDist` pixels.
   */
  function drawConnections() {
    const maxDist = 120;
    for (let i = 0; i < stars.length; i++) {
      for (let j = i + 1; j < stars.length; j++) {
        const dx   = stars[i].x - stars[j].x;
        const dy   = stars[i].y - stars[j].y;
        const dist = Math.hypot(dx, dy);
        if (dist < maxDist) {
          const alpha = (1 - dist / maxDist) * 0.18;
          ctx.beginPath();
          ctx.moveTo(stars[i].x, stars[i].y);
          ctx.lineTo(stars[j].x, stars[j].y);
          ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
          ctx.lineWidth   = 0.5;
          ctx.stroke();
        }
      }
    }
  }

  /** Main animation loop */
  function tick() {
    ctx.clearRect(0, 0, W, H);
    drawConnections();

    for (const s of stars) {
      // Move
      s.x += s.vx;
      s.y += s.vy;

      // Wrap edges
      if (s.x < 0) s.x = W;
      if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H;
      if (s.y > H) s.y = 0;

      // Draw
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      const color = s.accent ? ACCENT_HEX : '#ffffff';
      ctx.fillStyle = `${color}${Math.round(s.alpha * 255).toString(16).padStart(2,'0')}`;
      ctx.fill();
    }

    requestAnimationFrame(tick);
  }

  window.addEventListener('resize', throttle(resize, 250));
  resize();
  tick();
})();

/* ================================================================
   4. D3 ROTATING WIREFRAME GLOBE
   Renders a dotted/wireframe Earth with auto-rotation and mouse drag.
   Based on the wireframe-dotted-globe component pattern.
================================================================ */
(function initGlobe() {
  const canvas = document.getElementById('globeCanvas');
  if (!canvas || typeof d3 === 'undefined') return;

  const ctx = canvas.getContext('2d');

  // Dimensions
  const SIZE   = canvas.parentElement.offsetWidth  || 600;
  const DPR    = window.devicePixelRatio || 1;
  const RADIUS = SIZE / 2.1;

  canvas.width         = SIZE * DPR;
  canvas.height        = SIZE * DPR;
  canvas.style.width   = SIZE + 'px';
  canvas.style.height  = SIZE + 'px';
  ctx.scale(DPR, DPR);

  // D3 orthographic projection
  const projection = d3.geoOrthographic()
    .scale(RADIUS)
    .translate([SIZE / 2, SIZE / 2])
    .clipAngle(90);

  const pathGen = d3.geoPath().projection(projection).context(ctx);

  // Globe state
  const rotation   = [0, -25, 0];
  let   autoRotate = true;
  let   landData   = null;
  const allDots    = [];

  /* ---- Point-in-polygon (ray casting) ---- */
  function pointInRing(point, ring) {
    let [px, py] = point, inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInFeature(point, feature) {
    const { type, coordinates } = feature.geometry;
    const polys = type === 'Polygon' ? [coordinates] : coordinates;
    for (const poly of polys) {
      if (pointInRing(point, poly[0])) {
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
          if (pointInRing(point, poly[h])) { inHole = true; break; }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }

  /** Generate a regular dot grid clipped to each land feature */
  function generateDots(feature, step = 3.2) {
    const [[minLng, minLat], [maxLng, maxLat]] = d3.geoBounds(feature);
    const dots = [];
    for (let lng = minLng; lng <= maxLng; lng += step) {
      for (let lat = minLat; lat <= maxLat; lat += step) {
        if (pointInFeature([lng, lat], feature)) dots.push([lng, lat]);
      }
    }
    return dots;
  }

  /** Full render pass */
  function render() {
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Ocean sphere
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, projection.scale(), 0, Math.PI * 2);
    ctx.fillStyle   = '#000000';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,229,255,0.25)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (!landData) return;

    // Graticule grid
    const graticule = d3.geoGraticule()();
    ctx.beginPath();
    pathGen(graticule);
    ctx.strokeStyle  = 'rgba(255,255,255,0.06)';
    ctx.lineWidth    = 0.5;
    ctx.stroke();

    // Land outlines
    ctx.beginPath();
    for (const f of landData.features) pathGen(f);
    ctx.strokeStyle = 'rgba(0,229,255,0.4)';
    ctx.lineWidth   = 0.7;
    ctx.stroke();

    // Dots on land
    for (const [lng, lat] of allDots) {
      const proj = projection([lng, lat]);
      if (!proj) continue;
      const [px, py] = proj;
      if (px < 0 || px > SIZE || py < 0 || py > SIZE) continue;
      ctx.beginPath();
      ctx.arc(px, py, 1.0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,229,255,0.65)';
      ctx.fill();
    }
  }

  /** Auto-rotation timer */
  const timer = d3.timer(() => {
    if (autoRotate) {
      rotation[0] += 0.22;
      projection.rotate(rotation);
      render();
    }
  });

  /** Mouse drag interaction */
  canvas.addEventListener('mousedown', (e) => {
    autoRotate = false;
    const sx = e.clientX, sy = e.clientY;
    const sr = [...rotation];

    function onMove(ev) {
      rotation[0] = sr[0] + (ev.clientX - sx) * 0.4;
      rotation[1] = Math.max(-80, Math.min(80, sr[1] - (ev.clientY - sy) * 0.4));
      projection.rotate(rotation);
      render();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      setTimeout(() => { autoRotate = true; }, 200);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  /* ---- Fetch GeoJSON land data ---- */
  fetch('https://raw.githubusercontent.com/martynafford/natural-earth-geojson/refs/heads/master/110m/physical/ne_110m_land.json')
    .then(r => r.json())
    .then(data => {
      landData = data;
      for (const f of data.features) {
        for (const pt of generateDots(f)) allDots.push(pt);
      }
      render();
    })
    .catch(() => {
      // Graceful fallback: render ocean + graticule without land data
      render();
    });

  // Clean up timer if needed (single-page app scenario)
  window.addEventListener('beforeunload', () => timer.stop());
})();

/* ================================================================
   5. ROTATING TEXT DESCRIPTOR
   Cycles through a list of descriptors with a typewriter effect.
================================================================ */
(function initRotatingText() {
  const el = document.getElementById('rotatingText');
  if (!el) return;

  const phrases = [
    'scalable backends',
    'real-time systems',
    'cloud infrastructure',
    'delightful UIs',
    'open-source tools',
    'distributed systems',
  ];

  let phraseIndex = 0;
  let charIndex   = 0;
  let deleting    = false;
  let timeout;

  function type() {
    const phrase   = phrases[phraseIndex];
    const displayed = deleting
      ? phrase.slice(0, charIndex - 1)
      : phrase.slice(0, charIndex + 1);

    el.textContent = displayed;

    deleting ? charIndex-- : charIndex++;

    let delay = deleting ? 40 : 80;

    if (!deleting && charIndex === phrase.length) {
      // Pause at end before deleting
      delay = 1800;
      deleting = true;
    } else if (deleting && charIndex === 0) {
      deleting     = false;
      phraseIndex  = (phraseIndex + 1) % phrases.length;
      delay        = 300;
    }

    timeout = setTimeout(type, delay);
  }

  // Start with a short delay
  timeout = setTimeout(type, 1400);
})();

/* ================================================================
   6. SCROLL-BASED NAV STATE
================================================================ */
(function initScrollNav() {
  const nav   = document.getElementById('nav');
  const links = document.querySelectorAll('.nav-link');

  // Section ids that map to nav links
  const sections = document.querySelectorAll('section[id]');

  function updateNav() {
    // Scrolled state
    if (window.scrollY > 60) nav.classList.add('scrolled');
    else                       nav.classList.remove('scrolled');

    // Active link
    let current = '';
    for (const section of sections) {
      if (window.scrollY >= section.offsetTop - 120) {
        current = section.id;
      }
    }
    for (const link of links) {
      link.classList.toggle('active', link.getAttribute('href') === `#${current}`);
    }
  }

  window.addEventListener('scroll', throttle(updateNav, 80), { passive: true });
  updateNav();
})();

/* ================================================================
   7. MOBILE MENU
================================================================ */
(function initMobileMenu() {
  const hamburger  = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobileMenu');
  if (!hamburger || !mobileMenu) return;

  function toggle(open) {
    hamburger.classList.toggle('open',   open);
    mobileMenu.classList.toggle('open',  open);
    mobileMenu.setAttribute('aria-hidden', String(!open));
    hamburger.setAttribute('aria-expanded',  String(open));
    document.body.style.overflow = open ? 'hidden' : '';
  }

  hamburger.addEventListener('click', () => {
    toggle(!mobileMenu.classList.contains('open'));
  });

  // Close on link click
  mobileMenu.querySelectorAll('.mobile-link').forEach(link => {
    link.addEventListener('click', () => toggle(false));
  });
})();

/* ================================================================
   8. INTERSECTION OBSERVER — Scroll Reveal & Skill Bars
================================================================ */
(function initScrollReveal() {
  // General reveal-up elements
  const revealEls = document.querySelectorAll('.reveal-up');
  const revealObs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        revealObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  revealEls.forEach(el => revealObs.observe(el));

  // Skill category cards — triggers bar fill
  const skillCats = document.querySelectorAll('.skill-category');
  const skillObs  = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        skillObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2 });

  skillCats.forEach(cat => skillObs.observe(cat));

  // About visual reveal
  const aboutVis = document.querySelector('.about-visual');
  if (aboutVis) {
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { aboutVis.classList.add('in-view'); obs.disconnect(); }
    }, { threshold: 0.2 });
    obs.observe(aboutVis);
  }
})();

/* ================================================================
   9. COUNTER ANIMATION (Hero stats)
   Counts up from 0 to target when the stat section scrolls into view.
================================================================ */
(function initCounters() {
  const stats = document.querySelectorAll('.stat-number');
  if (!stats.length) return;

  /**
   * Animates a number from 0 → target over `duration` ms
   * using requestAnimationFrame for smooth easing.
   */
  function animateCount(el, target, duration = 1400) {
    const startTime = performance.now();

    function update(now) {
      const elapsed  = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased    = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.floor(eased * target);
      if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const target = parseInt(entry.target.dataset.target, 10);
        animateCount(entry.target, target);
        obs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  stats.forEach(el => obs.observe(el));
})();

/* ================================================================
   10. PROJECT FILTER
================================================================ */
(function initProjectFilter() {
  const filterBtns = document.querySelectorAll('.filter-btn');
  const cards      = document.querySelectorAll('.project-card');
  if (!filterBtns.length) return;

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.filter;

      // Update active state & aria
      filterBtns.forEach(b => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-selected', String(b === btn));
      });

      // Show / hide cards
      cards.forEach(card => {
        const show = filter === 'all' || card.dataset.category === filter;
        card.classList.toggle('hidden', !show);

        // Re-apply featured layout only when 'all' is selected
        if (card.classList.contains('project-card--featured')) {
          card.style.gridColumn = (filter === 'all' && show) ? '1 / -1' : '';
        }
      });
    });
  });
})();

/* ================================================================
   11. CONTACT FORM VALIDATION
================================================================ */
(function initContactForm() {
  const form       = document.getElementById('contactForm');
  const submitBtn  = document.getElementById('submitBtn');
  const successMsg = document.getElementById('formSuccess');
  if (!form) return;

  /** Validate a single input and show/clear its error message */
  function validateField(input) {
    const group  = input.closest('.form-group');
    const errEl  = group ? group.querySelector('.form-error') : null;
    let   message = '';

    if (input.required && !input.value.trim()) {
      message = 'This field is required.';
    } else if (input.type === 'email' && input.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value)) {
      message = 'Please enter a valid email address.';
    }

    input.classList.toggle('error', !!message);
    if (errEl) errEl.textContent = message;
    return !message;
  }

  // Validate on blur
  form.querySelectorAll('.form-input').forEach(input => {
    input.addEventListener('blur', () => validateField(input));
    input.addEventListener('input', () => {
      // Clear error on typing
      if (input.classList.contains('error')) validateField(input);
    });
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const inputs   = form.querySelectorAll('.form-input');
    let   allValid = true;
    inputs.forEach(input => { if (!validateField(input)) allValid = false; });

    if (!allValid) return;

    // Simulate async send
    const label = submitBtn.querySelector('.btn-label');
    label.textContent = 'Sending…';
    submitBtn.disabled = true;

    setTimeout(() => {
      form.querySelectorAll('.form-group').forEach(g => { g.style.display = 'none'; });
      submitBtn.style.display = 'none';
      successMsg.hidden       = false;
    }, 1200);
  });
})();

/* ================================================================
   12. SMOOTH SCROLL for anchor links (fallback for older browsers)
================================================================ */
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', (e) => {
    const target = document.querySelector(link.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ================================================================
   13. PARALLAX — subtle depth on globe container
================================================================ */
(function initParallax() {
  const globe = document.querySelector('.globe-container');
  if (!globe) return;

  window.addEventListener('scroll', throttle(() => {
    const y = window.scrollY;
    // Gentle upward offset as user scrolls down
    globe.style.transform = `translateY(calc(-50% + ${y * 0.12}px))`;
  }, 16), { passive: true });
})();

/* ================================================================
   14. 3D SCROLL CONTAINER ANIMATION
   Mirrors the Framer Motion ContainerScroll component logic:
   - Reads scrollYProgress through the sentinel section
   - Maps [0 → 1] scroll progress to:
       rotateX: 20deg → 0deg   (card tilts flat)
       scale:   1.05  → 1.00   (card shrinks slightly)
       translateY of header: 0 → -100px
   Uses requestAnimationFrame for silky 60fps updates.
================================================================ */
(function initScrollContainer() {
  const section  = document.getElementById('scrollShowcase');
  const card     = document.getElementById('scCard');
  const header   = document.getElementById('scHeader');
  if (!section || !card || !header) return;

  const isMobile = () => window.innerWidth <= 768;

  /**
   * Linear map: input value `t` in [inMin, inMax] → [outMin, outMax]
   * Clamped at both ends.
   */
  function mapRange(t, inMin, inMax, outMin, outMax) {
    const clamped = Math.max(inMin, Math.min(inMax, t));
    return outMin + ((clamped - inMin) / (inMax - inMin)) * (outMax - outMin);
  }

  function update() {
    const rect        = section.getBoundingClientRect();
    const sectionH    = section.offsetHeight;
    const viewH       = window.innerHeight;

    // scrollYProgress: 0 when section top hits viewport top,
    //                  1 when section bottom hits viewport bottom
    const scrolled    = -rect.top;                       // px scrolled into section
    const scrollRange = sectionH - viewH;                // total scrollable distance
    const progress    = Math.max(0, Math.min(1, scrolled / scrollRange));

    // --- Card ---
    const rotateX = mapRange(progress, 0, 1, 20, 0);     // 20° → 0°
    const scaleRange = isMobile() ? [0.7, 0.9] : [1.05, 1.0];
    const scale   = mapRange(progress, 0, 1, scaleRange[0], scaleRange[1]);

    card.style.transform = `rotateX(${rotateX}deg) scale(${scale})`;

    // --- Header translate ---
    const translateY = mapRange(progress, 0, 1, 0, -100);  // 0 → -100px
    header.style.transform = `translateY(${translateY}px)`;
  }

  // Run on every scroll event (throttled to rAF cadence)
  let rafQueued = false;
  window.addEventListener('scroll', () => {
    if (!rafQueued) {
      rafQueued = true;
      requestAnimationFrame(() => { update(); rafQueued = false; });
    }
  }, { passive: true });

  // Also run on resize (isMobile changes scale range)
  window.addEventListener('resize', throttle(update, 150));

  // Initial paint
  update();
})();

/* ================================================================
   15. BACKGROUND PATHS ANIMATION
   Faithful recreation of the Framer Motion FloatingPaths component.

   The original component generates 36 paths per "position" value
   (+1 and -1), using this formula for each path i:
     d = `M-${380 - i*5*pos} -${189 + i*6}
          C-${380 - i*5*pos} -${189 + i*6}
            -${312 - i*5*pos} ${216 - i*6}
            ${152 - i*5*pos} ${343 - i*6}
          C${616 - i*5*pos} ${470 - i*6}
            ${684 - i*5*pos} ${875 - i*6}
            ${684 - i*5*pos} ${875 - i*6}`

   Framer animates:
     - pathLength: 0.3 → 1 (stroke-dasharray trick)
     - opacity: 0.3 → 0.6 → 0.3 (pulse)
     - pathOffset: 0 → 1 → 0 (flowing motion along the path)
     duration: 20–30s, repeat infinite, ease linear

   We replicate this using the Web Animations API (WAAPI)
   which is supported in all modern browsers.
================================================================ */
(function initBackgroundPaths() {
  const group = document.getElementById('bgPathsGroup');
  if (!group) return;

  const NUM_PATHS   = 36;    // paths per position set
  const POSITIONS   = [1, -1]; // two mirrored sets

  /**
   * Build the cubic-bezier path string for path index i and
   * position multiplier pos — exact port of the React formula.
   */
  function buildPathD(i, pos) {
    const a = 380 - i * 5 * pos;
    const b = 189 + i * 6;
    const c = 312 - i * 5 * pos;
    const d = 216 - i * 6;
    const e = 152 - i * 5 * pos;
    const f = 343 - i * 6;
    const g = 616 - i * 5 * pos;
    const h = 470 - i * 6;
    const j = 684 - i * 5 * pos;
    const k = 875 - i * 6;
    return `M-${a} -${b} C-${a} -${b} -${c} ${d} ${e} ${f} C${g} ${h} ${j} ${k} ${j} ${k}`;
  }

  /**
   * Approximate the total arc length of a cubic bezier curve
   * by sampling it at N points and summing chord lengths.
   * This lets us set correct stroke-dasharray values.
   */
  function approxPathLength(d, samples = 80) {
    // Create a temporary SVG path to measure
    const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tmp.setAttribute('d', d);
    // Append temporarily to get getTotalLength()
    document.body.appendChild(tmp);
    const len = tmp.getTotalLength();
    document.body.removeChild(tmp);
    return len;
  }

  // Build and animate all paths
  POSITIONS.forEach(pos => {
    for (let i = 0; i < NUM_PATHS; i++) {
      const d       = buildPathD(i, pos);
      const opacity = 0.1 + i * 0.03;    // matches strokeOpacity in original
      const width   = 0.5 + i * 0.03;    // matches strokeWidth in original

      // Create SVG path element
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(width));
      path.setAttribute('fill', 'none');
      path.classList.add('bp-path');

      group.appendChild(path);

      // Measure the path's total length for dash calculations
      const totalLen = path.getTotalLength();
      if (!totalLen || totalLen === 0) continue;

      // pathLength in Framer: 0.3 → 1
      // We represent this as stroke-dasharray: [visibleLen, totalLen]
      // pathOffset: 0 → 1 → 0 maps to stroke-dashoffset travelling totalLen
      const visibleLen = totalLen * 0.3;  // initial "pathLength: 0.3"

      // Set up dash — dasharray = [visible segment, gap]
      path.style.strokeDasharray  = `${visibleLen} ${totalLen}`;
      path.style.strokeDashoffset = `${totalLen}`;  // start hidden

      // Duration: 20–30s with deterministic variation per path
      const duration = (20 + (i * 7 + (pos === 1 ? 0 : 13)) % 11) * 1000;

      // ---- WAAPI animation ----
      // Phase 1: dash flows along the path (stroke-dashoffset: totalLen → 0 → -totalLen)
      // Phase 2: opacity pulses 0.3 → 0.6 → 0.3
      // Both run simultaneously, looped infinitely.

      path.animate(
        [
          { strokeDashoffset: totalLen,      opacity: opacity * 0.5 },
          { strokeDashoffset: 0,             opacity: opacity,       offset: 0.5 },
          { strokeDashoffset: -totalLen,     opacity: opacity * 0.5 },
        ],
        {
          duration,
          iterations: Infinity,
          easing: 'linear',
          delay: -(duration * (i / NUM_PATHS)),  // stagger start so they're not in sync
        }
      );
    }
  });

  // The SVG uses currentColor — make the hero text colour drive the stroke
  // In dark mode hero the text is white; we want cyan tones, so override:
  const svg = document.querySelector('.bg-paths-svg');
  if (svg) svg.style.color = 'rgba(0, 229, 255, 1)';
})();
