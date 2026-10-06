-- DataGrippe PostgreSQL integration fixture. Applied to a fresh "datagrippe_test" database
-- by tests/setup/postgres.ts (simple protocol, one multi-statement script).

CREATE SCHEMA sales;
COMMENT ON SCHEMA sales IS 'Order management';

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'shipped', 'cancelled');
COMMENT ON TYPE public.order_status IS 'Lifecycle of an order';

CREATE DOMAIN public.email_address AS varchar(320)
  CONSTRAINT email_address_check CHECK (VALUE ~ '^[^@[:space:]]+@[^@[:space:]]+$');

CREATE TYPE public.postal_address AS (
  street text,
  city text,
  zip varchar(10)
);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

CREATE TABLE public.customers (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  email public.email_address NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  credit_limit numeric(12,2) DEFAULT 1000.00 CONSTRAINT customers_credit_limit_check CHECK (credit_limit >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  birth_date date,
  preferences jsonb DEFAULT '{}'::jsonb,
  external_id uuid,
  tags text[],
  last_ip inet,
  avatar bytea
);
COMMENT ON TABLE public.customers IS 'People who buy things';
COMMENT ON COLUMN public.customers.email IS 'Primary contact email';
COMMENT ON COLUMN public.customers.credit_limit IS 'Maximum outstanding amount, in EUR';
CREATE INDEX customers_name_lower_idx ON public.customers (lower(name));
CREATE INDEX customers_active_created_idx ON public.customers (created_at) WHERE is_active;

INSERT INTO public.customers (name, email, is_active, credit_limit, created_at, birth_date, preferences, external_id, tags, last_ip, avatar) VALUES
  ('Ada Lovelace', 'ada@example.com', true, 5000.00, '2024-01-15 09:30:00+00', '1815-12-10',
   '{"theme": "dark", "newsletter": true}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{vip,early-adopter}', '192.168.1.10', '\xdeadbeef'),
  ('Alan Turing', 'alan@example.com', true, 2500.50, '2024-02-01 14:00:00+00', '1912-06-23',
   '{"theme": "light"}', 'b1ffcd88-8d1a-4ef8-bb6d-6bb9bd380a22', '{research}', '10.0.0.7', NULL),
  ('Grace Hopper', 'grace@example.com', false, 0.00, '2024-03-10 08:15:00+00', '1906-12-09',
   '{}', NULL, '{}', NULL, NULL),
  ('Edsger Dijkstra', 'edsger@example.com', true, 1000.00, '2024-04-22 17:45:00+00', NULL,
   NULL, NULL, NULL, '2001:db8::1', '\x00ff'),
  ('Barbara Liskov', 'barbara@example.com', true, 7500.25, '2024-05-05 11:00:00+00', '1939-11-07',
   '{"theme": "dark", "langs": ["en", "fr"]}', NULL, '{vip}', '172.16.0.3', NULL);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------

CREATE TABLE sales.orders (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  status public.order_status NOT NULL DEFAULT 'pending',
  total numeric(14,2) NOT NULL DEFAULT 0,
  ordered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE sales.orders IS 'Customer orders';
CREATE INDEX orders_customer_id_idx ON sales.orders (customer_id);

CREATE FUNCTION sales.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER orders_touch_updated_at
  BEFORE UPDATE ON sales.orders
  FOR EACH ROW EXECUTE FUNCTION sales.touch_updated_at();

CREATE TABLE sales.order_items (
  order_id integer NOT NULL REFERENCES sales.orders (id) ON DELETE CASCADE ON UPDATE RESTRICT,
  line_no smallint NOT NULL,
  product varchar(120) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL,
  line_total numeric(14,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  PRIMARY KEY (order_id, line_no)
);

INSERT INTO sales.orders (customer_id, status, total, ordered_at, updated_at) VALUES
  (1, 'paid',      120.50, '2024-06-01 10:00:00+00', '2024-06-01 10:00:00+00'),
  (1, 'shipped',    89.99, '2024-06-15 12:30:00+00', '2024-06-16 08:00:00+00'),
  (2, 'pending',    15.00, '2024-07-02 09:00:00+00', '2024-07-02 09:00:00+00'),
  (3, 'cancelled', 300.00, '2022-01-20 16:00:00+00', '2022-01-21 10:00:00+00'),
  (5, 'paid',     1999.90, '2024-07-28 18:20:00+00', '2024-07-28 18:20:00+00');

INSERT INTO sales.order_items (order_id, line_no, product, quantity, unit_price) VALUES
  (1, 1, 'Mechanical keyboard', 1, 100.50),
  (1, 2, 'USB-C cable', 2, 10.00),
  (2, 1, 'Monitor arm', 1, 89.99),
  (3, 1, 'Sticker pack', 3, 5.00),
  (4, 1, 'Standing desk', 1, 300.00),
  (5, 1, 'Laptop', 1, 1999.90);

CREATE MATERIALIZED VIEW sales.monthly_totals AS
  SELECT date_trunc('month', ordered_at) AS month, count(*) AS order_count, sum(total) AS revenue
  FROM sales.orders
  WHERE status <> 'cancelled'
  GROUP BY 1;
CREATE UNIQUE INDEX monthly_totals_month_idx ON sales.monthly_totals (month);
COMMENT ON MATERIALIZED VIEW sales.monthly_totals IS 'Revenue per month';

CREATE FUNCTION sales.customer_total(p_customer_id integer) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(total), 0) FROM sales.orders WHERE customer_id = p_customer_id AND status <> 'cancelled'
$$;
COMMENT ON FUNCTION sales.customer_total(integer) IS 'Lifetime spend of a customer';

CREATE FUNCTION sales.customer_total(p_customer_id integer, p_since timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(total), 0) FROM sales.orders
  WHERE customer_id = p_customer_id AND status <> 'cancelled' AND ordered_at >= p_since
$$;

CREATE PROCEDURE sales.archive_orders()
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM sales.orders WHERE status = 'cancelled' AND ordered_at < now() - interval '1 year';
END;
$$;

-- An aggregate: must not be listed with functions.
CREATE AGGREGATE public.text_concat(text) (SFUNC = textcat, STYPE = text, INITCOND = '');

-- ---------------------------------------------------------------------------
-- Misc tables
-- ---------------------------------------------------------------------------

CREATE TABLE public.audit_log (
  happened_at timestamptz NOT NULL DEFAULT now(),
  actor text,
  action text NOT NULL,
  payload json
);
INSERT INTO public.audit_log (happened_at, actor, action, payload) VALUES
  ('2024-06-01 10:00:00+00', 'ada', 'login', '{"ip": "192.168.1.10"}'),
  ('2024-06-01 10:05:00+00', 'ada', 'order.create', '{"order": 1}');

CREATE TABLE public.big_numbers (
  id integer PRIMARY KEY,
  big int8,
  exact numeric(38,10),
  ratio float8,
  small_real real,
  tiny int2
);
INSERT INTO public.big_numbers VALUES
  (1, 9223372036854775807, 1234567890123456789012345678.0123456789, 'NaN', 1.5, 32767),
  (2, -9223372036854775808, -0.0000000001, 'Infinity', -2.25, -32768),
  (3, 9007199254740993, 0.1000000000, '-Infinity', 3.25, 0),
  (4, NULL, NULL, 0.1, NULL, NULL);

CREATE TABLE public.events (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  value integer
);
INSERT INTO public.events (kind, occurred_at, value)
  SELECT (ARRAY['click', 'view', 'purchase'])[1 + g % 3],
         timestamptz '2024-01-01 00:00:00+00' + g * interval '1 minute',
         g
  FROM generate_series(1, 10000) AS g;

CREATE TABLE public.measurements (
  sensor_id integer NOT NULL,
  measured_on date NOT NULL,
  reading numeric(8,3),
  PRIMARY KEY (sensor_id, measured_on)
) PARTITION BY RANGE (measured_on);
CREATE TABLE public.measurements_2024_h1 PARTITION OF public.measurements
  FOR VALUES FROM ('2024-01-01') TO ('2024-07-01');
CREATE TABLE public.measurements_2024_h2 PARTITION OF public.measurements
  FOR VALUES FROM ('2024-07-01') TO ('2025-01-01');
INSERT INTO public.measurements (sensor_id, measured_on, reading)
  SELECT s, date '2024-01-01' + d, round((s * 10 + d % 7)::numeric / 3, 3)
  FROM generate_series(1, 3) AS s, generate_series(0, 365, 15) AS d;

CREATE VIEW public.active_customers AS
  SELECT id, name, email, credit_limit FROM public.customers WHERE is_active;
COMMENT ON VIEW public.active_customers IS 'Customers that can place orders';

CREATE SEQUENCE public.invoice_seq AS bigint START WITH 1000 INCREMENT BY 10 CACHE 5;
COMMENT ON SEQUENCE public.invoice_seq IS 'Invoice numbers';

CREATE TABLE public."Mixed Case Table" (
  id serial PRIMARY KEY,
  "Weird Column" text,
  "order" integer
);
INSERT INTO public."Mixed Case Table" ("Weird Column", "order") VALUES
  ('first', 1),
  ('it''s quoted', 2),
  (NULL, 3);

ANALYZE;
