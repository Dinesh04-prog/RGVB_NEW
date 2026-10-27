// Security-rules test: two shops, a cashier and a stranger, against the local Firestore emulator.
// Run: npm run test:rules   (starts the emulator, runs this file, stops the emulator — never touches the live database)
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';

const env = await initializeTestEnvironment({
  projectId: 'demo-kirana-rules',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
});

let passed = 0; const failures = [];
const check = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push(name); console.log(`  ✗ ${name}\n      ${err?.message?.split('\n')[0]}`); }
};

const as = uid => env.authenticatedContext(uid, { email: `${uid}@test.com`, email_verified: true }).firestore();
const anon = env.unauthenticatedContext().firestore();

// What createShop() in src/lib/firebase.ts writes, in one batch
const createShopBatch = (db, uid, shopId, code) => {
  const b = db.batch();
  b.set(db.doc(`shops/${shopId}`), { id: shopId, name: `Shop ${shopId}`, address: '', phone: '', whatsapp: '', ownerUid: uid, joinCode: code, createdAt: 1 });
  b.set(db.doc(`shops/${shopId}/members/${uid}`), { uid, role: 'owner', name: uid, email: `${uid}@test.com`, joinedAt: 1 });
  b.set(db.doc(`joinCodes/${code}`), { shopId });
  b.set(db.doc(`users/${uid}`), { shopId, updatedAt: 1 });
  return b.commit();
};

await env.clearFirestore();
await env.withSecurityRulesDisabled(async ctx => {
  await ctx.firestore().doc('inventory/OLD-1').set({ id: 'OLD-1', name: 'old item' });
});

const ownerA = as('ownerA'), ownerB = as('ownerB'), cashier = as('cashierA'), stranger = as('stranger');

console.log('Creating shops');
await check('owner A creates shop A', () => assertSucceeds(createShopBatch(ownerA, 'ownerA', 'shopA', '111111')));
await check('owner B creates shop B', () => assertSucceeds(createShopBatch(ownerB, 'ownerB', 'shopB', '222222')));
await check('cannot create a shop owned by someone else', () => assertFails(stranger.doc('shops/fake').set({ ownerUid: 'ownerA', joinCode: '333333' })));
await check('cannot take over an existing shop id', () => assertFails(createShopBatch(stranger, 'stranger', 'shopA', '444444')));

console.log('Shops are separate');
await check('owner B cannot read shop A', () => assertFails(ownerB.doc('shops/shopA').get()));
await check('owner B cannot read shop A inventory', () => assertFails(ownerB.collection('shops/shopA/inventory').get()));
await check('owner B cannot write shop A inventory', () => assertFails(ownerB.doc('shops/shopA/inventory/x').set({ id: 'x' })));
await check('signed-out user cannot read shop A', () => assertFails(anon.doc('shops/shopA').get()));
await check('stranger cannot read shop A reviews', () => assertFails(stranger.collection('shops/shopA/reviews').get()));
await check('cannot read another user\'s shop link', () => assertFails(ownerB.doc('users/ownerA').get()));

console.log('Join codes');
await check('stranger can look up one code', () => assertSucceeds(stranger.doc('joinCodes/111111').get()));
await check('nobody can list all codes', () => assertFails(stranger.collection('joinCodes').get()));
await check('cannot point a code at someone else\'s shop', () => assertFails(ownerB.doc('joinCodes/555555').set({ shopId: 'shopA' })));
await check('wrong code cannot join', () => assertFails(cashier.doc('shops/shopA/members/cashierA').set({ uid: 'cashierA', role: 'cashier', joinCode: '999999', joinedAt: 1 })));
await check('cannot join as owner', () => assertFails(cashier.doc('shops/shopA/members/cashierA').set({ uid: 'cashierA', role: 'owner', joinCode: '111111', joinedAt: 1 })));
await check('cannot add someone else as a member', () => assertFails(cashier.doc('shops/shopA/members/someoneElse').set({ uid: 'someoneElse', role: 'cashier', joinCode: '111111', joinedAt: 1 })));
await check('right code joins as cashier', () => assertSucceeds(cashier.doc('shops/shopA/members/cashierA').set({ uid: 'cashierA', role: 'cashier', name: 'c', email: 'c@test.com', joinCode: '111111', joinedAt: 1 })));
await check('member cannot change their own role', () => assertFails(cashier.doc('shops/shopA/members/cashierA').update({ role: 'owner' })));

