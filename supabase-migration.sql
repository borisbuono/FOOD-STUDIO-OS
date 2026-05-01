-- Restaurants
CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text UNIQUE NOT NULL
);
INSERT INTO restaurants (name, slug) VALUES ('Taller', 'taller'), ('Bistro Mondo', 'bistro-mondo') ON CONFLICT (slug) DO NOTHING;

-- Events
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  date date,
  guests integer DEFAULT 0,
  status text DEFAULT 'confirmed',
  price_per_head numeric(10,2) DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid REFERENCES events(id) ON DELETE CASCADE,
  name text NOT NULL,
  qty integer DEFAULT 1,
  cost_per numeric(10,2) DEFAULT 0,
  price_per numeric(10,2) DEFAULT 0
);

-- Recipes
CREATE TABLE IF NOT EXISTS recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  section text,
  portions integer DEFAULT 1,
  description text,
  cost_per_portion numeric(10,2) DEFAULT 0,
  menu_price numeric(10,2) DEFAULT 0,
  allergens text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid REFERENCES recipes(id) ON DELETE CASCADE,
  name text NOT NULL,
  qty numeric(10,3) DEFAULT 0,
  unit text
);

CREATE TABLE IF NOT EXISTS recipe_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid REFERENCES recipes(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  text text NOT NULL,
  timer_seconds integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recipe_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid REFERENCES recipes(id) ON DELETE CASCADE,
  version_num integer DEFAULT 1,
  note text,
  date date DEFAULT CURRENT_DATE,
  is_current boolean DEFAULT false
);

-- Menu items
CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  recipe_id uuid REFERENCES recipes(id),
  name text NOT NULL,
  section text,
  price numeric(10,2) DEFAULT 0,
  cost numeric(10,2) DEFAULT 0,
  is_off boolean DEFAULT false,
  is_special boolean DEFAULT false,
  sort_order integer DEFAULT 0
);

-- Providers
CREATE TABLE IF NOT EXISTS providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  icon text,
  category text,
  delivery_note text,
  current_offer text
);

CREATE TABLE IF NOT EXISTS provider_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid REFERENCES providers(id) ON DELETE CASCADE,
  name text NOT NULL,
  price numeric(10,2) DEFAULT 0,
  unit text
);

-- Staff and Shifts
CREATE TABLE IF NOT EXISTS staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  role text,
  color text
);

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid REFERENCES staff(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  date date DEFAULT CURRENT_DATE,
  zone text,
  start_time time,
  end_time time,
  clock_in timestamptz,
  clock_out timestamptz
);

CREATE TABLE IF NOT EXISTS shift_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week integer CHECK (day_of_week BETWEEN 0 AND 6),
  zone text,
  start_time time,
  end_time time
);

-- Tasks and MEP
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  area text NOT NULL,
  zone text NOT NULL,
  phase text CHECK (phase IN ('opening','closing')) NOT NULL,
  name text NOT NULL,
  sub text,
  sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mep_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  zone text NOT NULL,
  dish text NOT NULL,
  sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mep_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mep_item_id uuid REFERENCES mep_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  method text,
  per_cover numeric(10,3) DEFAULT 0,
  unit text
);

-- EOD Reports and Urgent Tasks
CREATE TABLE IF NOT EXISTS eod_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  date date DEFAULT CURRENT_DATE,
  covers integer DEFAULT 0,
  revenue numeric(10,2) DEFAULT 0,
  food_cost numeric(10,2) DEFAULT 0,
  eighty_six text,
  waste text,
  notes text,
  stock_alerts text,
  tomorrow_priorities text,
  submitted_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS urgent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  zone text,
  name text NOT NULL,
  created_at timestamptz DEFAULT now(),
  created_by text,
  resolved_at timestamptz
);

-- Enable RLS
ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE mep_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE mep_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE eod_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE urgent_tasks ENABLE ROW LEVEL SECURITY;

-- Open RLS policies for now
CREATE POLICY "anon_all" ON restaurants FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON events FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON event_menu_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON recipes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON recipe_ingredients FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON recipe_steps FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON recipe_versions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON menu_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON providers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON provider_products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON staff FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON shifts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON shift_schedule FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON tasks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON mep_items FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON mep_components FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON eod_reports FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "anon_all" ON urgent_tasks FOR ALL USING (true) WITH CHECK (true);
