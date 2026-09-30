import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripFraming, isAvailabilityQuestion, splitItems, normalizeQuery, expandCategory, relaxQuery,
  applySkipGuard, planGeneralSearch, needsPlannedSearch, runPlannedSearch,
  headNounOf, leafCategory, scoreHitByCategory, buildNoMatchNote, buildSearchContextLine,
} from '../app/services/catalog-terms.server.js';

const SIEMENS_ACC = { title: 'Siemens Contactor Accessories 3RT2934-5NB31', vendor: 'Siemens',
  tags: ['Automation & Control Gear', 'Contactor Accessories', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactor Accessories'] };
const SIEMENS_CONTACTOR = { title: '3RT2015-1AB01-1AA0 - Siemens 3-Pole Contactor, 24 V Coil (7A)', vendor: 'Siemens',
  tags: ['Automation & Control Gear', 'Contactors', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactors'] };
const SIEMENS_OLR_TAGGED = { title: '3RT2035-1AC20 - Siemens 3RT2 Contactor Overload Relay, 60000 mA 41000 mA (3P)', vendor: 'Siemens',
  tags: ['Automation & Control Gear', 'Contactor Overload Relays', 'Contactors & Auxiliary Contacts', 'Electrical Automation & Cables', 'Siemens Contactor Overload Relays'] };
const EATON_CB_ACC = { title: 'Eaton Circuit Breaker Accessories 29364', vendor: 'Eaton',
  tags: ['Circuit Breaker Accessories', 'Circuit Breakers', 'Eaton Circuit Breaker Accessories', 'Electrical Automation & Cables', 'Fuses & Circuit Breakers'] };
const ETA_CB = { title: 'Eta Electronic Circuit Breakers ESX10-TB-101-DC24V-12A-E', vendor: 'Eta',
  tags: ['Circuit Breakers', 'Electrical Automation & Cables', 'Electronic Circuit Breakers', 'Eta Electronic Circuit Breakers', 'Fuses & Circuit Breakers'] };
const SMC_SWITCH_NO_TAGS = { title: 'Smc Pneumatic Cylinder Switches D-Z73', vendor: 'SMC' };

test('stripFraming removes availability framing', () => {
  assert.equal(stripFraming('do you supply frp cable tray, frp enclosure?'), 'frp cable tray, frp enclosure');
  assert.equal(stripFraming('do you supply switchgare'), 'switchgare');
  assert.equal(stripFraming('Hi, do you have Siemens contactor?'), 'Siemens contactor');
  assert.equal(stripFraming('is there any cable gland available?'), 'cable gland');
  assert.equal(stripFraming("I'm looking for a VFD"), 'a VFD');
});

test('isAvailabilityQuestion', () => {
  assert.equal(isAvailabilityQuestion('do you supply switchgare'), true);
  assert.equal(isAvailabilityQuestion('do you have high-performance contactor manufactured by Siemens'), true);
  assert.equal(isAvailabilityQuestion('is 3RT2015 available?'), true);
  assert.equal(isAvailabilityQuestion('help me find job here'), false);
  assert.equal(isAvailabilityQuestion('Solution for cylinder leakage'), false);
  assert.equal(isAvailabilityQuestion('yes thank you'), false);
});

test('splitItems', () => {
  assert.deepEqual(splitItems('frp cable tray, frp enclosure'), ['frp cable tray', 'frp enclosure']);
  assert.deepEqual(splitItems('frp cable tray and frp enclosure'), ['frp cable tray', 'frp enclosure']);
  assert.deepEqual(splitItems('PNP and NPN sensor'), ['PNP and NPN sensor']);
  assert.deepEqual(splitItems('siemens contactor'), ['siemens contactor']);
});

test('normalizeQuery maps FRP/GRP and switchgear typos to catalogue words', () => {
  assert.deepEqual(normalizeQuery('frp enclosure'), { query: 'polyester enclosure', aliases: { polyester: 'FRP' } });
  assert.equal(normalizeQuery('GRP junction box').query, 'polyester junction box');
  assert.equal(normalizeQuery('Glass-fiber reinforced polyester safety switch').query, 'polyester safety switch');
  assert.equal(normalizeQuery('switchgare').query, 'switchgear');
  assert.equal(normalizeQuery('switch gear').query, 'switchgear');
  assert.deepEqual(normalizeQuery('contactor'), { query: 'contactor', aliases: {} });
});

test('expandCategory', () => {
  assert.deepEqual(expandCategory('switchgear'), { label: 'switchgear', queries: ['circuit breaker', 'contactor', 'switch disconnector'] });
  assert.deepEqual(expandCategory('Siemens switchgear').queries, ['Siemens circuit breaker', 'Siemens contactor', 'Siemens switch disconnector']);
  assert.deepEqual(expandCategory('LV switchgear').queries, ['circuit breaker', 'contactor', 'switch disconnector']);
  assert.equal(expandCategory('contactor'), null);
});

test('relaxQuery drops modifiers first and never the product noun', () => {
  assert.deepEqual(relaxQuery('polyester enclosure'), [{ query: 'enclosure', dropped: ['polyester'] }]);
  assert.deepEqual(relaxQuery('polyester cable tray'), [{ query: 'cable tray', dropped: ['polyester'] }]);
  assert.deepEqual(relaxQuery('hydraulic gear pump motor'), [{ query: 'gear pump motor', dropped: ['hydraulic'] }]);
  assert.deepEqual(relaxQuery('contactor'), []);
});

test('applySkipGuard overrides scope judgements only', () => {
  const frp = applySkipGuard('do you supply frp cable tray, frp enclosure?', { skip: true, reason: 'product_category_out_of_scope', query: '' });
  assert.equal(frp.skip, false);
  assert.equal(frp.overridden, true);
  assert.equal(frp.query, 'frp cable tray, frp enclosure');
  assert.equal(applySkipGuard('help me find job here', { skip: true, reason: 'no_product_search_intent_careers_inquiry' }).skip, true);
  assert.equal(applySkipGuard('Solution for cylinder leakage', { skip: true, reason: 'troubleshooting_no_product_search_intent' }).skip, true);
  assert.equal(applySkipGuard('yes thank you', { skip: true, reason: 'acknowledgement' }).skip, true);
  assert.equal(applySkipGuard('do you have a careers page?', { skip: true, reason: 'careers_question' }).skip, true);
  assert.equal(applySkipGuard('x', { skip: false, query: 'switchgear' }).query, 'switchgear');
});

test('planGeneralSearch', () => {
  const frp = planGeneralSearch('do you supply frp cable tray, frp enclosure?', { skip: true, reason: 'product_category_out_of_scope', query: '' });
  assert.deepEqual(frp.items.map((i) => i.query), ['polyester cable tray', 'polyester enclosure']);
  assert.equal(needsPlannedSearch(frp), true);

  const sg = planGeneralSearch('do you supply switchgare', { skip: false, query: 'switchgear', reason: 'typo_fixed' });
  assert.deepEqual(sg.items[0].category.queries, ['circuit breaker', 'contactor', 'switch disconnector']);
  assert.equal(needsPlannedSearch(sg), true);

  const sc = planGeneralSearch('do you have high-performance contactor manufactured by Siemens', { skip: false, query: 'Siemens contactor', brand: 'Siemens' });
  assert.equal(sc.primaryQuery, 'Siemens contactor');
  assert.equal(needsPlannedSearch(sc), false);

  assert.equal(planGeneralSearch('help me find job here', { skip: true, reason: 'no_product_search_intent_careers_inquiry' }).skip, true);
});

const FAKE = {
  'polyester cable tray': [], 'cable tray': [],
  'polyester enclosure': [], enclosure: [{ id: 'e1', title: 'Bticino PCB Mounting Enclosures 360002' }],
  'circuit breaker': [{ id: 'cb1' }, { id: 'cb2' }], contactor: [{ id: 'c1' }], 'switch disconnector': [{ id: 'sd1' }],
};
const fakeSearch = async (q) => ({ products: FAKE[q] ?? [], confidence: 'high' });

test('runPlannedSearch: FRP multi-item enquiry', async () => {
  const plan = planGeneralSearch('do you supply frp cable tray, frp enclosure?', { skip: true, reason: 'product_category_out_of_scope', query: '' });
  const r = await runPlannedSearch(plan, { search: fakeSearch, first: 10 });
  assert.equal(r.searchType, 'algolia_multi');
  assert.deepEqual(r.products.map((p) => p.id), ['e1']);
  assert.deepEqual(r.itemReport, [
    { asked: 'frp cable tray', status: 'none' },
    { asked: 'frp enclosure', status: 'relaxed', shownAs: 'enclosure', dropped: ['FRP'] },
  ]);
  assert.match(buildSearchContextLine(r), /FRP/);
  assert.match(buildSearchContextLine(r), /frp cable tray/);
});

test('runPlannedSearch: switchgear category enquiry', async () => {
  const plan = planGeneralSearch('do you supply switchgare', { skip: false, query: 'switchgear', reason: 'typo_fixed' });
  const r = await runPlannedSearch(plan, { search: fakeSearch, first: 10 });
  assert.equal(r.searchType, 'algolia_category');
  assert.deepEqual(r.products.map((p) => p.id), ['cb1', 'c1', 'sd1', 'cb2']);
  assert.deepEqual(r.itemReport, [{ asked: 'switchgear', status: 'category', shownAs: ['circuit breaker', 'contactor', 'switch disconnector'] }]);
});

test('runPlannedSearch: low-confidence hits are not used; relaxOnly skips the exact query', async () => {
  const calls = [];
  const search = async (q) => {
    calls.push(q);
    return q === 'enclosure' ? { products: [{ id: 'e1' }], confidence: 'high' } : { products: [{ id: 'junk' }], confidence: 'low' };
  };
  const plan = planGeneralSearch('frp enclosure', { skip: false, query: 'frp enclosure' });
  const r = await runPlannedSearch(plan, { search, first: 10, relaxOnly: true });
  assert.equal(r.searchType, 'algolia_relaxed');
  assert.deepEqual(r.products.map((p) => p.id), ['e1']);
  assert.deepEqual(calls, ['enclosure']);
});

test('runPlannedSearch: no_match and throwing search never throw', async () => {
  const plan = planGeneralSearch('frp cable tray', { skip: false, query: 'frp cable tray' });
  assert.equal((await runPlannedSearch(plan, { search: fakeSearch })).searchType, 'no_match');
  const boom = async () => { throw new Error('network'); };
  assert.equal((await runPlannedSearch(plan, { search: boom })).searchType, 'no_match');
});

test('headNounOf', () => {
  assert.equal(headNounOf('contactor'), 'contactor');
  assert.equal(headNounOf('Siemens contactor'), 'contactor');
  assert.equal(headNounOf('circuit breaker'), 'breaker');
  assert.equal(headNounOf('inductive proximity sensor 8 mm'), 'sensor');
  assert.equal(headNounOf('variable frequency drive for pump'), 'drive');
  assert.equal(headNounOf('plug-in relay'), 'relay');
  assert.equal(headNounOf('24V DC'), null);
});

test('leafCategory reads the "<Vendor> <Leaf>" tag, else the title', () => {
  assert.equal(leafCategory(SIEMENS_ACC), 'contactor accessories');
  assert.equal(leafCategory(SIEMENS_CONTACTOR), 'contactors');
  assert.equal(leafCategory(ETA_CB), 'electronic circuit breakers');
  assert.equal(leafCategory(SMC_SWITCH_NO_TAGS), 'pneumatic cylinder switches');
});

test('scoreHitByCategory puts main products above accessories', () => {
  assert.equal(scoreHitByCategory(SIEMENS_CONTACTOR, 'contactor'), 500);
  assert.equal(scoreHitByCategory(SIEMENS_ACC, 'contactor'), -900);
  assert.equal(scoreHitByCategory(SIEMENS_OLR_TAGGED, 'contactor'), -900);
  assert.equal(scoreHitByCategory(ETA_CB, 'circuit breaker'), 500);
  assert.equal(scoreHitByCategory(EATON_CB_ACC, 'circuit breaker'), -900);
  assert.equal(scoreHitByCategory(SMC_SWITCH_NO_TAGS, 'pneumatic cylinder'), -900);
  // Asking for the sub-part itself flips it:
  assert.equal(scoreHitByCategory(SIEMENS_ACC, 'contactor accessories'), 500);
  assert.equal(scoreHitByCategory(SIEMENS_CONTACTOR, 'contactor accessories'), 0);
  const ranked = [SIEMENS_ACC, SIEMENS_OLR_TAGGED, SIEMENS_CONTACTOR]
    .sort((a, b) => scoreHitByCategory(b, 'contactor') - scoreHitByCategory(a, 'contactor'));
  assert.equal(ranked[0], SIEMENS_CONTACTOR);
});

test('buildNoMatchNote keeps the SYSTEM NOTE tag first and never says "we don\'t supply"', () => {
  const note = buildNoMatchNote({ itemReport: [{ asked: 'frp cable tray', status: 'none' }] });
  assert.ok(note.startsWith('[SYSTEM NOTE — NOT FROM USER]'));
  assert.match(note, /websales@creativeautomation\.ae/);
  assert.match(note, /Do NOT say we don't supply/);
});
