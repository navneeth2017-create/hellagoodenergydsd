const fs = require('fs');
const server = fs.readFileSync('C:/Users/navne/code/hellagoodenergydsd/server.js', 'utf8');

const oldRoute = `// The DSD landing.
  app.get('/', async (req, res) => {
    const sid = typeof req.query.session_id === 'string' && SESSION_ID_RE.test(req.query.session_id) ? req.query.session_id : '';
    if (req.query.checkout === 'success') return res.redirect(302, '/success' + (sid ? \`?session_id=${sid}\` : ''));
    if (req.query.checkout === 'cancelled') return res.redirect(302, '/portal');
    const session = auth.readSession(req);
    const pct = await getWholesalePct();
    const boxHtml = pricing.FLAVORS.map(f => {
      const avif = f.image.replace(/\\.webp$/, '.avif');
      const boxAvif = f.boxImage ? f.boxImage.replace(/\\.webp$/, '.avif') : avif;
      return \`<article class="product-card box-card" data-card="${f.id}">
        <div class="box-img-wrap">
          <div class="dual-img">
            <picture><source type="image/avif" srcset="${avif}"><img src="${f.image}" alt="${f.name} pack" loading="lazy" class="pack-img"></picture>
            <span class="img-label">Pack</span>
            \${f.boxImage ? \`<picture><source type="image/avif" srcset="${boxAvif}"><img src="${f.boxImage}" alt="${f.name} box" loading="lazy" class="box-img"></picture><span class="img-label">Box (15 packs)</span>\` : ''}
          </div>
        </div>
        <h3>\${f.name}</h3>
        <p class="wprice"><b>\${pricing.formatCents(pricing.boxCentsFor(pct))}</b> / box <small>(\${pricing.PACKS_PER_BOX} packs)</small></p>
        <p class="wprice-sub">\${pricing.formatCents(pricing.PACKS_PER_BOX * pricing.BASE_UNIT_CENTS)} retail &middot; \${pct}% off</p>
        <div class="buy-row">
          <div class="stepper"><button type="button" data-dec="${f.id}" aria-label="Decrease \${f.name} boxes">&minus;</button>
          <input type="number" inputmode="numeric" min="0" max="\${pricing.MAX_BOXES_PER_FLAVOR}" value="0" data-qty="${f.id}" aria-label="\${f.name} boxes">
          <button type="button" data-inc="${f.id}" aria-label="Increase \${f.name} boxes">+</button></div>
          <button type="button" class="btn btn-red" data-add="${f.id}">Add box</button>
        </div>
        <p class="packs-under">&nbsp;</p>
      </article>\`;`
    }).join('');
    sendPage(req, res, '/', {
      vars: {
        SESSION: session ? '1' : '',
        WHOLESALE_PCT: String(pct),
        WHOLESALE_UNIT: pricing.formatCents(pricing.wholesaleUnitCentsFor(pct)),
        BOX_PRICE: pricing.formatCents(pricing.boxCentsFor(pct)),
        DISPLAY_PRICE: pricing.formatCents(pricing.displayCentsFor(pct)),
        PACKS_PER_BOX: String(pricing.PACKS_PER_BOX),
        PACKS_PER_DISPLAY: String(pricing.PACKS_PER_DISPLAY),
        LINEUP_BOXES_HTML: boxHtml,
        HEADER_NAV: '<a class="dsd-link" href="/apply">Apply</a><a class="btn btn-red" style="padding:9px 18px;font-size:14px;" href="/login">DSD Login</a>',
      },
    });
  });`;

const newRoute = `// The DSD landing.
  app.get('/', async (req, res) => {
    const sid = typeof req.query.session_id === 'string' && SESSION_ID_RE.test(req.query.session_id) ? req.query.session_id : '';
    if (req.query.checkout === 'success') return res.redirect(302, '/success' + (sid ? \`?session_id=${sid}\` : ''));
    if (req.query.checkout === 'cancelled') return res.redirect(302, '/portal');
    const session = auth.readSession(req);
    const pct = await getWholesalePct();
    const flavors = pricing.FLAVORS.map(f => {
      const avif = f.image.replace(/\\.webp$/, '.avif');
      const boxAvif = f.boxImage ? f.boxImage.replace(/\\.webp$/, '.avif') : avif;
      return {
        id: f.id,
        name: f.name,
        image: f.image,
        avif,
        boxImage: f.boxImage,
        boxAvif,
      };
    });
    sendPage(req, res, '/', {
      vars: {
        SESSION: session ? '1' : '',
        WHOLESALE_PCT: String(pct),
        WHOLESALE_UNIT: pricing.formatCents(pricing.wholesaleUnitCentsFor(pct)),
        BOX_PRICE: pricing.formatCents(pricing.boxCentsFor(pct)),
        DISPLAY_PRICE: pricing.formatCents(pricing.displayCentsFor(pct)),
        PACKS_PER_BOX: String(pricing.PACKS_PER_BOX),
        PACKS_PER_DISPLAY: String(pricing.PACKS_PER_DISPLAY),
        FLAVORS: JSON.stringify(flavors),
        HEADER_NAV: '<a class="dsd-link" href="/apply">Apply</a><a class="btn btn-red" style="padding:9px 18px;font-size:14px;" href="/login">DSD Login</a>',
      },
    });
  });`;

if (server.includes(oldRoute)) {
  const updated = server.replace(oldRoute, newRoute);
  fs.writeFileSync('C:/Users/navne/code/hellagoodenergydsd/server.js', updated);
  console.log('Fixed!');
} else {
  console.log('Old route not found, checking current...');
  const idx = server.indexOf("app.get('/', async (req, res) => {");
  if (idx >= 0) {
    console.log(server.substring(idx, idx + 500));
  }
}