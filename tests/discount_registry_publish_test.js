// ============================================================
//  discounts.gs — the discount registry, published to GX Core kv `discountRegistry`
//
//  GX Crew's discount screen read discount NAMES straight from this app's /exec (app-to-app).
//  It now reads them from GX Core, in the shape Crew asked for on 2026-09-14. What must hold:
//
//    1. The shape is exactly { builtAt, counts, discretionary:[{name,code,method}], autoExcluded }.
//    2. NO exclusion state leaks into it. Which discounts are excluded lives only in
//       `discountRules`; a copy here is two sources for one pay-affecting decision.
//    3. It never writes `discountRules`.
//    4. A failed publish never breaks the rebuild, and is retried -- throttled, not every 5 minutes.
//
//  Run:  node tests/discount_registry_publish_test.js
// ============================================================

const H = require('./_harness.js');
const { _eq_, _ok_ } = H;

const REG = {
  builtAt: '2026-09-14T18:49:53.309Z',
  byName: {
    'Veteran 10%':          { appMethod: 'Manual',    code: 'VET',  klass: 'discretionary' },
    'Employee Discount':    { appMethod: 'Code',      code: 'EMP',  klass: 'discretionary' },
    'Happy Hour':           { appMethod: 'Automatic', code: '',     klass: 'automatic' },
    'Points Redemption $5': { appMethod: 'Code',      code: 'PTS5', klass: 'loyalty' },
  },
};

let props, posts, fetchMode;

function build(p) {
  props = Object.assign({ GX_DEPLOY_SECRET: 'deploy-secret' }, p || {});
  posts = [];
  fetchMode = 'ok';
  return H.load(['dutchie_proxy.gs', 'dutchie_fetch.gs', 'discounts.gs'], {
    stubs: {
      PropertiesService: { getScriptProperties: function () {
        return {
          getProperty: function (k) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null; },
          setProperty: function (k, v) { props[k] = String(v); return this; },
        };
      } },
      UrlFetchApp: { fetch: function (url, opts) {
        posts.push({ url: url, opts: opts, body: JSON.parse(opts.payload) });
        if (fetchMode === 'throw') throw new Error('Address unavailable');
        const text = fetchMode === 'html' ? '<!DOCTYPE html><html>' : JSON.stringify({ ok: true });
        return { getContentText: function () { return text; }, getResponseCode: function () { return fetchMode === 'html' ? 404 : 200; } };
      } },
    },
  });
}

H.run('discount_registry_publish', {

  shapeIsExactlyWhatCrewReads: function () {
    const A = build();
    const out = A.discountRegistryPayload_(REG);
    _eq_('top-level keys', Object.keys(out).sort(), ['autoExcluded', 'builtAt', 'counts', 'discretionary']);
    _eq_('builtAt carried through', out.builtAt, REG.builtAt);
    _eq_('counts', out.counts, { automatic: 1, loyalty: 1, discretionary: 2 });
    _eq_('discretionary rows: name, code, method, sorted',
      out.discretionary, [{ name: 'Employee Discount', code: 'EMP', method: 'Code' },
                          { name: 'Veteran 10%', code: 'VET', method: 'Manual' }]);
    _eq_('autoExcluded groups', out.autoExcluded, { automatic: ['Happy Hour'], loyalty: ['Points Redemption $5'] });
  },

  noExclusionStateLeaks: function () {
    const A = build();
    const text = JSON.stringify(A.discountRegistryPayload_(REG));
    _ok_('no `excluded` anywhere in the published value', text.indexOf('excluded"') === -1 && text.indexOf('overrides') === -1);
  },

  publishesToDiscountRegistryOnly: function () {
    const A = build();
    const r = A.publishDiscountRegistry_(REG);
    _eq_('publish ok', r.ok, true);
    _eq_('one POST', posts.length, 1);
    _eq_('to set_config', posts[0].body.action, 'set_config');
    _eq_('key is discountRegistry, never discountRules', posts[0].body.key, 'discountRegistry');
    _eq_('value round-trips to the payload', JSON.parse(posts[0].body.value), A.discountRegistryPayload_(REG));
    _eq_('published builtAt remembered', props.GC_DISCOUNT_REGISTRY_PUBLISHED_AT, REG.builtAt);
  },

  failureNeverThrowsAndIsNotMarkedPublished: function () {
    const A = build();
    fetchMode = 'html';
    const r = A.publishDiscountRegistry_(REG);
    _eq_('an HTML flake reads as a failure, not a success', r.ok, false);
    _eq_('not marked published, so it is retried', props.GC_DISCOUNT_REGISTRY_PUBLISHED_AT, undefined);
    fetchMode = 'throw';
    _eq_('a thrown fetch is contained too', A.publishDiscountRegistry_(REG).ok, false);
  },

  retryIsThrottled: function () {
    const A = build({ GC_DISCOUNT_REGISTRY_PUBLISH_TRIED: String(Date.now() - 5 * 60000) });
    _eq_('tried 5 minutes ago: no retry yet', A.publishDiscountRegistryIfPending_(REG), null);
    _eq_('no POST made', posts.length, 0);

    props.GC_DISCOUNT_REGISTRY_PUBLISH_TRIED = String(Date.now() - 31 * 60000);
    _eq_('tried 31 minutes ago: retried', A.publishDiscountRegistryIfPending_(REG).ok, true);

    posts = [];
    _eq_('already published this builtAt: nothing to do', A.publishDiscountRegistryIfPending_(REG), null);
    _eq_('and no POST', posts.length, 0);
  },

  noSecretNoPost: function () {
    const A = build();
    delete props.GX_DEPLOY_SECRET;
    _eq_('without the deploy secret it refuses before calling out', A.publishDiscountRegistry_(REG).ok, false);
    _eq_('no POST', posts.length, 0);
  },
});
