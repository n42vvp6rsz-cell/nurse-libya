'use strict';

// Actual PostgreSQL execution against synthetic, in-memory fixtures only.
// No config.js, credentials, network, or production/patient rows are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { ({ PGlite } = require('/tmp/nurse-libya-sql-runtime/node_modules/@electric-sql/pglite')); }

const uid = {
  admin: '00000000-0000-4000-8000-000000000001',
  customer: '00000000-0000-4000-8000-000000000002',
  stranger: '00000000-0000-4000-8000-000000000003'
};
const product = {
  first: '10000000-0000-4000-8000-000000000001',
  second: '10000000-0000-4000-8000-000000000002',
  inactive: '10000000-0000-4000-8000-000000000003'
};
const order = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const details = ['مستخدم تجريبي', '0928482128', 'طرابلس', 'عنوان تجريبي للتوصيل', null];
let db, checks = 0;

async function as(who, fn) {
  await db.exec('RESET ROLE');
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [who === 'anon' ? '' : uid[who]]);
  await db.exec(`SET ROLE ${who === 'anon' ? 'anon' : 'authenticated'}`);
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
}
async function check(name, fn) {
  await fn(); checks++; process.stdout.write(`PASS ${name}\n`);
}
async function fail(fn, expression) {
  await assert.rejects(fn, expression);
}
async function checkout(n, items = [{ product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 }], who = 'customer', extra = details) {
  return as(who, () => db.query('SELECT * FROM public.checkout_store_order($1,$2::jsonb,$3,$4,$5,$6,$7)',
    [order(n), JSON.stringify(items), ...extra]));
}
async function transition(n, expected, target, who = 'admin') {
  return as(who, () => db.query('SELECT * FROM public.transition_store_order($1,$2,$3)', [order(n), expected, target]));
}
async function stock(id = product.first) {
  return (await db.query('SELECT stock_quantity FROM public.store_products WHERE id=$1', [id])).rows[0].stock_quantity;
}
async function reset() {
  await db.exec('RESET ROLE; TRUNCATE public.store_order_items,public.store_orders,public.store_products;');
  await as('admin', () => db.query(`INSERT INTO public.store_products(id,title,description,category,price_minor,stock_quantity,is_active)
    VALUES ($1,'منتج تجريبي أ','بيانات اختبار محلية','اختبار',12500,10,true),
           ($2,'منتج تجريبي ب',NULL,NULL,3750,4,true),
           ($3,'منتج تجريبي غير منشور',NULL,NULL,1000,8,false)`, Object.values(product)));
}

