// Constituent Address Lookup, Silent Auto-Sync & Dynamic Congress Updater for Congress Taiwan Bills Tracker
window.addEventListener('DOMContentLoaded', function() {
  if (typeof state === 'undefined') return;
  state.addressInput = state.addressInput || '';
  state.addressLoading = false;
  state.addressError = '';
  state.addressResult = null;
  state.syncStatusMsg = '';

  const BILLS_SHEET_ID = '1fxEmsfhBS5tEw65fGWxi2-iz7O41Vj8AsNjC4SU1OAM';
  const TRACKER_SHEET_ID = '1mdaAJWzUlD_beW-wg3Ag0_bNQaTie77te79jf11zzY4';

  const FIPS_TO_STATE = {
    '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL',
    '13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME',
    '24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH',
    '34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI',
    '45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
    '56':'WY','60':'AS','66':'GU','69':'MP','72':'PR','78':'VI'
  };

  function ordinalSuffix(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function detectCongressMetadata(bills) {
    const nums = [];
    (bills || []).forEach(b => {
      const m1 = String(b.billNumber || '').match(/^\[(\d+)(?:st|nd|rd|th)\]/i);
      if (m1) nums.push(parseInt(m1[1], 10));
      else {
        const m2 = String(b.link || '').match(/\/(\d+)(?:st|nd|rd|th)-congress\//i);
        if (m2) nums.push(parseInt(m2[1], 10));
      }
    });
    const fallbackNum = Math.floor((new Date().getFullYear() - 1789) / 2) + 1;
    const uniqueNums = [...new Set(nums.filter(Boolean))].sort((a, b) => a - b);
    const primaryNum = uniqueNums.length ? uniqueNums[uniqueNums.length - 1] : fallbackNum;
    const startYear = 1789 + (primaryNum - 1) * 2;
    const endYear = startYear + 1;
    const congressOrd = ordinalSuffix(primaryNum);
    const congressBanner = uniqueNums.length > 1
      ? `${ordinalSuffix(uniqueNums[0])}–${congressOrd} U.S. Congress (${1789 + (uniqueNums[0] - 1) * 2}–${endYear})`
      : `${congressOrd} U.S. Congress (${startYear}–${endYear})`;

    const enactedBills = (bills || []).filter(b => b.stage && b.stage.key === 'enacted');
    let enactedSubtitle = '';
    if (enactedBills.length > 0) {
      enactedSubtitle = enactedBills.map(b => {
        const plMatch = String(b.latestAction || '').match(/Public Law(?:\s+No:?)?\s*(\d+-\d+)/i);
        return plMatch ? `PL ${plMatch[1]} (${b.shortNumber})` : b.shortNumber;
      }).join(' & ');
    } else {
      const calCount = (bills || []).filter(b => b.stage && b.stage.key === 'calendar').length;
      enactedSubtitle = `${calCount} on calendar · awaiting floor vote`;
    }

    return {
      congressNumber: primaryNum,
      congressOrd,
      congressBanner,
      enactedSubtitle
    };
  }

  function normDist(d) {
    if (!d) return null;
    const s = String(d).trim();
    if (!s || s === 'N/A' || s === 'Senate') return null;
    if (/At Large|^0$/i.test(s)) return 'At Large';
    return s.replace(/^0+/, '');
  }

  function parseMember(str) {
    if (!str || !str.trim()) return null;
    const s = str.trim();
    const role = s.startsWith('Sen.') ? 'Sen.' : (s.startsWith('Del.') ? 'Del.' : 'Rep.');
    const chamber = role === 'Sen.' ? 'Senate' : 'House';
    const m = s.match(/\[([A-Z])-([A-Z]{2})(?:-([^\]]+))?\]/);
    const party = m ? m[1] : 'U';
    const state = m ? m[2] : '';
    const district = normDist(m && m[3] ? m[3] : null);
    const namePart = s.replace(/^(Sen\.|Rep\.|Del\.)\s*/, '').split(/\[|\(/)[0].trim();
    const lastName = (namePart.split(',')[0] || '').trim().toLowerCase();
    const id = (chamber === 'House' && district ? `house|${state}|${district}|${lastName}` : `${chamber}|${state}|${lastName}`).toLowerCase();
    return { id, raw: s, role, chamber, name: namePart, displayName: `${role} ${namePart}`, party, state, district };
  }

  function parseCosponsors(str) {
    if (!str || !str.trim()) return [];
    const parts = str.trim().split(/,\s*(?=(?:Sen\.|Rep\.|Del\.)\s)/);
    const seen = new Set();
    const out = [];
    for (const p of parts) {
      const m = parseMember(p);
      if (m && !seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    return out;
  }

  function classifyStage(a) {
    const s = String(a || '');
    if (/Became Public Law/i.test(s)) return { key: 'enacted', label: 'Enacted (Public Law)', step: 4 };
    if (/Received in the Senate|Received in the House|Held at the desk|Passed Senate|Passed House/i.test(s)) return { key: 'passed_chamber', label: 'Passed 1st Chamber / Desk', step: 3 };
    if (/Placed on Senate Legislative Calendar|Ordered to be Reported|Calendar No\./i.test(s)) return { key: 'calendar', label: 'Committee Reported / Calendar', step: 2 };
    return { key: 'committee', label: 'In Committee', step: 1 };
  }

  function classifyTheme(title, summary) {
    const t = `${title} ${summary}`.toLowerCase();
    if (/space|undersea|cyber|innovation|uncrewed|energy|lng|nuclear/.test(t)) return 'Energy, Space & Tech Resilience';
    if (/tax|internal revenue|imf|monetary|financial|conflict deterrence|regulatory|treasury|embargo/.test(t)) return 'Economic, Tax & Financial Deterrence';
    if (/porcupine|defense|ndaa|armed services|arms export|munitions|deter prc|sos act|plus act/.test(t)) return 'Defense & Military Deterrence';
    if (/2758|representative office|allies fund|solidarity|holy see|vatican|americas|blue skies|travel and tourism|flag|assurance|six assurances|reinforcement/.test(t)) return 'Diplomatic & International Space';
    return 'Democracy & Bilateral Relations';
  }

  function isFormerLawmaker(l) {
    return /^Former\b/i.test(String(l && l.caucusStatus || ''));
  }

  function rebuildLiveDataset(liveBillsRows, liveTrackerCompact) {
    const baseData = window.TAIWAN_BILLS_DATA || state.data;
    let bills = baseData ? baseData.bills.map(b => ({ ...b })) : [];

    if (liveBillsRows && liveBillsRows.length > 1) {
      const rawBills = liveBillsRows.slice(1).filter(r => r && r[0] && String(r[0]).trim());
      bills = rawBills.map((r, idx) => {
        const billNumber = String(r[0] || '').trim();
        const shortNumber = billNumber.replace(/^\[\d+(?:st|nd|rd|th)\]\s*/i, '').trim();
        const title = String(r[1] || '').trim();
        const summary = String(r[2] || '').trim();
        const latestAction = String(r[3] || '').trim();
        const latestActionDate = String(r[4] || '').trim();
        const sponsor = parseMember(String(r[5] || ''));
        const cosponsorCount = parseInt(r[6] || '0', 10) || 0;
        const cosponsors = parseCosponsors(String(r[7] || ''));
        const dateIntroduced = String(r[8] || '').trim();
        const daysPending = parseInt(r[9] || '0', 10) || 0;
        let link = String(r[10] || '').trim();
        const chamber = shortNumber.startsWith('S.') ? 'Senate' : 'House';
        const numDigits = (shortNumber.match(/\d+/) || [])[0];
        if (numDigits && link.includes('/senate-bill/')) {
          if (shortNumber.startsWith('S.Res.')) link = link.replace('/senate-bill/', '/senate-resolution/');
          if (shortNumber.startsWith('H.Res.')) link = link.replace('/senate-bill/', '/house-resolution/');
          if (shortNumber.startsWith('H.Con.Res.')) link = link.replace('/senate-bill/', '/house-concurrent-resolution/');
        }
        const rCosponsors = cosponsors.filter(c => c.party === 'R').length;
        const dCosponsors = cosponsors.filter(c => c.party === 'D').length;
        const totalR = rCosponsors + (sponsor && sponsor.party === 'R' ? 1 : 0);
        const totalD = dCosponsors + (sponsor && sponsor.party === 'D' ? 1 : 0);
        return {
          id: shortNumber, rowNumber: idx + 2, billNumber, shortNumber, chamber, title,
          cleanTitle: title.replace(/\s*\((?:House|Senate)\s+Companion\)\s*$/i, '').trim(),
          summary, latestAction, latestActionDate, sponsor, cosponsorCount, cosponsors,
          totalR, totalD, bipartisan: totalR > 0 && totalD > 0, dateIntroduced, daysPending, link,
          stage: classifyStage(latestAction), theme: classifyTheme(title, summary), companionBill: null
        };
      });

      const byShort = {};
      bills.forEach(b => { byShort[b.shortNumber.toUpperCase()] = b; });
      bills.forEach(b => {
        const m = b.summary.match(/companion to ((?:S\.|H\.R\.|S\.Res\.|H\.Res\.)\s*\d+)/i);
        if (m) {
          const key = m[1].replace(/\s+/g, ' ').trim().toUpperCase();
          if (byShort[key]) { b.companionBill = byShort[key].shortNumber; byShort[key].companionBill = b.shortNumber; }
        }
      });
      [['H.R. 33','S. 199'],['S.Res. 86','H.Res. 148'],['S. 821','H.R. 1512'],['H.R. 5626','S. 3979'],['H.Res. 1278','S.Res. 754'],['H.Res. 1366','S.Res. 657']].forEach(([a, c]) => {
        const ba = byShort[a.toUpperCase()], bc = byShort[c.toUpperCase()];
        if (ba && bc) { ba.companionBill = ba.companionBill || bc.shortNumber; bc.companionBill = bc.companionBill || ba.shortNumber; }
      });
      bills.forEach(b => {
        if (b.companionBill) return;
        const match = bills.find(o => o.shortNumber !== b.shortNumber && o.chamber !== b.chamber && o.cleanTitle.toLowerCase() === b.cleanTitle.toLowerCase());
        if (match) { b.companionBill = match.shortNumber; match.companionBill = match.companionBill || b.shortNumber; }
      });
    }

    const meta = detectCongressMetadata(bills);

    const legMap = {};
    if (liveTrackerCompact && liveTrackerCompact.length >= 100) {
      liveTrackerCompact.forEach(tr => {
        const fullName = tr[0];
        const chamber = tr[1] === 'S' ? 'Senate' : 'House';
        const party = tr[2];
        const stateCode = tr[3];
        const district = normDist(tr[4]);
        const caucusStatus = tr[5] || 'No';
        const grade = tr[6] || '';
        const role = chamber === 'Senate' ? 'Sen.' : (['GU','AS','DC','VI','MP','PR'].includes(stateCode) ? 'Del.' : 'Rep.');
        const lastGuess = (fullName.split(/\s+/).pop() || '').toLowerCase();
        const id = (chamber === 'House' && district ? `house|${stateCode}|${district}|${lastGuess}` : `${chamber}|${stateCode}|${lastGuess}`).toLowerCase();
        legMap[id] = {
          id, name: fullName, displayName: `${role} ${fullName}`, role, chamber, party, state: stateCode, district,
          caucusStatus, grade, sponsoredBills: [], cosponsoredBills: []
        };
      });
    } else if (baseData && baseData.legislators) {
      baseData.legislators.forEach(l => {
        if (!isFormerLawmaker(l)) {
          legMap[l.id] = { ...l, sponsoredBills: [], cosponsoredBills: [] };
        }
      });
    }

    function findOrCreateLeg(member) {
      if (!member) return null;
      if (legMap[member.id]) return legMap[member.id];
      const lastPart = (member.name.split(',')[0] || '').trim().toLowerCase();
      const firstPart = ((member.name.split(',')[1] || '').trim().split(/\s+/)[0] || '').toLowerCase();
      const all = Object.values(legMap);
      let found = all.find(l => l.state === member.state && l.chamber === member.chamber && l.name.toLowerCase().includes(lastPart));
      if (found) return found;
      if (member.chamber === 'House' && member.district) {
        found = all.find(l => l.state === member.state && l.chamber === 'House' && l.district === member.district && (l.name.toLowerCase().includes(lastPart) || (firstPart && l.name.toLowerCase().includes(firstPart))));
        if (found) return found;
      }
      if (lastPart === 'curtis' && member.state === 'UT') {
        found = all.find(l => l.state === 'UT' && l.name.toLowerCase().includes('curtis'));
        if (found) return found;
      }
      const cleanFull = member.name.includes(',') ? member.name.split(',').reverse().map(s => s.trim()).join(' ') : member.name;
      legMap[member.id] = {
        id: member.id, name: cleanFull, displayName: `${member.role} ${cleanFull}`, role: member.role,
        chamber: member.chamber, party: member.party, state: member.state, district: member.district,
        caucusStatus: `Former / ${meta.congressOrd}`, grade: 'N/A', sponsoredBills: [], cosponsoredBills: []
      };
      return legMap[member.id];
    }

    bills.forEach(b => {
      if (b.sponsor) {
        const leg = findOrCreateLeg(b.sponsor);
        if (leg) {
          b.sponsor.id = leg.id; b.sponsor.displayName = leg.displayName;
          if (!leg.sponsoredBills.includes(b.shortNumber)) leg.sponsoredBills.push(b.shortNumber);
        }
      }
      b.cosponsors.forEach(c => {
        const leg = findOrCreateLeg(c);
        if (leg) {
          c.id = leg.id; c.displayName = leg.displayName;
          if (!leg.sponsoredBills.includes(b.shortNumber) && !leg.cosponsoredBills.includes(b.shortNumber)) leg.cosponsoredBills.push(b.shortNumber);
        }
      });
    });

    const legislators = Object.values(legMap).map(l => ({
      ...l,
      sponsoredCount: l.sponsoredBills.length,
      cosponsoredCount: l.cosponsoredBills.length,
      totalInvolvement: l.sponsoredBills.length + l.cosponsoredBills.length
    })).sort((a, b) => b.totalInvolvement - a.totalInvolvement || b.sponsoredCount - a.sponsoredCount || a.state.localeCompare(b.state) || a.name.localeCompare(b.name));

    return {
      spreadsheetId: BILLS_SHEET_ID,
      spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${BILLS_SHEET_ID}/edit`,
      congressNumber: meta.congressNumber,
      congressOrd: meta.congressOrd,
      congressBanner: meta.congressBanner,
      enactedSubtitle: meta.enactedSubtitle,
      totalBills: bills.length,
      enactedCount: bills.filter(b => b.stage.key === 'enacted').length,
      bipartisanCount: bills.filter(b => b.bipartisan).length,
      companionPairsCount: Math.floor(bills.filter(b => b.companionBill).length / 2),
      totalLegislators: legislators.length,
      activeLegislatorsCount: legislators.filter(l => l.totalInvolvement > 0).length,
      bills,
      legislators
    };
  }

  function fetchGvizSheet(spreadsheetId, sheetName) {
    return new Promise((resolve, reject) => {
      const cbName = '__gvizCb_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
      const script = document.createElement('script');
      const timer = setTimeout(() => {
        if (window[cbName]) {
          delete window[cbName];
          if (script.parentNode) script.parentNode.removeChild(script);
          reject(new Error('Google Sheet request timed out.'));
        }
      }, 9000);

      window[cbName] = function(resp) {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        if (!resp || resp.status === 'error' || !resp.table) {
          reject(new Error('Sheet not publicly readable yet'));
          return;
        }
        const cols = (resp.table.cols || []).map(c => c.label || '');
        const rows = (resp.table.rows || []).map(r =>
          (r.c || []).map(cell => {
            if (!cell) return '';
            if (cell.f !== undefined && cell.f !== null) return String(cell.f);
            if (cell.v !== undefined && cell.v !== null) return String(cell.v);
            return '';
          })
        );
        if (cols.some(Boolean)) {
          resolve([cols, ...rows]);
        } else {
          resolve(rows);
        }
      };

      script.onerror = function() {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        reject(new Error('Sheet not publicly readable'));
      };

      const tqx = `responseHandler:${cbName}`;
      const sheetParam = sheetName ? `&sheet=${encodeURIComponent(sheetName)}` : '';
      script.src = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=${encodeURIComponent(tqx)}${sheetParam}`;
      document.body.appendChild(script);
    });
  }

  function convertTrackerGvizToCompact(rows) {
    const out = [];
    rows.forEach(r => {
      const name = String(r[0] || '').trim();
      if (!name || /^name$/i.test(name)) return;
      const chRaw = String(r[1] || '').trim();
      const ch = /^s/i.test(chRaw) ? 'S' : 'H';
      const pRaw = String(r[2] || '').trim();
      const pty = /^r/i.test(pRaw) ? 'R' : (/^d/i.test(pRaw) ? 'D' : 'I');
      const st = String(r[3] || '').trim();
      const distRaw = String(r[4] || '').trim();
      const dist = (!distRaw || /^n\/a$/i.test(distRaw)) ? '' : (/at\s*large|^0$/i.test(distRaw) ? '0' : distRaw.replace(/\.0$/, ''));
      const caucusRaw = String(r[10] || '').trim();
      const caucus = (!caucusRaw || /^no$/i.test(caucusRaw)) ? '' : caucusRaw;
      const grade = String(r[13] || '').trim();
      if (st.length === 2) {
        out.push([name, ch, pty, st, dist, caucus, grade]);
      }
    });
    return out;
  }

  // Silent background auto-sync (runs on page load, tab focus, and every 5 minutes)
  window.syncFromGoogleSheet = async function() {
    if (state.syncing) return;
    state.syncing = true;
    state.syncStatusMsg = '';

    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      try {
        const res = await fetch('/api/sync', { method: 'POST' });
        if (res.ok) {
          const fresh = await res.json();
          const meta = detectCongressMetadata(fresh.bills);
          state.data = { ...fresh, ...meta };
          state.syncing = false;
          render();
          return;
        }
      } catch (_) {}
    }

    try {
      const [billsResult, trackerResult] = await Promise.allSettled([
        fetchGvizSheet(BILLS_SHEET_ID, 'Sheet1'),
        fetchGvizSheet(TRACKER_SHEET_ID, 'Tracker')
      ]);

      const liveBillsRows = billsResult.status === 'fulfilled' && billsResult.value && billsResult.value.length > 1
        ? billsResult.value
        : null;
      const liveTrackerCompact = trackerResult.status === 'fulfilled' && trackerResult.value
        ? convertTrackerGvizToCompact(trackerResult.value)
        : null;

      if (liveBillsRows || (liveTrackerCompact && liveTrackerCompact.length >= 100)) {
        state.data = rebuildLiveDataset(liveBillsRows, liveTrackerCompact);
      }
    } catch (_) {
    } finally {
      state.syncing = false;
      state.syncStatusMsg = '';
      render();
    }
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
      const senators = state.data.legislators.filter(l => l.state === st && l.chamber === 'Senate' && !isFormerLawmaker(l));
      const rep = state.data.legislators.find(l => l.state === st && l.chamber === 'House' && String(l.district) === String(dist) && !isFormerLawmaker(l));
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

        const senators = state.data.legislators.filter(l => l.state === stCode && l.chamber === 'Senate' && !isFormerLawmaker(l));
        const rep = state.data.legislators.find(l => l.state === stCode && l.chamber === 'House' && String(l.district) === String(dist) && !isFormerLawmaker(l));
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

  function applyDynamicCongressLabels(htmlStr) {
    if (!state.data) return htmlStr;
    const meta = detectCongressMetadata(state.data.bills);
    const ord = state.data.congressOrd || meta.congressOrd;
    const banner = state.data.congressBanner || meta.congressBanner;
    const enactedSub = state.data.enactedSubtitle || meta.enactedSubtitle;
    document.title = `${ord} Congress Taiwan Bills Tracker`;
    return htmlStr
      // Update badge & remove Google Sheet references/buttons from the header
      .replace(/Live Google Sheet Backend/g, 'Live Legislative Tracker')
      .replace(/Powered directly by your\s*<a[^>]*>Congress Taiwan Bills Google Sheet ↗<\/a>\s*— preserving your automated Congress\.gov API updates\./g, 'Real-time legislative tracking, bicameral companion bill analysis, and constituent lawmaker lookup across the U.S. Senate and House of Representatives.')
      .replace(/<button\s+onclick="syncFromGoogleSheet\(\)"[\s\S]*?<\/button>/g, '')
      .replace(/<a\s+href="[^"]*"\s+target="_blank"\s+rel="noopener"\s+class="[^"]*"\s*>\s*Open Google Sheet ↗\s*<\/a>/g, '')
      .replace(/Sort: Google Sheet Row Order/g, 'Sort: Default Tracker Order')
      // Update Congress session labels & enacted laws dynamically
      .replace(/119th U\.S\. Congress \(2025–2026\)/g, banner)
      .replace(/PL 119-60 \(S\.1071\) &amp; PL 119-45 \(H\.R\.1512\)|PL 119-60 \(S\.1071\) & PL 119-45 \(H\.R\.1512\)/g, enactedSub)
      .replace(/119th Bills/g, `${ord} Bills`)
      .replace(/Supported Bills \(119th Congress\)/g, `Supported Bills (${ord} Congress)`)
      .replace(/0 bills in 119th Congress/g, `0 bills in ${ord} Congress`)
      .replace(/across all 49 Taiwan bills/g, `across all ${state.data.totalBills} Taiwan bills`);
  }

  // Also clean up Google Sheet references inside the Bill Detail modal
  const origOpenBillModal = window.openBillModal;
  if (typeof origOpenBillModal === 'function') {
    window.openBillModal = function(shortNum) {
      origOpenBillModal(shortNum);
      const content = document.getElementById('modal-content');
      if (content) {
        content.innerHTML = content.innerHTML
          .replace(/No cosponsors recorded yet in Google Sheet\./g, 'No cosponsors recorded yet.')
          .replace(/Google Sheet Row #\d+\s*·\s*Formula Days Pending:/g, 'Days Pending:')
          .replace(/<a[^>]*>\s*Open Row in Google Sheet ↗\s*<\/a>/g, '');
      }
    };
  }

  const origRenderLegRows = window.renderLegislatorRows;
  if (typeof origRenderLegRows === 'function') {
    window.renderLegislatorRows = function(legs) {
      return applyDynamicCongressLabels(origRenderLegRows(legs));
    };
  }

  const origRenderLegTab = window.renderLegislatorsTab;
  window.renderLegislatorsTab = function() {
    let html = applyDynamicCongressLabels(origRenderLegTab());
    if (html.includes('id="constituent-address-input"')) return html;
    return html.replace('<div class="space-y-4">', '<div class="space-y-4">' + window.renderAddressLookupCard());
  };

  const origRender = window.render;
  if (typeof origRender === 'function') {
    window.render = function() {
      state.syncStatusMsg = '';
      origRender();
      const app = document.getElementById('app');
      if (app) {
        app.innerHTML = applyDynamicCongressLabels(app.innerHTML);
      }
    };
  }

  if (typeof window.render === 'function') window.render();

  // Automatically sync in the background on load, every 5 minutes, and when tab regains focus
  window.syncFromGoogleSheet();
  setInterval(() => window.syncFromGoogleSheet(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') window.syncFromGoogleSheet();
  });
});
