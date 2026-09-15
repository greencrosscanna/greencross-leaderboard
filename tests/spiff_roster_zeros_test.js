#!/usr/bin/env node
/* The kiosk SPIFF panel lists EVERYONE at the store, not only the people who have sold (spiff.gs,
 * spiffRosterZeroRows_). Sky's to-do: "need to show all six budtenders, even if one hasn't sold a
 * SPIFF item yet."
 *
 * SPIFF publishes rows for sellers only, on purpose (they feed Crew's pay screen), and adds the zeros
 * at display time. The rule it gave on 2026-09-14, asserted here:
 *   - everyone ACTIVE on the GX Core roster whose home_store is the store; no role filter
 *   - matched to a seller by Dutchie id first, then by name (Dutchie adds middle names)
 *   - a zero is units 0, not hit, earned 0, against the store's per-budtender goal
 *   - a program this store takes part in with NO sellers here still shows, everyone at zero
 *
 * The fixture is River Rd as SPIFF read it live that day: six people, one seller (Brody, 4 units).
 */
'use strict';
const { load, run, _eq_, _ok_ } = require('./_harness');

const M = load(['spiff.gs'], { stubs: { GC_SPIFF_SHOW_KEY: 'GC_SPIFF_SHOW' } });

const PP_START = '2026-09-14', PP_END = '2026-09-27';

const RIVER = [
  { dutchieId: '41001', fullName: 'TJ Peterson',            displayName: 'TJ Peterson' },
  { dutchieId: '41002', fullName: 'Noah Pinkerton',         displayName: 'Noah Pinkerton' },
  { dutchieId: '41003', fullName: 'Bennett Montgomery',     displayName: 'Bennett Montgomery' },
  { dutchieId: '45746', fullName: 'Brody Henry-Logan',      displayName: 'Brody Henry-Logan' },
  { dutchieId: '',      fullName: 'Rose Bailey',            displayName: 'Rose Bailey' },
  { dutchieId: '41006', fullName: 'Poem Olson',             displayName: 'Poem Olson' },
];

function row(over) {
  return Object.assign({
    program_id: 'hellavated-202609', vendor: 'Hellavated', program_name: 'Carts & Cloud Bars',
    start_date: '2026-09-10', end_date: '2026-09-30', status: 'active', store_id: 'river-rd',
    employee_id: 45746, name: 'Brody', units: 4, target: 26, hit: false, earned: 0,
  }, over || {});
}
const SIDECAR = [{
  program_id: 'hellavated-202609', vendor: 'Hellavated', program_name: 'Carts & Cloud Bars', status: 'active',
  start_date: '2026-09-10', end_date: '2026-09-30', product: 'Carts & Cloud Bars',
  store_goals: { 'river-rd': 156 }, bt_goals: { 'river-rd': 26 }, tips: ['Ask every cart buyer'],
}];

const panelFor = (rows, sidecar, roster) =>
  M.spiffProgramsForStore_(rows.concat(M.spiffRosterZeroRows_(rows, sidecar, 'river-rd', roster, PP_START, PP_END)),
                           sidecar, 'river-rd', '2026-09-14 18:56:10');