(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE SCHEMA auth;
    CREATE SCHEMA private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;
    GRANT USAGE ON SCHEMA private TO authenticated;
    CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),role text NOT NULL DEFAULT 'patient');
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    GRANT SELECT ON public.profiles TO authenticated;
    CREATE POLICY "fixture own profile read" ON public.profiles FOR SELECT TO authenticated USING(id=(SELECT auth.uid()));
    CREATE FUNCTION private.is_current_user_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
      SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.profiles WHERE id=auth.uid() AND role='admin');
    $$;
    REVOKE ALL ON FUNCTION private.is_current_user_admin() FROM PUBLIC,anon;
    GRANT EXECUTE ON FUNCTION private.is_current_user_admin() TO authenticated;
  `);
  for (const [name, id] of Object.entries(uid)) {
    await db.query('INSERT INTO auth.users(id) VALUES($1)', [id]);
    await db.query('INSERT INTO public.profiles(id,role) VALUES($1,$2)', [id, name === 'admin' ? 'admin' : 'patient']);
  }
  await db.exec(fs.readFileSync(path.join(__dirname, '../docs/store-database.sql'), 'utf8'));
  const version = (await db.query('SELECT version()')).rows[0].version;
  process.stdout.write(`Engine: ${version}\n`);
  assert.match(version, /PostgreSQL 17\./, 'runtime proof must use production PostgreSQL major 17');

  await check('contract marker and tables use RLS; public wrappers are invoker', async () => {
    assert.equal((await as('anon', () => db.query('SELECT public.nurse_store_contract_version() AS version'))).rows[0].version, 1);
    const tables = (await db.query("SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('store_products','store_orders','store_order_items') ORDER BY relname")).rows;
    assert.equal(tables.length, 3); assert.ok(tables.every(x => x.relrowsecurity));
    const exposed = (await db.query("SELECT proname,prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('checkout_store_order','transition_store_order','nurse_store_contract_version')")).rows;
    assert.equal(exposed.length, 3); assert.ok(exposed.every(x => !x.prosecdef));
  });
  await reset();
  await check('active catalog is public; inactive catalog is admin-only', async () => {
    assert.equal((await as('anon', () => db.query('SELECT id FROM public.store_products'))).rows.length, 2);
    assert.equal((await as('customer', () => db.query('SELECT id FROM public.store_products'))).rows.length, 2);
    assert.equal((await as('admin', () => db.query('SELECT id FROM public.store_products'))).rows.length, 3);
  });
  await check('ordinary customers cannot create products or change stock', async () => {
    await fail(() => as('customer', () => db.query("INSERT INTO public.store_products(title,price_minor) VALUES('تلاعب تجريبي',1)")), /row-level security/);
    assert.equal((await as('customer', () => db.query('UPDATE public.store_products SET stock_quantity=999 WHERE id=$1 RETURNING id', [product.first]))).rows.length, 0);
    assert.equal(await stock(), 10);
  });
  await check('admin product CAS update is server-timestamped and stale CAS matches zero', async () => {
    const old = (await as('admin', () => db.query('SELECT updated_at::text AS updated_at FROM public.store_products WHERE id=$1', [product.first]))).rows[0].updated_at;
    const saved = await as('admin', () => db.query('UPDATE public.store_products SET description=$1 WHERE id=$2 AND updated_at=$3 RETURNING updated_at::text AS updated_at', ['وصف تجريبي معدل', product.first, old]));
    assert.equal(saved.rows.length, 1); assert.notEqual(saved.rows[0].updated_at, old);
    assert.equal((await as('admin', () => db.query('UPDATE public.store_products SET description=$1 WHERE id=$2 AND updated_at=$3 RETURNING id', ['متأخر', product.first, old]))).rows.length, 0);
    await fail(() => as('admin', () => db.query('UPDATE public.store_products SET created_at=now() WHERE id=$1', [product.first])), /permission denied/);
  });
  await check('product URL, currency, quantity, and money constraints reject invalid input', async () => {
    for (const url of ['javascript:alert(1)', 'https://name:password@example.com/image.png', 'https://example.com/with space']) {
      await fail(() => as('admin', () => db.query('UPDATE public.store_products SET image_url=$1 WHERE id=$2', [url, product.first])), /check constraint/);
    }
    await fail(() => as('admin', () => db.query('UPDATE public.store_products SET price_minor=0 WHERE id=$1', [product.first])), /check constraint/);
    await fail(() => as('admin', () => db.query('UPDATE public.store_products SET stock_quantity=-1 WHERE id=$1', [product.first])), /check constraint/);
    await fail(() => as('admin', () => db.query("INSERT INTO public.store_products(title,price_minor,currency) VALUES('منتج تجريبي',100,'USD')")), /permission denied/);
  });
  await check('anonymous checkout and private privileged function calls are denied', async () => {
    await fail(() => checkout(1, undefined, 'anon'), /permission denied/);
    await fail(() => as('anon', () => db.query('SELECT * FROM private.checkout_store_order($1,$2,$3,$4,$5,$6,$7)', [order(1), '[]', ...details])), /permission denied/);
  });
  await check('server prices and LYD 1/1000 snapshots reserve stock atomically', async () => {
    const items = [
      { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750, price_minor: 1 },
      { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500, price_minor: 1 }
    ];
    const result = await checkout(2, items);
    assert.equal(result.rows.length, 1); assert.equal(Number(result.rows[0].total_minor), 28750);
    assert.equal(result.rows[0].currency, 'LYD'); assert.equal(result.rows[0].status, 'pending');
    assert.equal(await stock(), 8); assert.equal(await stock(product.second), 3);
    const lines = (await as('customer', () => db.query('SELECT title,quantity,unit_price_minor,line_total_minor FROM public.store_order_items WHERE order_id=$1 ORDER BY product_id', [order(2)]))).rows;
    assert.deepEqual(lines.map(x => [x.quantity, x.unit_price_minor, Number(x.line_total_minor)]), [[2,12500,25000],[1,3750,3750]]);
    const header = (await as('customer', () => db.query('SELECT user_id,phone,payment_method,total_minor FROM public.store_orders WHERE id=$1', [order(2)]))).rows[0];
    assert.equal(header.user_id, uid.customer); assert.equal(header.phone, '+218928482128'); assert.equal(header.payment_method, 'cash_on_delivery');
  });
  await check('own header/items are private; request payload and direct order mutations are inaccessible', async () => {
    assert.equal((await as('stranger', () => db.query('SELECT id FROM public.store_orders WHERE id=$1', [order(2)]))).rows.length, 0);
    assert.equal((await as('stranger', () => db.query('SELECT order_id FROM public.store_order_items WHERE order_id=$1', [order(2)]))).rows.length, 0);
    assert.equal((await as('admin', () => db.query('SELECT id FROM public.store_orders WHERE id=$1', [order(2)]))).rows.length, 1);
    await fail(() => as('customer', () => db.query('SELECT request_payload FROM public.store_orders')), /permission denied/);
    await fail(() => as('customer', () => db.query('SELECT * FROM public.store_orders')), /permission denied/);
    await fail(() => as('customer', () => db.query("UPDATE public.store_orders SET status='completed' WHERE id=$1", [order(2)])), /permission denied/);
    await fail(() => as('admin', () => db.query("UPDATE public.store_orders SET total_minor=1 WHERE id=$1", [order(2)])), /permission denied/);
    await fail(() => as('customer', () => db.query('DELETE FROM public.store_order_items WHERE order_id=$1', [order(2)])), /permission denied/);
    await fail(() => as('customer', () => db.query("INSERT INTO public.store_orders(id,user_id,customer_name,phone,city,address,total_minor,request_payload) VALUES($1,$2,'اختبار','+218928482128','طرابلس','عنوان تجريبي',1,'{}')", [order(3), uid.customer])), /permission denied/);
  });
  await check('same frozen UUID returns saved order before current catalog price/stock checks', async () => {
    await as('admin', () => db.query('UPDATE public.store_products SET price_minor=99999,is_active=false WHERE id=$1', [product.first]));
    const before = await stock();
    const retry = await checkout(2, [
      { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 },
      { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750 }
    ]);
    assert.equal(Number(retry.rows[0].total_minor), 28750); assert.equal(await stock(), before);
    assert.equal((await db.query('SELECT count(*) AS n FROM public.store_orders')).rows[0].n, 1);
  });
  await check('same UUID cannot cross users or silently adopt edited payload', async () => {
    await fail(() => checkout(2, [
      { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 },
      { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750 }
    ], 'stranger'), /reference is unavailable/);
    await fail(() => checkout(2), /different saved request/);
    await fail(() => checkout(2, [
      { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 },
      { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750 }
    ], 'customer', ['مستخدم مختلف', ...details.slice(1)]), /different saved request/);
  });
  await reset();
  await check('changed displayed price rejects before order creation or stock reservation', async () => {
    await fail(() => checkout(10, [{ product_id: product.first, quantity: 2, expected_unit_price_minor: 1 }]), /price changed/);
    assert.equal(await stock(), 10); assert.equal((await db.query('SELECT count(*) AS n FROM public.store_orders')).rows[0].n, 0);
  });
  await check('last unavailable or low-stock line rolls back the whole multi-item transaction', async () => {
    const first = { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 };
    await fail(() => checkout(11, [first, { product_id: product.second, quantity: 5, expected_unit_price_minor: 3750 }]), /insufficient stock/);
    await fail(() => checkout(12, [first, { product_id: product.inactive, quantity: 1, expected_unit_price_minor: 1000 }]), /unavailable/);
    assert.equal(await stock(), 10); assert.equal(await stock(product.second), 4);
    assert.equal((await db.query('SELECT count(*) AS n FROM public.store_orders')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*) AS n FROM public.store_order_items')).rows[0].n, 0);
  });
  await check('a failure after header/first inventory write rolls back every order and stock mutation', async () => {
    await db.exec(`CREATE FUNCTION private.fixture_store_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${product.second}'::uuid THEN RAISE EXCEPTION 'synthetic late inventory failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_fixture_store_write_failure BEFORE UPDATE ON public.store_products
        FOR EACH ROW EXECUTE FUNCTION private.fixture_store_write_failure();`);
    try {
      await fail(() => checkout(18, [
        { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 },
        { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750 }
      ]), /synthetic late inventory failure/);
      assert.equal(await stock(), 10); assert.equal(await stock(product.second), 4);
      assert.equal((await db.query('SELECT count(*) AS n FROM public.store_orders')).rows[0].n, 0);
      assert.equal((await db.query('SELECT count(*) AS n FROM public.store_order_items')).rows[0].n, 0);
    } finally {
      await db.exec('DROP TRIGGER zz_fixture_store_write_failure ON public.store_products; DROP FUNCTION private.fixture_store_write_failure();');
    }
  });
  await check('invalid quantities, duplicate UUIDs, missing displayed price, and oversized cart reject', async () => {
    const valid = { product_id: product.first, quantity: 1, expected_unit_price_minor: 12500 };
    for (const items of [[], {}, [{...valid, quantity: 0}], [{...valid, quantity: 100}], [{...valid, quantity: 1.5}],
      [{...valid, quantity: '2'}], [{...valid, expected_unit_price_minor: undefined}], [valid, {...valid, product_id: product.first.toUpperCase()}],
      Array.from({length: 21}, () => valid)]) {
      await fail(() => checkout(13, items), /items must|select 1 to 20|invalid product|duplicate product/);
    }
    assert.equal(await stock(), 10);
  });
  await check('delivery validation and Arabic-digit contact normalization are enforced server-side', async () => {
    await fail(() => checkout(14, undefined, 'customer', ['ا', ...details.slice(1)]), /invalid customer/);
    await fail(() => checkout(14, undefined, 'customer', [details[0], '999', ...details.slice(2)]), /invalid Libyan/);
    const result = await checkout(15, undefined, 'customer', [details[0], '٠٩٢ ٨٤٨ ٢١٢٨', ...details.slice(2)]);
    assert.equal(result.rows.length, 1);
    assert.equal((await db.query('SELECT phone FROM public.store_orders WHERE id=$1', [order(15)])).rows[0].phone, '+218928482128');
  });
  await check('ordinary users cannot call admin transitions', async () => {
    await fail(() => transition(15, 'pending', 'confirmed', 'customer'), /admin access required/);
    assert.equal((await db.query('SELECT status FROM public.store_orders WHERE id=$1', [order(15)])).rows[0].status, 'pending');
  });
  await check('pending/confirmed transitions honor expected status and terminal restrictions', async () => {
    assert.equal((await transition(15, 'pending', 'confirmed')).rows[0].status, 'confirmed');
    await fail(() => transition(15, 'pending', 'cancelled'), /order changed/);
    await fail(() => transition(15, 'confirmed', 'pending'), /transition is not allowed/);
    assert.equal((await transition(15, 'confirmed', 'completed')).rows[0].status, 'completed');
    await fail(() => transition(15, 'completed', 'cancelled'), /transition is not allowed/);
    assert.equal(await stock(), 8);
  });
  await check('cancellation restores reserved stock exactly once including inactive products', async () => {
    await checkout(16);
    assert.equal(await stock(), 6);
    await as('admin', () => db.query('UPDATE public.store_products SET is_active=false WHERE id=$1', [product.first]));
    assert.equal((await transition(16, 'pending', 'cancelled')).rows[0].status, 'cancelled');
    assert.equal(await stock(), 8);
    await fail(() => transition(16, 'pending', 'cancelled'), /order changed/);
    await fail(() => transition(16, 'cancelled', 'cancelled'), /transition is not allowed/);
    assert.equal(await stock(), 8);
    const retry = await checkout(16);
    assert.equal(retry.rows[0].status, 'cancelled'); assert.equal(await stock(), 8);
  });
  await reset();
  await check('a late cancellation inventory failure rolls back status and all partial restorations', async () => {
    await checkout(19, [
      { product_id: product.first, quantity: 2, expected_unit_price_minor: 12500 },
      { product_id: product.second, quantity: 1, expected_unit_price_minor: 3750 }
    ]);
    await db.exec(`CREATE FUNCTION private.fixture_store_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${product.second}'::uuid AND NEW.stock_quantity>OLD.stock_quantity
        THEN RAISE EXCEPTION 'synthetic late restoration failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_fixture_store_cancel_failure BEFORE UPDATE ON public.store_products
        FOR EACH ROW EXECUTE FUNCTION private.fixture_store_cancel_failure();`);
    try {
      await fail(() => transition(19, 'pending', 'cancelled'), /synthetic late restoration failure/);
      assert.equal(await stock(), 8); assert.equal(await stock(product.second), 3);
      const saved = (await db.query('SELECT status,cancelled_at FROM public.store_orders WHERE id=$1', [order(19)])).rows[0];
      assert.equal(saved.status, 'pending'); assert.equal(saved.cancelled_at, null);
    } finally {
      await db.exec('DROP TRIGGER zz_fixture_store_cancel_failure ON public.store_products; DROP FUNCTION private.fixture_store_cancel_failure();');
    }
    await transition(19, 'pending', 'cancelled'); assert.equal(await stock(), 10); assert.equal(await stock(product.second), 4);
  });
  await reset();
  await check('restock capacity includes outstanding reservations so cancellation remains possible', async () => {
    await checkout(20);
    await fail(() => as('admin', () => db.query('UPDATE public.store_products SET stock_quantity=100000 WHERE id=$1', [product.first])), /reserved stock exceeds/);
    await as('admin', () => db.query('UPDATE public.store_products SET stock_quantity=99998 WHERE id=$1', [product.first]));
    await transition(20, 'pending', 'cancelled'); assert.equal(await stock(), 100000);
  });
  await check('money bounds remain safe integers at maximum allowed quantities', async () => {
    await reset();
    await as('admin', () => db.query('UPDATE public.store_products SET price_minor=100000000,stock_quantity=100000 WHERE id=$1', [product.first]));
    const result = await checkout(21, [{product_id: product.first, quantity: 99, expected_unit_price_minor: 100000000}]);
    assert.equal(Number(result.rows[0].total_minor), 9900000000);
    assert.ok(Number.isSafeInteger(Number(result.rows[0].total_minor)));
  });
  process.stdout.write(`Store PostgreSQL runtime: ${checks} checks passed; synthetic in-memory data only.\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; })
  .finally(async () => { if (db) await db.close(); });
