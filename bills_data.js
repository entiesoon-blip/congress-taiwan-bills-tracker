// Constituent Address Lookup & Filter Patch for 119th Congress Taiwan Bills Tracker
window.addEventListener('DOMContentLoaded', function() {
  if (typeof state === 'undefined') return;
  state.addressInput = state.addressInput || '';
  state.addressLoading = false;
  state.addressError = '';
  state.addressResult = null;

  const FIPS_TO_STATE = {
    '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
    '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
    '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
    '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
    '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
    '56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'
  };

  function extractDistrictNumber(cdObj) {
    if (!cdObj) return 'At Large';
    const dynamicCdKey = Object.keys(cdObj).find(k => /^CD\d+$/i.test(k));
    let raw = (dynamicCdKey && cdObj[dynamicCdKey]) || cdObj.CD120 || cdObj.CD119 || cdObj.CD118 || cdObj.CD117 || cdObj.CD || cdObj.BASENAME || '';
    raw = String(raw).trim();
    if (!raw || raw === '00' || raw === '98' || /at\s*large|delegate|resident/i.test(raw)) return 'At Large';
    const numMatch = raw.match(/^\d+$/);
    if (numMatch) {
      const stripped = raw.replace(/^0+/, '');
      return stripped || 'At Large';
    }
    return raw;
  }

  window.getFilteredLegislators = function() {
    if (!state.data) return [];
    const q = (state.legSearch || '').trim().toLowerCase();
    const matchedIds = state.addressResult
      ? new Set([
          ...(state.addressResult.senators || []).map(s => s.id),
          ...(state.addressResult.rep ? [state.addressResult.rep.id] : [])
        ])
      : null;

    return state.data.legislators.filter(l => {
      if (matchedIds && !matchedIds.has(l.id)) return false;
      if (state.legChamberFilter !== 'ALL' && l.chamber !== state.legChamberFilter) return false;
      if (state.legPartyFilter !== 'ALL' && l.party !== state.legPartyFilter) return false;
      if (state.legStateFilter !== 'ALL' && l.state !== state.legStateFilter) return false;
      if (state.legActivityFilter === 'ACTIVE' && l.totalInvolvement === 0) return false;
      if (state.legActivityFilter === 'ZERO' && l.totalInvolvement > 0) return false;
      if (state.legCaucusFilter === 'MEMBER' && !['Member', 'Co-Chair'].includes(l.caucusStatus)) return false;
      if (state.legCaucusFilter === 'NON_MEMBER' && ['Member', 'Co-Chair'].includes(l.caucusStatus)) return false;
      if (q) {
        const distStr = l.district ? `${l.state}-${l.district} ${l.state} ${l.district}` : l.state;
        const hay = `${l.displayName} ${l.name} ${l.state} ${distStr} ${l.party}-${l.state} ${l.caucusStatus || ''} ${l.sponsoredBills.join(' ')} ${l.cosponsoredBills.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  };

  window.lookupByAddress = function(addrStr) {
    const q = (addrStr !== undefined ? addrStr : state.addressInput).trim();
    state.addressInput = q;
    if (!q) {
      state.addressError = 'Please enter a full U.S. street address (e.g., "350 Fifth Ave, New York, NY 10118") or State-District (e.g., "CA-40" or "NY-17").';
      state.addressResult = null;
      render();
      return;
    }

    const sdMatch = q.match(/^([A-Za-z]{2})[\s\-]+(\d+|At[\s\-]?Large)$/i);
    if (sdMatch) {
      const st = sdMatch[1].toUpperCase();
      const rawDist = sdMatch[2];
      const dist = /^0$|^at/i.test(rawDist) ? 'At Large' : rawDist.replace(/^0+/, '');
      const senators = state.data.legislators.filter(l => l.state === st && l.chamber === 'Senate' && l.caucusStatus !== 'Former / 119th');
      const rep = state.data.legislators.find(l => l.state === st && l.chamber === 'House' && String(l.district) === String(dist) && l.caucusStatus !== 'Former / 119th');
      if (senators.length || rep) {
        state.addressLoading = false;
        state.addressError = '';
        state.addressResult = { matchedAddress: `${st} Congressional District ${dist}`, state: st, district: dist, senators, rep: rep || null };
        render();
        return;
      }
    }

    state.addressLoading = true;
    state.addressError = '';
    render();

    const cbName = '__censusCb_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
    const script = document.createElement('script');
    const timeoutId = setTimeout(() => {
      if (window[cbName]) {
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        state.addressLoading = false;
        state.addressError = 'Address lookup timed out. Please include Street, City, and State/ZIP (e.g. "350 Fifth Ave, New York, NY 10118"), or enter your district directly (e.g. "NY-17").';
        render();
      }
    }, 10000);

    window[cbName] = function(resp) {
      clearTimeout(timeoutId);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      state.addressLoading = false;
      try {
        const matches = resp && resp.result && resp.result.addressMatches;
        if (!matches || matches.length === 0) {
          state.addressError = 'Could not match that street address. Please include Street Number, Street Name, City, and State or ZIP (e.g., "100 Main St, Flushing, NY 11354"), or type your State-District directly (e.g., "NY-6").';
          state.addressResult = null;
          render();
          return;
        }
        const best = matches[0];
        const geos = best.geographies || {};
        const cdKey = Object.keys(geos).find(k => k.toLowerCase().includes('congressional district'));
        const cdArr = cdKey ? geos[cdKey] : [];
        const cdObj = cdArr && cdArr[0] ? cdArr[0] : null;
        const stFips = (cdObj && cdObj.STATE) || (best.addressComponents && best.addressComponents.state) || '';
        const stCode = FIPS_TO_STATE[stFips] || (best.addressComponents && best.addressComponents.state) || '';
        const dist = extractDistrictNumber(cdObj);

        const senators = state.data.legislators.filter(l => l.state === stCode && l.chamber === 'Senate' && l.caucusStatus !== 'Former / 119th');
        const rep = state.data.legislators.find(l => l.state === stCode && l.chamber === 'House' && String(l.district) === String(dist) && l.caucusStatus !== 'Former / 119th');
        state.addressResult = { matchedAddress: best.matchedAddress || q, state: stCode, district: dist, senators, rep: rep || null };
      } catch (err) {
        state.addressError = 'Error parsing congressional district response: ' + err.message;
      }
      render();
    };

    script.onerror = function() {
      clearTimeout(timeoutId);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
      state.addressLoading = false;
      state.addressError = 'Could not reach the U.S. Census Geocoder service. You can also enter your State & District directly (e.g. "CA-40" or "NY-17").';
      render();
    };

    script.src = `https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&vintage=Current_Current&format=jsonp&callback=${cbName}`;
    document.body.appendChild(script);
  };

  window.renderAddressLookupCard = function() {
    const res = state.addressResult;
    const myLawmakers = res ? [...(res.senators || []), ...(res.rep ? [res.rep] : [])] : [];
    return `
      <div class="bg-gradient-to-r from-slate-900 via-blue-950/30 to-slate-900 border border-blue-500/30 rounded-xl p-4 space-y-3 shadow-md">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[11px] font-bold uppercase tracking-wider bg-blue-600 text-white">Constituent Address Lookup</span>
              <span class="text-xs text-slate-400">Powered by U.S. Census Bureau Congressional District Geocoder</span>
            </div>
            <h3 class="text-sm sm:text-base font-bold text-white mt-1">Find Your 2 U.S. Senators & House Representative by Street Address</h3>
          </div>
          ${res ? `
            <button onclick="state.addressResult = null; state.addressError = ''; state.addressInput = ''; state.legStateFilter = 'ALL'; render();" class="text-xs text-slate-400 hover:text-white px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 transition">
              Clear Address Lookup ✕
            </button>
          ` : ''}
        </div>

        <form onsubmit="event.preventDefault(); lookupByAddress(document.getElementById('constituent-address-input').value);" class="flex flex-col sm:flex-row gap-2.5">
          <input
            id="constituent-address-input"
            type="text"
            value="${escapeHtml(state.addressInput)}"
            oninput="state.addressInput = this.value;"
            placeholder="Enter full U.S. street address (e.g. 350 Fifth Ave, New York, NY 10118) or District (e.g. CA-40, NY-17)..."
            class="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            class="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold shrink-0 transition shadow"
          >
            ${state.addressLoading ? '⟳ Geocoding Address...' : 'Find My Lawmakers →'}
          </button>
        </form>

        ${state.addressError ? `
          <div class="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3.5 py-2.5">
            ${escapeHtml(state.addressError)}
          </div>
        ` : ''}

        ${res ? `
          <div class="pt-2 border-t border-slate-800/80 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span class="text-emerald-400 font-medium">✓ Matched: <strong>${escapeHtml(res.matchedAddress)}</strong></span>
              <span class="px-2.5 py-0.5 rounded-full font-mono bg-blue-500/20 text-blue-300 border border-blue-500/30">
                State: <strong>${escapeHtml(res.state)}</strong> · Congressional District: <strong>${escapeHtml(res.district)}</strong>
              </span>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              ${myLawmakers.map(l => `
                <div onclick="openLegislatorModal('${escapeHtml(l.id)}')" class="cursor-pointer p-3.5 rounded-xl bg-slate-950/90 hover:bg-slate-800/90 border border-slate-700/80 hover:border-blue-500/50 transition flex flex-col justify-between gap-2">
                  <div>
                    <div class="flex items-center justify-between gap-2 mb-1">
                      <span class="text-[11px] font-bold uppercase tracking-wider ${l.chamber === 'Senate' ? 'text-amber-300' : 'text-blue-300'}">${l.chamber === 'Senate' ? 'U.S. Senator' : `House Rep (${escapeHtml(l.state)}-${escapeHtml(l.district)})`}</span>
                      ${partyBadge(l.party, l.state, l.district)}
                    </div>
                    <div class="text-base font-bold text-white">${escapeHtml(l.displayName)}</div>
                    <div class="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs">
                      <span class="px-2 py-0.5 rounded bg-slate-800 text-slate-300">Taiwan Caucus: <strong>${escapeHtml(l.caucusStatus || 'No')}</strong></span>
                      ${l.grade && l.grade !== 'N/A' ? `<span class="px-2 py-0.5 rounded font-mono bg-slate-800 text-emerald-300">Grade: <strong>${escapeHtml(l.grade)}</strong></span>` : ''}
                    </div>
                  </div>
                  <div class="pt-2 border-t border-slate-800 flex items-center justify-between text-xs">
                    <span class="text-slate-300"><strong>${l.totalInvolvement}</strong> Taiwan bills (${l.sponsoredCount}S / ${l.cosponsoredCount}C)</span>
                    <span class="text-blue-400 font-semibold">Advocacy Profile →</span>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  };

  const origRenderLegTab = window.renderLegislatorsTab;
  window.renderLegislatorsTab = function() {
    const html = origRenderLegTab();
    if (html.includes('id="constituent-address-input"')) return html;
    return html.replace('<div class="space-y-4">', '<div class="space-y-4">' + window.renderAddressLookupCard());
  };

  if (typeof render === 'function') render();
});