console.log('Cashier inside shop A');
await check('cashier reads shop A', () => assertSucceeds(cashier.doc('shops/shopA').get()));
await check('cashier writes inventory', () => assertSucceeds(cashier.doc('shops/shopA/inventory/i1').set({ id: 'i1', name: 'Sugar', price: 40 })));
await check('cashier sends a bill for approval', () => assertSucceeds(cashier.doc('shops/shopA/reviews/r1').set({ id: 'r1', status: 'pending', createdAt: 1, cart: [] })));
await check('cashier cannot send an already-approved bill', () => assertFails(cashier.doc('shops/shopA/reviews/r2').set({ id: 'r2', status: 'approved', createdAt: 1, cart: [] })));
await check('cashier cannot approve', () => assertFails(cashier.doc('shops/shopA/reviews/r1').update({ status: 'approved' })));
await check('cashier cannot edit the shop profile', () => assertFails(cashier.doc('shops/shopA').update({ name: 'hacked' })));
await check('cashier cannot remove the owner', () => assertFails(cashier.doc('shops/shopA/members/ownerA').delete()));
await check('cashier cannot change the join code', () => assertFails(cashier.doc('joinCodes/111111').delete()));

console.log('Bill backups');
const sale = { receipt_no: 'TK-2810-A001', date: '28/10/2026', items: [], total: 45, cashierUid: 'cashierA', cashierName: 'c', ts: 1 };
await check('cashier backs up a bill', () => assertSucceeds(cashier.doc('shops/shopA/sales/TK-2810-A001_2026').set(sale)));
await check('cashier re-uploads their own bill', () => assertSucceeds(cashier.doc('shops/shopA/sales/TK-2810-A001_2026').set({ ...sale, total: 46 })));
await check('cannot upload a bill under another name', () => assertFails(cashier.doc('shops/shopA/sales/X_2026').set({ ...sale, cashierUid: 'ownerA' })));
await check('cashier reads the shop bills (restore)', () => assertSucceeds(cashier.collection('shops/shopA/sales').get()));
await check('other shop cannot read the bills', () => assertFails(ownerB.collection('shops/shopA/sales').get()));
await check('cashier cannot delete a bill', () => assertFails(cashier.doc('shops/shopA/sales/TK-2810-A001_2026').delete()));
await check('cashier takes the next phone letter', () => assertSucceeds(cashier.doc('shops/shopA/counters/devices').set({ next: 1 })));
await check('other shop cannot touch the counter', () => assertFails(ownerB.doc('shops/shopA/counters/devices').set({ next: 9 })));

