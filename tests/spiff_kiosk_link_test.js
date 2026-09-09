#!/usr/bin/env node
/* The SPIFF board button's link (spiff.gs → spiffKioskUrl_).
 *
 * Sky, 2026-09-08: "We need unique store links for each store. We will then wire these to
 * Leaderboard so that BTs can open a window with the SPIFF details from their Kiosk."
 *
 * The link carries a PERMANENT per-store token minted by SPIFF, and on the far side that token
 * is the whole credential — a kiosk is a shared screen nobody signs into. So the ways this goes
 * wrong are all about handing out the wrong string on the most visible screen in the company:
 *
 *   1. A BUTTON THAT OPENS NOTHING. No token configured must mean no button, not a button onto
 *      SPIFF's "this link is no longer active" page. Every store is in that state until the six
 *      tokens are pasted into the Command Center, so it is the DEFAULT, not an edge case.
 *
 *   2. THE WRONG STORE'S KEY. SPIFF keys store_links on the GX CORE store_id ('bend'), and
 *      Leaderboard's own slug for that store is 'century'. Reading the key by app slug would
 *      silently find nothing at four of six stores — and, worse, could find the wrong store's
 *      token where the two names happen to collide.
 *
 *   3. GX CORE BEING UNREACHABLE TAKING THE BOARD WITH IT. This is a config read on a kiosk hot
 *      path. It may cost a button. It may never cost a board.
 *
 * Per tests/_harness.js's rule these never reimplement — spiff.gs is read off disk.
 */
'use strict';
const { load, run, _eq_, _ok_ } = require('./_harness');

let KV = {};
let CORE_UP = true;

const M = load(['spiff.gs'], {
  stubs: {
    /* The one translation between Leaderboard's slug and GX Core's store_id. The real one lives
       in dutchie_fetch.gs and resolves through Core's registry; stubbed to the live mapping so
       these assert on the LOOKUP, not on the registry. */
    coreStoreId_: function (store) {
      const map = { century: 'bend', river: 'river-rd', portland: 'portland-rd',
                    baseline: 'hillsboro', center: 'center', commercial: 'commercial' };
      const slug = String((store && store.slug) || '').trim().toLowerCase();
      return map[slug] || slug;
    },
    GXCore: {
      getKv: function (k) {
        if (!CORE_UP) throw new Error('GX Core unreachable');
        return Object.prototype.hasOwnProperty.call(KV, k) ? KV[k] : null;
      },
    },
  },
});

const BASE = 'https://greencrosscanna.github.io/greencross-spiff/store.html';

function reset() { KV = {}; CORE_UP = true; }

const tests = {

  'no token configured means NO link — which is every store until the six are pasted in': function () {
    reset();
    _eq_('century', M.spiffKioskUrl_({ slug: 'century' }), '');
    _eq_('center', M.spiffKioskUrl_({ slug: 'center' }), '');
  },

  'a blank or whitespace token is the same as no token': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = '   ';
    _eq_('blank', M.spiffKioskUrl_({ slug: 'century' }), '');
  },

  'a configured token builds SPIFF\'s store page URL': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = 'tok_abc123';
    _eq_('url', M.spiffKioskUrl_({ slug: 'century' }), BASE + '?t=tok_abc123');
  },

  'the key is the GX CORE store_id, never Leaderboard\'s own slug': function () {
    reset();
    // 'century' is this app's name for the store GX Core and SPIFF both call 'bend'.
    KV['cfg.spiffKiosk.bend']    = 'right';
    KV['cfg.spiffKiosk.century'] = 'wrong';
    _ok_('reads the Core id', /t=right$/.test(M.spiffKioskUrl_({ slug: 'century' })));
  },

  'every store resolves through the same translation, not a special case': function () {
    reset();
    [['century', 'bend'], ['river', 'river-rd'], ['portland', 'portland-rd'],
     ['baseline', 'hillsboro'], ['center', 'center'], ['commercial', 'commercial']
    ].forEach(function (pair) {
      KV['cfg.spiffKiosk.' + pair[1]] = 'tok-' + pair[1];
      _eq_(pair[0], M.spiffKioskUrl_({ slug: pair[0] }), BASE + '?t=tok-' + pair[1]);
    });
  },

  'the token is URL-encoded — it is a credential, not a word we chose': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = 'a b&c=d';
    _eq_('encoded', M.spiffKioskUrl_({ slug: 'century' }), BASE + '?t=a%20b%26c%3Dd');
  },

  'the base URL is overridable from the Command Center': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = 'tok';
    KV['cfg.spiffKioskBase']  = 'https://spiff.greencrosscanna.com/store.html';
    _eq_('override', M.spiffKioskUrl_({ slug: 'century' }),
         'https://spiff.greencrosscanna.com/store.html?t=tok');
  },

  'a non-https base is ignored — this ends up as a live link on a kiosk': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = 'tok';
    ['http://evil.example/store.html', 'javascript:alert(1)', 'not a url', ''].forEach(function (bad) {
      KV['cfg.spiffKioskBase'] = bad;
      _eq_('rejected: ' + bad, M.spiffKioskUrl_({ slug: 'century' }), BASE + '?t=tok');
    });
  },

  'GX Core being unreachable costs a button, never a board': function () {
    reset();
    KV['cfg.spiffKiosk.bend'] = 'tok';
    CORE_UP = false;
    _eq_('no link, no throw', M.spiffKioskUrl_({ slug: 'century' }), '');
  },

  'a store with no slug at all yields no link rather than a half-built URL': function () {
    reset();
    KV['cfg.spiffKiosk.'] = 'tok';
    _eq_('null store', M.spiffKioskUrl_(null), '');
    _eq_('empty slug', M.spiffKioskUrl_({ slug: '' }), '');
  },
};

run('spiff_kiosk_link', tests);
