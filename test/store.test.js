/**
 * Tests for how the browser store handles the demo wallet.
 *
 * One rule, easy to get subtly wrong: the demo is added whenever it is absent
 * and has not been deleted. "Absent" and "deleted" look identical in storage
 * and mean opposite things, so the deletion is recorded separately. Read the
 * first as the second and nobody ever sees the example; read the second as the
 * first and it returns from the dead on every reload.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Just enough localStorage to run the store. */
class MemoryStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

const KEY = 'sd:wallets';

/**
 * The store reads module-level state, so each case needs a fresh copy of it.
 * A cache-busting query on the import specifier is the standard way to get one.
 */
let counter = 0;
async function loadWith(storage) {
  globalThis.localStorage = storage;
  const mod = await import(`../public/js/store.js?case=${counter++}`);
  return { ...mod, store: mod.loadStore() };
}

describe('the demo wallet', () => {
  beforeEach(() => {
    globalThis.localStorage = new MemoryStorage();
  });

  test('a first visit lands on a populated wallet, not a form', async () => {
    const { store } = await loadWith(new MemoryStorage());

    assert.equal(store.wallets.length, 1);
    assert.equal(store.wallets[0].name, 'Demo portfolio');
    assert.equal(store.wallets[0].holdings.length, 10);
  });

  test('every demo holding is usable by the tabs that need dates and costs', async () => {
    // Income counts from the purchase date, the score line steps when a holding
    // joins, and gain needs a cost basis. A demo missing any of those
    // demonstrates an empty state instead of a feature.
    const { store } = await loadWith(new MemoryStorage());

    for (const holding of store.wallets[0].holdings) {
      assert.ok(holding.shares > 0, `${holding.symbol} shares`);
      assert.ok(holding.cost > 0, `${holding.symbol} cost basis`);
      assert.match(holding.boughtAt, /^\d{4}-\d{2}-\d{2}$/, `${holding.symbol} purchase date`);
    }
  });

  test('the holdings are spread rather than ten of the same thing', async () => {
    const { store } = await loadWith(new MemoryStorage());
    const symbols = store.wallets[0].holdings.map((h) => h.symbol);
    const dates = store.wallets[0].holdings.map((h) => h.boughtAt);

    assert.equal(new Set(symbols).size, 10, 'no duplicates');
    // Staggered purchases are what makes the value series step and the score
    // line move for a reason other than prices.
    assert.ok(new Set(dates).size >= 8, 'purchases are spread over time');
  });

  test('someone who already has wallets gets it too, alongside their own', async () => {
    // Seeding only on a first run meant everyone who had already used the app
    // never saw the example, which is most of the people who would want it.
    const mine = [{ id: 'w1', name: 'Mine', holdings: [{ symbol: 'AAPL', shares: 5, cost: 100, boughtAt: '2024-01-02' }] }];
    const { store } = await loadWith(new MemoryStorage({ [KEY]: JSON.stringify(mine) }));

    assert.equal(store.wallets.length, 2);
    assert.equal(store.wallets[0].name, 'Mine', 'their own stays first');
    assert.equal(store.wallets[1].id, 'demo');
  });

  test('deleting the demo keeps it deleted', async () => {
    // The regression this guards: absence read as "not seeded yet" rather than
    // as "removed", so it returns on every reload and cannot be got rid of.
    const storage = new MemoryStorage();
    const first = await loadWith(storage);
    first.deleteWallet('demo');

    const again = await loadWith(storage);
    assert.ok(!again.store.wallets.some((w) => w.id === 'demo'));
  });

  test('deleting a different wallet does not remove the demo', async () => {
    const mine = [{ id: 'w1', name: 'Mine', holdings: [{ symbol: 'AAPL', shares: 5, cost: 100, boughtAt: '2024-01-02' }] }];
    const storage = new MemoryStorage({ [KEY]: JSON.stringify(mine) });
    const first = await loadWith(storage);
    first.deleteWallet('w1');

    const again = await loadWith(storage);
    assert.ok(again.store.wallets.some((w) => w.id === 'demo'));
  });

  test('it is not duplicated when it is already saved', async () => {
    const storage = new MemoryStorage();
    const first = await loadWith(storage);
    first.saveWallets();

    const again = await loadWith(storage);
    assert.equal(again.store.wallets.filter((w) => w.id === 'demo').length, 1);
  });

  test('the demo survives a round trip through storage unchanged', async () => {
    // It goes through the same normaliser as anything the user types, so a
    // field the normaliser drops would silently empty the demo.
    const storage = new MemoryStorage();
    const first = await loadWith(storage);
    first.saveWallets();

    const again = await loadWith(storage);
    assert.equal(again.store.wallets[0].holdings.length, 10);
    assert.equal(again.store.wallets[0].holdings[0].cost, 287.15);
    assert.equal(again.store.wallets[0].holdings[0].boughtAt, '2022-03-15');
  });
});