console.log('Owner of shop A');
await check('owner approves the bill', () => assertSucceeds(ownerA.doc('shops/shopA/reviews/r1').update({ status: 'approved', updatedCart: [], approvedAt: 2 })));
await check('owner edits the shop profile', () => assertSucceeds(ownerA.doc('shops/shopA').update({ name: 'Shop A renamed' })));
await check('owner cannot give the shop away', () => assertFails(ownerA.doc('shops/shopA').update({ ownerUid: 'stranger' })));
await check('owner changes the join code', () => {
  const b = ownerA.batch();
  b.set(ownerA.doc('joinCodes/666666'), { shopId: 'shopA' });
  b.delete(ownerA.doc('joinCodes/111111'));
  b.update(ownerA.doc('shops/shopA'), { joinCode: '666666' });
  return assertSucceeds(b.commit());
});
await check('old code no longer joins', () => assertFails(stranger.doc('shops/shopA/members/stranger').set({ uid: 'stranger', role: 'cashier', joinCode: '111111', joinedAt: 1 })));
await check('owner record cannot be deleted', () => assertFails(ownerA.doc('shops/shopA/members/ownerA').delete()));
await check('owner deletes a bill', () => assertSucceeds(ownerA.doc('shops/shopA/sales/TK-2810-A001_2026').delete()));
await check('owner removes the cashier', () => assertSucceeds(ownerA.doc('shops/shopA/members/cashierA').delete()));
await check('removed cashier loses access', () => assertFails(cashier.collection('shops/shopA/inventory').get()));
await check('removed cashier can still see they are no longer a member', () => assertSucceeds(cashier.doc('shops/shopA/members/cashierA').get()));
await check("cannot read another user's membership in another shop", () => assertFails(ownerB.doc('shops/shopA/members/ownerA').get()));

console.log('Cashier added by Gmail');
const invited = as('ramesh'), notInvited = as('suresh');
const inviteA = { email: 'ramesh@test.com', shopId: 'shopA', shopName: 'A', invitedBy: 'ownerA', createdAt: 1 };
await check('owner A adds a Gmail', () => assertSucceeds(ownerA.doc('invites/ramesh@test.com').set(inviteA)));
await check('owner B cannot add a Gmail to shop A', () => assertFails(ownerB.doc('invites/x@test.com').set({ ...inviteA, email: 'x@test.com' })));
await check('owner B cannot take over shop A\'s invite', () => assertFails(ownerB.doc('invites/ramesh@test.com').set({ ...inviteA, shopId: 'shopB' })));
await check('invite id must be the lower-case email', () => assertFails(ownerA.doc('invites/Ramesh@test.com').set({ ...inviteA, email: 'Ramesh@test.com' })));
await check('owner A lists shop A invites', () => assertSucceeds(ownerA.collection('invites').where('shopId', '==', 'shopA').get()));
await check('owner B cannot list shop A invites', () => assertFails(ownerB.collection('invites').where('shopId', '==', 'shopA').get()));
await check('invited person reads their invite', () => assertSucceeds(invited.doc('invites/ramesh@test.com').get()));
await check('someone else cannot read it', () => assertFails(notInvited.doc('invites/ramesh@test.com').get()));
await check('not-invited person cannot join without a code', () => assertFails(notInvited.doc('shops/shopA/members/suresh').set({ uid: 'suresh', role: 'cashier', joinedAt: 1 })));
await check('invite does not open a different shop', () => assertFails(invited.doc('shops/shopB/members/ramesh').set({ uid: 'ramesh', role: 'cashier', joinedAt: 1 })));
await check('invite cannot make you owner', () => assertFails(invited.doc('shops/shopA/members/ramesh').set({ uid: 'ramesh', role: 'owner', joinedAt: 1 })));
await check('invited person joins by signing in', () => assertSucceeds(invited.doc('shops/shopA/members/ramesh').set({ uid: 'ramesh', role: 'cashier', name: 'r', email: 'ramesh@test.com', joinedAt: 1 })));
await check('invited person clears their used invite', () => assertSucceeds(invited.doc('invites/ramesh@test.com').delete()));
await check('owner cancels an invite', async () => {
  await ownerA.doc('invites/later@test.com').set({ ...inviteA, email: 'later@test.com' });
  return assertSucceeds(ownerA.doc('invites/later@test.com').delete());
});

console.log('Old single-shop inventory');
await check('signed-in user can read the old inventory (for the import)', () => assertSucceeds(ownerA.collection('inventory').get()));
await check('nobody can write the old inventory', () => assertFails(ownerA.doc('inventory/OLD-1').set({ id: 'OLD-1', name: 'changed' })));
await check('signed-out user cannot read the old inventory', () => assertFails(anon.collection('inventory').get()));

await env.cleanup();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
