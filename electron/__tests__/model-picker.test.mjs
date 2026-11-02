// Model picker data: the cached catalog, the current model, the typed command.
import { normalizeCatalog, readModelCatalog, currentFromRecord, findModel, pickerCommand } from '../model-picker.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

const eff = (ids, rec) => ({ type: 'effort', effort_options: ids.map((id) => ({ id, name: id === 'xhigh' ? 'Extra' : id[0].toUpperCase() + id.slice(1), ...(id === rec ? { badge: { message: 'Recommended', variant: 'neutral' } } : {}) })) });
// The shape measured in ~/.claude/cache/model-catalog/*-cc.json (2.1.316).
const file = (fetchedAt, extra = []) => ({
  version: 2, fetchedAt, staleAt: fetchedAt + 3600e3,
  catalog: { surface: 'cc', config: { id: 'cc', models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', short_name: 'Opus', description: 'For complex work and everyday tasks', section: 'main', thinking: eff(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), runtime: { default_effort: 'medium' } },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', section: 'main', thinking: eff(['low', 'medium', 'high', 'xhigh', 'max'], 'medium'), runtime: { default_effort: 'medium' } },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow', thinking: { type: 'none' } },
    { id: 'claude-opus-4-6', name: 'Opus 4.6', section: 'overflow', thinking: eff(['low', 'medium', 'high', 'max'], 'high'), runtime: { default_effort: 'high' } },
    ...extra,
  ] } },
});

// --- normalizeCatalog ----------------------------------------------------------
{
  const c = normalizeCatalog(file(1000));
  check('models in catalog order', c.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6']);
  check('main vs overflow', c.models.map((m) => m.section), ['main', 'main', 'overflow', 'overflow']);
  check('effort levels with names and the Recommended badge', c.models[0].efforts, [
    { id: 'low', name: 'Low', badge: null }, { id: 'medium', name: 'Medium', badge: 'Recommended' }, { id: 'high', name: 'High', badge: null },
    { id: 'xhigh', name: 'Extra', badge: null }, { id: 'max', name: 'Max', badge: null }]);
  check('a model with no effort has none', c.models[2].efforts, []);
  check('default effort kept', c.models[3].defaultEffort, 'high');
  const bad = normalizeCatalog(file(1, [
    { id: 'claude-opus-5-5', name: 'dupe' },
    { id: 'gpt-6; rm -rf ~', name: 'Evil' },
    { id: 'claude-x', name: '' },
    { id: 'claude-y', name: 'Y', thinking: { type: 'effort', effort_options: [{ id: 'ultra', name: 'Ultra' }, { id: 'low' }] } },
  ]));
  check('duplicates, bad ids and nameless models are dropped', bad.models.map((m) => m.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-y']);
  check('unknown effort levels dropped, a nameless one named by its id', bad.models.at(-1).efforts, [{ id: 'low', name: 'low', badge: null }]);
  check('not a catalog -> null', [normalizeCatalog(null), normalizeCatalog({ catalog: {} }), normalizeCatalog({ catalog: { config: { models: [] } } })], [null, null, null]);
}

// --- readModelCatalog ---------------------------------------------------------
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-picker-'));
  const acct = path.join(root, 'acct'); const home = path.join(root, 'home');
  for (const d of [acct, home]) fs.mkdirSync(path.join(d, 'cache', 'model-catalog'), { recursive: true });
  fs.writeFileSync(path.join(home, 'cache', 'model-catalog', 'org-a-cc.json'), JSON.stringify(file(500)));
  check('falls back to the default home', (await readModelCatalog([acct, home]))?.fetchedAt, 500);
  fs.writeFileSync(path.join(acct, 'cache', 'model-catalog', 'org-b-old-cc.json'), JSON.stringify(file(700)));
  fs.writeFileSync(path.join(acct, 'cache', 'model-catalog', 'org-b-new-cc.json'), JSON.stringify(file(900)));
  fs.writeFileSync(path.join(acct, 'cache', 'model-catalog', 'broken-cc.json'), '{not json');
  check("the session's account first, its newest file", (await readModelCatalog([acct, home]))?.fetchedAt, 900);
  check('relative or missing dirs are skipped', await readModelCatalog(['rel/dir', path.join(root, 'nope')]), null);
  // One cache dir can hold several organisations' catalogs: with the account's
  // organisation known, only ITS file counts, however fresh another is.
  fs.writeFileSync(path.join(acct, 'cache', 'model-catalog', '1ac35652-aaaa-cc.json'), JSON.stringify(file(800)));
  fs.writeFileSync(path.join(acct, 'cache', 'model-catalog', '33dd719e-bbbb-cc.json'), JSON.stringify(file(950)));
  check("the account's organisation, not the freshest file", (await readModelCatalog([acct], '1ac35652'))?.fetchedAt, 800);
  check('an organisation with no catalog gets none, never another account\'s', await readModelCatalog([acct, home], '99999999'), null);
  check('a malformed organisation id is ignored (newest file)', (await readModelCatalog([acct], '../x'))?.fetchedAt, 950);
  fs.rmSync(root, { recursive: true, force: true });
}

// --- currentFromRecord --------------------------------------------------------
{
  const rec = (set, dir, payload) => `DOBIUS1 ${set ? 1 : 0}\n${dir}\n${JSON.stringify(payload)}`;
  const p = { session_id: 's', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'medium' } };
  check('model and effort from the payload', currentFromRecord(rec(false, '', p)), { modelId: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'medium', configDir: '' });
  check('an account binding names its home', currentFromRecord(rec(true, '/Users/x/.claude-profiles/a', p)).configDir, '/Users/x/.claude-profiles/a');
  check('a relative binding names none', currentFromRecord(rec(true, 'rel', p)).configDir, null);
  check('an unknown effort is null', currentFromRecord(rec(false, '', { ...p, effort: { level: 'turbo' } })).effort, null);
  check('no model -> null', currentFromRecord(rec(false, '', { session_id: 's' })), null);
  check('garbage -> null', [currentFromRecord('x'), currentFromRecord('a\nb\n{'), currentFromRecord(null)], [null, null, null]);
  check('another format marker -> null', currentFromRecord(`OTHER 0\n\n${JSON.stringify(p)}`), null);
}

// --- pickerCommand -------------------------------------------------------------
{
  const c = normalizeCatalog(file(1));
  check('a catalog model', pickerCommand({ model: 'claude-sonnet-5-5' }, c, 'claude-opus-5-5'), '/model claude-sonnet-5-5');
  check('a model not in the catalog is refused', pickerCommand({ model: 'claude-opus-9' }, c, 'claude-opus-5-5'), null);
  check('anything else typed is refused', pickerCommand({ model: 'claude-opus-5-5\r/exit' }, c, 'claude-opus-5-5'), null);
  check('an effort the current model offers', pickerCommand({ effort: 'xhigh' }, c, 'claude-opus-5-5'), '/effort xhigh');
  check('an effort it does not offer is refused', pickerCommand({ effort: 'xhigh' }, c, 'claude-opus-4-6'), null);
  check('no effort on a model without levels', pickerCommand({ effort: 'low' }, c, 'claude-haiku-4-5-20251001'), null);
  check('a dated id finds its catalog model', findModel(c, 'claude-haiku-4-5')?.id, 'claude-haiku-4-5-20251001');
  check('nothing chosen', [pickerCommand(null, c, 'x'), pickerCommand({}, c, 'x'), pickerCommand({ model: 'claude-opus-5-5' }, null, 'x')], [null, null, null]);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