run('spiff_roster_zeros', {

  riverShowsAllSix() {
    const p = panelFor([row()], SIDECAR, RIVER)[0];
    _eq_('six people in the program', p.people.length, 6);
    _eq_('the seller first', p.people[0].name, 'Brody');
    _eq_('Brody appears once, not also as a zero', p.people.filter((x) => /^Brody/.test(x.name)).length, 1);
    _ok_('everyone else at 0 units, not hit, $0',
      p.people.slice(1).every((x) => x.units === 0 && !x.hit && x.earned === 0));
    _ok_('against the per-budtender goal, not the store goal', p.people.every((x) => x.target === 26));
    _eq_('zeros listed alphabetically after the seller', p.people.slice(1).map((x) => x.name),
      ['Bennett', 'Noah', 'Poem', 'Rose', 'TJ']);
    _eq_('managers are in: no role filter', p.people.some((x) => x.name === 'TJ'), true);
  },

  matchedByNameWhenTheRowHasNoId() {
    // Dutchie adds middle names; SPIFF compares first + last against full and display name.
    const zeros = M.spiffRosterZeroRows_([row({ employee_id: '', name: 'Rose Anne Bailey', units: 3 })],
                                         SIDECAR, 'river-rd', RIVER, PP_START, PP_END);
    _ok_('"Rose Anne Bailey" is the roster\'s Rose Bailey, not a zero', !zeros.some((z) => z.name === 'Rose'));
    _eq_('the other five get zeros', zeros.length, 5);
  },

  bareFirstNameMatchesOnlyWhenUnique() {
    const twoPoems = RIVER.concat([{ dutchieId: '', fullName: 'Poem Reyes', displayName: 'Poem Reyes' }]);
    const zeros = M.spiffRosterZeroRows_([row({ employee_id: '', name: 'Poem', units: 1 })],
                                         SIDECAR, 'river-rd', twoPoems, PP_START, PP_END);
    _eq_('an ambiguous first name is not guessed: both Poems stay as zeros',
      zeros.filter((z) => z.name === 'Poem').length, 2);
  },

  aProgramWithNoSellersHereStillShows() {
    const other = [{ program_id: 'mule-202609', vendor: 'Mule', program_name: 'Mule Extracts', status: 'active',
                     start_date: '2026-09-14', end_date: '2026-09-27', bt_goals: { 'river-rd': 10, bend: 12 } }];
    const progs = panelFor([row()], SIDECAR.concat(other), RIVER);
    const mule = progs.filter((p) => p.name === 'Mule Extracts')[0];
    _ok_('the program is on River\'s panel although nobody at River has sold it', !!mule);
    _eq_('with everyone at zero', mule && mule.people.length, 6);
    _eq_('against River\'s goal, not Bend\'s', mule && mule.people[0].target, 10);
  },

  programsThisStoreIsNotInStayOff() {
    const bendOnly = [{ program_id: 'bend-only', vendor: 'X', program_name: 'Bend only', status: 'active',
                        start_date: '2026-09-14', end_date: '2026-09-27', bt_goals: { bend: 12 } }];
    const closed = [{ program_id: 'closed', vendor: 'Y', program_name: 'Closed', status: 'closed',
                      start_date: '2026-09-14', end_date: '2026-09-27', bt_goals: { 'river-rd': 5 } }];
    const lastPeriod = [{ program_id: 'old', vendor: 'Z', program_name: 'Old', status: 'active',
                          start_date: '2026-08-01', end_date: '2026-08-31', bt_goals: { 'river-rd': 5 } }];
    const progs = panelFor([row()], SIDECAR.concat(bendOnly, closed, lastPeriod), RIVER);
    _eq_('only the program River is actually in this period', progs.map((p) => p.name), ['Carts & Cloud Bars']);
  },

  noRosterMeansTodaysBehavior() {
    const p = panelFor([row()], SIDECAR, [])[0];
    _eq_('GX Core roster unreadable: sellers only, nothing invented', p.people.length, 1);
  },

  cardsStayFromSellersOnly() {
    // The zeros are for the panel. spiffForStore_ must build the staff-card index from the sellers,
    // or every card at the store would grow a "0 of 26" SPIFF line.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'spiff.gs'), 'utf8');
    const fn = src.slice(src.indexOf('function spiffForStore_('), src.indexOf('function spiffNameParts_('));
    _ok_('idx is built from rows before any zeros are added',
      /var idx\s+=\s+spiffIndexByEmployee_\(rows\)/.test(fn) && fn.indexOf('spiffRosterZeroRows_') > fn.indexOf('spiffIndexByEmployee_(rows)'));
  },
});
